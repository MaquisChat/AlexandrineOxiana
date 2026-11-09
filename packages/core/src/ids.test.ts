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
