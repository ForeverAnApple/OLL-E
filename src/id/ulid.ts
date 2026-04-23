// ULID: 48-bit time + 80-bit randomness, Crockford base32 (26 chars).
// Lex-sortable, collision-safe without coordination — chosen for federation.
// Ref: https://github.com/ulid/spec

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = new Array<number>(RANDOM_LEN).fill(0);

function encodeTime(time: number): string {
  if (!Number.isFinite(time) || time < 0) {
    throw new Error(`ulid: invalid time ${time}`);
  }
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = time % ENCODING_LEN;
    out = ENCODING[mod] + out;
    time = (time - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(bytes: number[]): string {
  let out = "";
  for (const b of bytes) out += ENCODING[b % ENCODING_LEN];
  return out;
}

function incrementRandom(buf: number[]): void {
  // Monotonic-within-millisecond increment to preserve lex order.
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    const v = buf[i]!;
    if (v < ENCODING_LEN - 1) {
      buf[i] = v + 1;
      return;
    }
    buf[i] = 0;
  }
  throw new Error("ulid: random overflow within millisecond");
}

function newRandom(): number[] {
  const bytes = new Array<number>(RANDOM_LEN);
  const rnd = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(rnd);
  for (let i = 0; i < RANDOM_LEN; i++) bytes[i] = rnd[i]! % ENCODING_LEN;
  return bytes;
}

export function ulid(now: number = Date.now()): string {
  let random: number[];
  if (now === lastTime) {
    random = [...lastRandom];
    incrementRandom(random);
  } else {
    random = newRandom();
  }
  lastTime = now;
  lastRandom = random;
  return encodeTime(now) + encodeRandom(random);
}

export function timestampOf(id: string): number {
  if (id.length !== TIME_LEN + RANDOM_LEN) {
    throw new Error(`ulid: invalid length ${id.length}`);
  }
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const idx = ENCODING.indexOf(id[i]!);
    if (idx < 0) throw new Error(`ulid: invalid character at ${i}`);
    time = time * ENCODING_LEN + idx;
  }
  return time;
}

export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
