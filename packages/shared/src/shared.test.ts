import { describe, expect, it } from "vitest";
import { CREDENTIAL_QUERY_KEYS, isCredentialQueryKey, isUsableFontFamily } from "./index.js";

describe("@ao/shared", () => {
  it("credential query keys (R96/R98), any case", () => {
    expect([...CREDENTIAL_QUERY_KEYS].sort()).toEqual(["access_token", "api_key", "apikey", "auth", "authorization", "bearer", "code", "key", "passphrase", "password", "secret", "token"]);
    expect(isCredentialQueryKey("Access_Token")).toBe(true);
    expect(isCredentialQueryKey("text")).toBe(false);
  });

  it("font family names: no rule-breaking or control characters", () => {
    expect(isUsableFontFamily("'Goudy Old Style', serif")).toBe(true);
    // R108: C1 controls, bidi controls, zero-width characters and line/paragraph separators too.
    for (const cp of [0x80, 0x9f, 0x202a, 0x202e, 0x2066, 0x2069, 0x200b, 0x200d, 0x200e, 0x200f, 0xfeff, 0x2028, 0x2029]) {
      expect(isUsableFontFamily(`Font${String.fromCodePoint(cp)}Name`), cp.toString(16)).toBe(false);
    }
    expect(isUsableFontFamily("Noto Sans العربية")).toBe(true);
    for (const bad of ["", "  ", "a;b", "a{b", "a}b", "<x>", "a\\b", "a\nb", "a\u0000b", "a\u007fb", "x".repeat(301)]) expect(isUsableFontFamily(bad), JSON.stringify(bad)).toBe(false);
  });
});
