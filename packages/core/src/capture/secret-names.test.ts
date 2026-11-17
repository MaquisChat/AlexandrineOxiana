import { describe, expect, it } from "vitest";
import { KEY_PREFIXES, SECRET_WORDS, nameWords, secretName } from "./secret-names.js";

describe("secretName: the one word rule for names that carry a secret (R379; R41 I4)", () => {
  it("splits a name into words on _ - . : spaces and camelCase", () => {
    expect(nameWords("X-Amz-Security-Token")).toEqual(["x", "amz", "security", "token"]);
    expect(nameWords("AWSAccessKeyId")).toEqual(["aws", "access", "key", "id"]);
    expect(nameWords("data:csrfToken")).toEqual(["data", "csrf", "token"]);
  });

  it.each([
    "access_token", "sessionid", "PHPSESSID", "jsessionid", "JSESSIONID", "Signature", "X-Amz-Signature", "X-Amz-Credential", "X-Amz-Security-Token",
    "sig", "token", "auth", "apikey", "api_key", "apiKey", "password", "passwd", "client_secret", "csrf-token", "authenticity_token", "otp", "AWSAccessKeyId",
  ])("%s is secret", (name) => {
    expect(secretName(name)).toBe(true);
  });

  it.each(["id", "page", "lang", "v", "list", "key", "code", "extractor_key", "q", "sort", "monkey", "tokenizer"])("%s is not", (name) => {
    expect(secretName(name)).toBe(false);
  });

  it("the lists are what they say", () => {
    expect([...KEY_PREFIXES].sort()).toEqual(["access", "api", "private", "secret"]);
    expect(SECRET_WORDS.has("phpsessid") && SECRET_WORDS.has("jsessionid")).toBe(true);
  });
});
