// Bearer invite code: base64url(JSON{ proto, teamId, inviteId, addr, secret }).
// See docs/plan/teams.plan.md line 51.
//
// Holding the code = holding the team secret. Single-use is enforced
// inviter-side on the inviteId, not on the bytes — anyone who scrapes
// the code can still verify envelopes. Rotation is deferred to v0.1
// (plan line 54); leak = rotate the whole team secret.

import { createHash } from "node:crypto";
import { MESH_PROTO } from "./envelope.ts";

export interface BearerCode {
  proto: typeof MESH_PROTO;
  teamId: string;
  inviteId: string;
  addr: string;
  secret: string;
}

export class BearerCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BearerCodeError";
  }
}

export function encodeBearerCode(code: BearerCode): string {
  const json = JSON.stringify(code);
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeBearerCode(raw: string): BearerCode {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new BearerCodeError("decode: empty code");
  }
  // Node's base64url decoder silently skips characters outside the
  // alphabet, so we gate on a regex first and round-trip to catch any
  // residual corruption.
  if (!/^[A-Za-z0-9_-]+=*$/.test(raw)) {
    throw new BearerCodeError("decode: non-canonical base64url");
  }
  let json: string;
  try {
    const buf = Buffer.from(raw, "base64url");
    json = buf.toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== raw.replace(/=+$/, "")) {
      throw new BearerCodeError("decode: non-canonical base64url");
    }
  } catch (err) {
    if (err instanceof BearerCodeError) throw err;
    throw new BearerCodeError(`decode: bad base64url (${(err as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new BearerCodeError(`decode: invalid JSON (${(err as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BearerCodeError("decode: code must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.proto !== MESH_PROTO) {
    throw new BearerCodeError(`decode: bad proto ${String(obj.proto)}`);
  }
  for (const field of ["teamId", "inviteId", "addr", "secret"] as const) {
    if (typeof obj[field] !== "string" || (obj[field] as string).length === 0) {
      throw new BearerCodeError(`decode: missing/invalid field ${field}`);
    }
  }
  return {
    proto: MESH_PROTO,
    teamId: obj.teamId as string,
    inviteId: obj.inviteId as string,
    addr: obj.addr as string,
    secret: obj.secret as string,
  };
}

/** SHA-256 hex of the raw code. Stored in `team_invites.code_hash` so
 *  the secret bytes never sit in SQLite. */
export function hashBearerCode(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}
