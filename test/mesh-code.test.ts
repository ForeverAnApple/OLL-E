import { describe, expect, it } from "bun:test";
import {
  BearerCodeError,
  decodeBearerCode,
  encodeBearerCode,
  hashBearerCode,
  type BearerCode,
} from "../src/mesh/code.ts";

function sampleCode(): BearerCode {
  return {
    proto: "olle.v0",
    teamId: "team-1",
    inviteId: "inv-1",
    addr: "ws://192.168.1.10:7777",
    secret: "raw-team-secret-not-real",
  };
}

describe("encodeBearerCode / decodeBearerCode", () => {
  it("round-trips and preserves all fields", () => {
    const code = sampleCode();
    const wire = encodeBearerCode(code);
    const back = decodeBearerCode(wire);
    expect(back).toEqual(code);
  });

  it("emits URL-safe base64 (no padding, no +/)", () => {
    const wire = encodeBearerCode(sampleCode());
    expect(wire).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("throws on empty input", () => {
    expect(() => decodeBearerCode("")).toThrow(BearerCodeError);
  });

  it("throws on malformed base64url", () => {
    expect(() => decodeBearerCode("!!!not base64!!!")).toThrow(BearerCodeError);
  });

  it("throws on bad JSON", () => {
    const wire = Buffer.from("not json {", "utf8").toString("base64url");
    expect(() => decodeBearerCode(wire)).toThrow(BearerCodeError);
  });

  it("throws on bad proto", () => {
    const wire = Buffer.from(
      JSON.stringify({ ...sampleCode(), proto: "olle.v1" }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeBearerCode(wire)).toThrow(BearerCodeError);
  });

  it("throws on missing fields", () => {
    const partial = { proto: "olle.v0", teamId: "t", inviteId: "i", addr: "ws://x" };
    const wire = Buffer.from(JSON.stringify(partial), "utf8").toString("base64url");
    expect(() => decodeBearerCode(wire)).toThrow(BearerCodeError);
  });

  it("throws on non-string field types", () => {
    const bad = { ...sampleCode(), teamId: 123 } as unknown;
    const wire = Buffer.from(JSON.stringify(bad), "utf8").toString("base64url");
    expect(() => decodeBearerCode(wire)).toThrow(BearerCodeError);
  });

  it("throws on non-object JSON", () => {
    const wire = Buffer.from(JSON.stringify(["array"]), "utf8").toString("base64url");
    expect(() => decodeBearerCode(wire)).toThrow(BearerCodeError);
  });
});

describe("hashBearerCode", () => {
  it("is deterministic", () => {
    const wire = encodeBearerCode(sampleCode());
    expect(hashBearerCode(wire)).toBe(hashBearerCode(wire));
  });

  it("differs across distinct inputs", () => {
    const a = hashBearerCode(encodeBearerCode(sampleCode()));
    const b = hashBearerCode(encodeBearerCode({ ...sampleCode(), inviteId: "inv-2" }));
    expect(a).not.toBe(b);
  });

  it("produces 64-char hex", () => {
    expect(hashBearerCode("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});
