import { describe, expect, it } from "bun:test";
import {
  ULID_REGEX,
  compareStamp,
  createClock,
  decodeStamp,
  encodeStamp,
  timestampOf,
  ulid,
} from "../src/id/index.ts";

describe("ulid", () => {
  it("produces 26-char Crockford base32", () => {
    const id = ulid();
    expect(id).toMatch(ULID_REGEX);
    expect(id.length).toBe(26);
  });

  it("embeds the supplied timestamp", () => {
    const t = 1_700_000_000_000;
    expect(timestampOf(ulid(t))).toBe(t);
  });

  it("is monotonic within the same millisecond", () => {
    const t = 1_700_000_000_000;
    const ids = Array.from({ length: 128 }, () => ulid(t));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is globally sortable by time across ms", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a < b).toBe(true);
  });
});

describe("hlc", () => {
  it("increments counter within same ms, resets on advance", () => {
    let t = 1000;
    const clock = createClock(() => t);
    expect(clock.now()).toEqual({ l: 1000, c: 0 });
    expect(clock.now()).toEqual({ l: 1000, c: 1 });
    t = 1005;
    expect(clock.now()).toEqual({ l: 1005, c: 0 });
  });

  it("recv advances when remote is ahead", () => {
    let t = 500;
    const clock = createClock(() => t);
    clock.now(); // l=500, c=0
    const s = clock.recv({ l: 800, c: 3 });
    expect(s).toEqual({ l: 800, c: 4 });
  });

  it("recv respects local when local and pt are ahead", () => {
    let t = 2000;
    const clock = createClock(() => t);
    clock.now(); // l=2000, c=0
    const s = clock.recv({ l: 100, c: 0 });
    expect(s.l).toBe(2000);
    expect(s.c).toBeGreaterThan(0);
  });

  it("encode/decode roundtrips", () => {
    const s = { l: 1_700_000_000_000, c: 42 };
    const enc = encodeStamp(s);
    expect(enc).toMatch(/^[0-9a-f]{12}-[0-9a-f]{4}$/);
    expect(decodeStamp(enc)).toEqual(s);
  });

  it("compareStamp preserves HLC order", () => {
    expect(compareStamp({ l: 1, c: 0 }, { l: 1, c: 1 })).toBeLessThan(0);
    expect(compareStamp({ l: 2, c: 0 }, { l: 1, c: 99 })).toBeGreaterThan(0);
    expect(compareStamp({ l: 5, c: 5 }, { l: 5, c: 5 })).toBe(0);
  });
});
