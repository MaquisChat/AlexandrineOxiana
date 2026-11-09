import { UUID, uuidv7 } from "uuidv7";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Crockford base32: no i, l, o, u.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

// Random bits in a UUIDv7: rand_b (62 bits, bits 0..61) and rand_a (12 bits, bits 64..75).
const RAND_BITS = 74;
const LOW_BITS = 20; // the 4-char short id covers the last 20 random bits
const MAX_SHORT_LENGTH = 4 + Math.ceil((RAND_BITS - LOW_BITS) / 5);

/** Creates a new UUIDv7 string (lowercase, 8-4-4-4-12). */
export function newId(): string {
  return uuidv7();
}

/** True if `s` is a canonical lowercase UUIDv7 string. */
export function isId(s: string): boolean {
  return ID_PATTERN.test(s);
}

/** Extracts the 74 random bits of a UUIDv7 as an integer. */
function randomBits(id: string): bigint {
  const bytes = UUID.parse(id).bytes;
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  const randB = v & ((1n << 62n) - 1n); // bits 0..61
  const randA = (v >> 64n) & 0xfffn; // bits 64..75
  return (randA << 62n) | randB;
}

function encodeBase32(value: number, chars: number): string {
  let out = "";
  for (let i = chars - 1; i >= 0; i--) {
    out += ALPHABET[(value >> (5 * i)) & 31];
  }
  return out;
}

/**
 * Short, human-friendly form of an id, unique within `taken`.
 *
 * The first 4 characters encode the last 20 random bits of the id. If that
 * prefix is in `taken`, the result grows to 5, 6, ... characters, each extra
 * character taken from the next higher random bits, so every longer form still
 * starts with the 4-char value.
 */
export function shortId(id: string, taken: ReadonlySet<string>): string {
  const bits = randomBits(id);
  const low = Number(bits & ((1n << BigInt(LOW_BITS)) - 1n));
  let result = encodeBase32(low, 4);
  let extra = 0;
  while (taken.has(result)) {
    if (4 + extra >= MAX_SHORT_LENGTH) {
      throw new RangeError(`shortId: no unused short form for ${id}`);
    }
    const chunk = Number((bits >> BigInt(LOW_BITS + 5 * extra)) & 31n);
    result += ALPHABET[chunk];
    extra++;
  }
  return result;
}
