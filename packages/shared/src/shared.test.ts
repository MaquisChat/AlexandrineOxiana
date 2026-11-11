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
    for (const bad of ["", "  ", "a;b", "a{b", "a}b", "<x>", "a\\b", "a\nb", "a\u0000b", "a\u007fb", "x".repeat(301)]) expect(isUsableFontFamily(bad), JSON.stringify(bad)).toBe(false);
  });
});
