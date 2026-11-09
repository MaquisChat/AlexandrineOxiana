import { describe, expect, it } from "vitest";
import { isId, newId, shortId } from "./ids.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
  it("returns a UUIDv7 string", () => {
    expect(newId()).toMatch(UUID_V7);
  });

  it("sorts lexicographically in creation order", async () => {
    const first = newId();
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = newId();
    expect(first < second).toBe(true);
  });

  it("is accepted by isId", () => {
    expect(isId(newId())).toBe(true);
  });
});

describe("isId", () => {
  it("rejects non-UUIDv7 strings", () => {
    expect(isId("not-an-id")).toBe(false);
    expect(isId("")).toBe(false);
    // UUIDv4 (version nibble 4) is not accepted.
    expect(isId("123e4567-e89b-42d3-a456-426614174000")).toBe(false);
  });
});

describe("shortId", () => {
  const id = newId();

  it("is 4 characters from the Crockford alphabet when nothing is taken", () => {
    const s = shortId(id, new Set());
    expect(s).toHaveLength(4);
    expect(s).toMatch(/^[0-9a-hjkmnp-tv-z]{4}$/);
  });

  it("extends to 5 characters when the 4-char form is taken, keeping it as prefix", () => {
    const four = shortId(id, new Set());
    const five = shortId(id, new Set([four]));
    expect(five).toHaveLength(5);
    expect(five.startsWith(four)).toBe(true);
    expect(five).toMatch(/^[0-9a-hjkmnp-tv-z]{5}$/);
  });

  it("is deterministic for the same input", () => {
    expect(shortId(id, new Set())).toBe(shortId(id, new Set()));
  });
});

// Fixed vector. Hand computation (not derived from the implementation):
//   id bytes: 01 89 dc d5 53 11 7d 40 8d b0 94 96 a2 ee f3 7b
//   last 20 random bits = 0xeef37b & 0xfffff = 0xef37b = 979835 decimal
//   binary 1110 1111 0011 0111 1011 -> 5-bit groups 29, 28, 27, 27
//   alphabet index 29='x', 28='w', 27='v', 27='v'                  -> "xwvv"
//   next 5 bits (bits 20..24) = 0b01110 = 14 = 'e'                 -> "xwvve"
//   next 5 bits (bits 25..29) = 17 = 'h'                           -> "xwvveh"
const VECTOR_ID = "0189dcd5-5311-7d40-8db0-9496a2eef37b";

describe("shortId fixed vectors", () => {
  it("4-char form comes from the last 20 random bits", () => {
    expect(shortId(VECTOR_ID, new Set())).toBe("xwvv");
  });

  it("5-char extension appends the next 5 bits", () => {
    expect(shortId(VECTOR_ID, new Set(["xwvv"]))).toBe("xwvve");
  });

  it("6-char extension when 4- and 5-char forms are both taken", () => {
    expect(shortId(VECTOR_ID, new Set(["xwvv", "xwvve"]))).toBe("xwvveh");
  });
});

describe("shortId exhaustion", () => {
  it("throws RangeError when every form up to the max length (15) is taken", () => {
    // Fill the taken set with the form the function itself produces each time,
    // so the set holds one form of each length 4..15 (12 forms).
    const taken = new Set<string>();
    for (let i = 0; i < 12; i++) {
      taken.add(shortId(VECTOR_ID, taken));
    }
    expect([...taken].map((s) => s.length).sort((a, b) => a - b)).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(() => shortId(VECTOR_ID, taken)).toThrow(RangeError);
  });
});

describe("shortId input validation", () => {
  it("throws TypeError for a string that is not a UUIDv7", () => {
    expect(() => shortId("not-an-id", new Set())).toThrow(TypeError);
    expect(() => shortId("123e4567-e89b-42d3-a456-426614174000", new Set())).toThrow(TypeError);
  });
});
