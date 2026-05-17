// Mesh wire envelope — sign-then-encode, HMAC-SHA256 keyed on the team
// shared secret. v0 trust model is "friend you handed the code to": LAN
// `ws://`, no TLS, no per-peer keys (LOG 2026-05-13; see
// docs/plan/teams.plan.md "Wire", lines 24-43). Anyone with the team
// secret can mint and verify envelopes; leak = rotate (v0.1).
//
// Canonical JSON is deterministic across implementations so the HMAC is
// stable regardless of key ordering or whitespace in transit.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Event } from "../bus/types.ts";

export const MESH_PROTO = "olle.v0" as const;

const PAYLOAD_KINDS = [
  "hello",
  "welcome",
  "heartbeat",
  "catchup_request",
  "catchup_chunk",
  "peer_left",
  "error",
] as const;

export type MeshPayloadKind = (typeof PAYLOAD_KINDS)[number];
export type MeshEnvelopeKind = "event" | MeshPayloadKind;

const PAYLOAD_KIND_SET: ReadonlySet<string> = new Set(PAYLOAD_KINDS);
const ENVELOPE_KIND_SET: ReadonlySet<string> = new Set<string>(["event", ...PAYLOAD_KINDS]);

interface BaseEnvelope {
  proto: typeof MESH_PROTO;
  envelopeId: string;
  teamId: string;
  fromHostId: string;
  sentAt: number;
  hmac: string;
}

export type MeshEnvelope =
  | (BaseEnvelope & { kind: "event"; event: Event })
  | (BaseEnvelope & { kind: MeshPayloadKind; payload: Record<string, unknown> });

/** Distributive Omit so each branch of MeshEnvelope keeps its
 *  branch-specific fields (`event` / `payload`). Plain `Omit<T,K>`
 *  collapses a union to its shared keys. */
export type UnsignedEnvelope = MeshEnvelope extends infer E
  ? E extends MeshEnvelope
    ? Omit<E, "hmac">
    : never
  : never;

export class MeshEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshEnvelopeError";
  }
}

/** Deterministic JSON: sorted object keys, no whitespace, finite numbers
 *  only, undefined rejected. Two equal-content objects always serialize
 *  to the same string. */
export function canonicalize(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) {
    throw new MeshEnvelopeError("canonicalize: undefined is not JSON-representable");
  }
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new MeshEnvelopeError(`canonicalize: non-finite number ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (t === "string" || t === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stringify(v)).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue; // mirror JSON.stringify: skip undefined props
      parts.push(JSON.stringify(k) + ":" + stringify(v));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new MeshEnvelopeError(`canonicalize: unsupported type ${t}`);
}

/** Hex HMAC-SHA256 over the canonicalized envelope (hmac field omitted). */
export function signEnvelope(envelope: UnsignedEnvelope, secret: string): string {
  const body = canonicalize(envelope);
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Constant-time verify. Length-mismatch fast-fail before timingSafeEqual
 *  so we never throw on tampered hex of unexpected length. */
export function verifyEnvelope(envelope: MeshEnvelope, secret: string): boolean {
  if (envelope.proto !== MESH_PROTO) return false;
  const { hmac, ...rest } = envelope;
  if (typeof hmac !== "string") return false;
  const expected = signEnvelope(rest as UnsignedEnvelope, secret);
  if (hmac.length !== expected.length) return false;
  const a = Buffer.from(hmac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function encodeEnvelope(envelope: MeshEnvelope): string {
  return canonicalize(envelope);
}

/** JSON.parse + shape check. Throws MeshEnvelopeError on anything wrong
 *  with the wire form so callers have one catch surface. */
export function decodeEnvelope(raw: string): MeshEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MeshEnvelopeError(`decode: invalid JSON (${(err as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MeshEnvelopeError("decode: envelope must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.proto !== MESH_PROTO) {
    throw new MeshEnvelopeError(`decode: bad proto ${String(obj.proto)}`);
  }
  for (const field of ["envelopeId", "teamId", "fromHostId", "hmac"] as const) {
    if (typeof obj[field] !== "string") {
      throw new MeshEnvelopeError(`decode: missing/invalid field ${field}`);
    }
  }
  if (typeof obj.sentAt !== "number" || !Number.isFinite(obj.sentAt)) {
    throw new MeshEnvelopeError("decode: missing/invalid field sentAt");
  }
  const kind = obj.kind;
  if (typeof kind !== "string" || !ENVELOPE_KIND_SET.has(kind)) {
    throw new MeshEnvelopeError(`decode: bad kind ${String(kind)}`);
  }
  if (kind === "event") {
    if (!obj.event || typeof obj.event !== "object") {
      throw new MeshEnvelopeError("decode: event kind missing event field");
    }
  } else {
    if (!obj.payload || typeof obj.payload !== "object" || Array.isArray(obj.payload)) {
      throw new MeshEnvelopeError(`decode: ${kind} kind missing payload object`);
    }
  }
  return obj as unknown as MeshEnvelope;
}

export function isPayloadKind(kind: string): kind is MeshPayloadKind {
  return PAYLOAD_KIND_SET.has(kind);
}
