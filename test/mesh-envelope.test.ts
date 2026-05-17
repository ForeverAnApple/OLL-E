import { describe, expect, it } from "bun:test";
import {
  canonicalize,
  decodeEnvelope,
  encodeEnvelope,
  MeshEnvelopeError,
  signEnvelope,
  verifyEnvelope,
  type MeshEnvelope,
  type UnsignedEnvelope,
} from "../src/mesh/envelope.ts";

const SECRET = "team-shared-secret-not-real";

function baseEvent(): { event: import("../src/bus/types.ts").Event } {
  return {
    event: {
      id: "01HZZZULIDXXXXXXXXXXXXXX01",
      hlc: "0000018f1234-0000",
      hostId: "host-a",
      actorId: "agent-1",
      type: "job.available",
      payload: { jobId: "JOB1", claimable: true },
      createdAt: 1_700_000_000_000,
      durable: true,
    },
  };
}

function eventEnvelope(): MeshEnvelope {
  const env: UnsignedEnvelope = {
    proto: "olle.v0",
    envelopeId: "01HZZZENV1",
    teamId: "team-1",
    fromHostId: "host-a",
    kind: "event",
    ...baseEvent(),
    sentAt: 1_700_000_000_000,
  };
  return { ...env, hmac: signEnvelope(env, SECRET) };
}

function helloEnvelope(): MeshEnvelope {
  const env: UnsignedEnvelope = {
    proto: "olle.v0",
    envelopeId: "01HZZZENV2",
    teamId: "team-1",
    fromHostId: "host-b",
    kind: "hello",
    payload: { teamId: "team-1" },
    sentAt: 1_700_000_000_001,
  };
  return { ...env, hmac: signEnvelope(env, SECRET) };
}

describe("canonicalize", () => {
  it("is order-insensitive over object keys", () => {
    const a = canonicalize({ b: 1, a: 2, c: { y: 1, x: 2 } });
    const b = canonicalize({ c: { x: 2, y: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":{"x":2,"y":1}}');
  });

  it("is idempotent on parse → canonicalize (whitespace-stable)", () => {
    const messy = '  { "b" : 1 ,\n  "a"  : [ 1,2,3 ] }  ';
    const first = canonicalize(JSON.parse(messy));
    const second = canonicalize(JSON.parse(first));
    expect(first).toBe(second);
    expect(first).toBe('{"a":[1,2,3],"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(MeshEnvelopeError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(MeshEnvelopeError);
  });

  it("rejects top-level undefined", () => {
    expect(() => canonicalize(undefined)).toThrow(MeshEnvelopeError);
  });

  it("skips undefined object properties (mirrors JSON.stringify)", () => {
    expect(canonicalize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });
});

describe("signEnvelope / verifyEnvelope", () => {
  it("round-trips for event envelopes", () => {
    const env = eventEnvelope();
    expect(verifyEnvelope(env, SECRET)).toBe(true);
  });

  it("round-trips for payload envelopes", () => {
    const env = helloEnvelope();
    expect(verifyEnvelope(env, SECRET)).toBe(true);
  });

  it("rejects tampered envelopes", () => {
    const env = eventEnvelope();
    const tampered: MeshEnvelope = { ...env, fromHostId: "host-evil" };
    expect(verifyEnvelope(tampered, SECRET)).toBe(false);
  });

  it("rejects with the wrong secret", () => {
    const env = eventEnvelope();
    expect(verifyEnvelope(env, "different-secret")).toBe(false);
  });

  it("rejects with the wrong proto", () => {
    const env = eventEnvelope();
    const bad = { ...env, proto: "olle.v1" } as unknown as MeshEnvelope;
    expect(verifyEnvelope(bad, SECRET)).toBe(false);
  });

  it("rejects when hmac length is wrong", () => {
    const env = eventEnvelope();
    const bad: MeshEnvelope = { ...env, hmac: "deadbeef" };
    expect(verifyEnvelope(bad, SECRET)).toBe(false);
  });
});

describe("encodeEnvelope / decodeEnvelope", () => {
  it("round-trips an event envelope", () => {
    const env = eventEnvelope();
    const wire = encodeEnvelope(env);
    const back = decodeEnvelope(wire);
    expect(verifyEnvelope(back, SECRET)).toBe(true);
    expect(back.kind).toBe("event");
  });

  it("accepts every payload kind", () => {
    const kinds = [
      "hello",
      "welcome",
      "heartbeat",
      "catchup_request",
      "catchup_chunk",
      "peer_left",
      "error",
    ] as const;
    for (const kind of kinds) {
      const env: UnsignedEnvelope = {
        proto: "olle.v0",
        envelopeId: `id-${kind}`,
        teamId: "team-1",
        fromHostId: "host-a",
        kind,
        payload: { k: kind },
        sentAt: 1,
      };
      const signed: MeshEnvelope = { ...env, hmac: signEnvelope(env, SECRET) };
      const wire = encodeEnvelope(signed);
      const back = decodeEnvelope(wire);
      expect(back.kind).toBe(kind);
      expect(verifyEnvelope(back, SECRET)).toBe(true);
    }
  });

  it("throws on bad JSON", () => {
    expect(() => decodeEnvelope("not json {")).toThrow(MeshEnvelopeError);
  });

  it("throws on bad proto", () => {
    const wire = JSON.stringify({
      proto: "olle.v1",
      envelopeId: "x",
      teamId: "x",
      fromHostId: "x",
      kind: "hello",
      payload: {},
      sentAt: 0,
      hmac: "00",
    });
    expect(() => decodeEnvelope(wire)).toThrow(MeshEnvelopeError);
  });

  it("throws on missing fields", () => {
    const wire = JSON.stringify({
      proto: "olle.v0",
      envelopeId: "x",
      kind: "hello",
      payload: {},
      sentAt: 0,
      hmac: "00",
    });
    expect(() => decodeEnvelope(wire)).toThrow(MeshEnvelopeError);
  });

  it("throws on unknown kind", () => {
    const wire = JSON.stringify({
      proto: "olle.v0",
      envelopeId: "x",
      teamId: "x",
      fromHostId: "x",
      kind: "nope",
      payload: {},
      sentAt: 0,
      hmac: "00",
    });
    expect(() => decodeEnvelope(wire)).toThrow(MeshEnvelopeError);
  });

  it("throws when an event-kind envelope has no event", () => {
    const wire = JSON.stringify({
      proto: "olle.v0",
      envelopeId: "x",
      teamId: "x",
      fromHostId: "x",
      kind: "event",
      sentAt: 0,
      hmac: "00",
    });
    expect(() => decodeEnvelope(wire)).toThrow(MeshEnvelopeError);
  });

  it("throws when a payload-kind envelope has no payload", () => {
    const wire = JSON.stringify({
      proto: "olle.v0",
      envelopeId: "x",
      teamId: "x",
      fromHostId: "x",
      kind: "hello",
      sentAt: 0,
      hmac: "00",
    });
    expect(() => decodeEnvelope(wire)).toThrow(MeshEnvelopeError);
  });
});
