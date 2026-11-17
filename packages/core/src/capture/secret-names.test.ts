import { describe, expect, it } from "vitest";
import { ASPNET_KEY, HEX_KEY, MIXED_KEY, keyLikeValue, sessionLike, signedTokenValue } from "./key-shape.js";
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

  it.each(["id", "page", "lang", "v", "list", "q", "sort", "monkey", "tokenizer", "keywords", "zipcode"])("%s is not", (name) => {
    expect(secretName(name)).toBe(false);
  });

  // R391 a: a bare `key` and `code` (and `extractor_key`) are judged by their value; judged by the name alone, unknown is secret.
  it.each(["key", "code", "extractor_key"])("%s is secret only when its value looks like a key", (name) => {
    expect(secretName(name)).toBe(true);
    expect(secretName(name, "youtube")).toBe(false);
    expect(secretName(name, "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY")).toBe(true);
  });

  it("the lists are what they say", () => {
    expect([...KEY_PREFIXES].sort()).toEqual(["access", "api", "auth", "private", "secret"]);
    expect(SECRET_WORDS.has("phpsessid") && SECRET_WORDS.has("jsessionid")).toBe(true);
  });
});

describe("what looks like a key (R391 a: the project's sessionLike rule, moved from find/where.ts)", () => {
  const YES = [
    "0123456789abcdef", "5f2b8c9e0a1d4e7f9b3c6a8d2e1f0b7c", "DEADBEEFDEADBEEF", "1234567890123456", "aB3dE5fG7hJ9kL1mN3pQ",
    "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY", "4/0AX4XfWhAbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "(S(lit3py55t21z5v55vlm25s55))",
    "(A(Bx12)S(abc))", "Nql641NHEUkUaXQHZINK1FZ~SYeUSoBJMxjdgqrzIdzV2gyEXPDNv0pYdWJkfl",
  ];
  const NO = [
    "", "12", "2023-24", "verb", "MS-123", "CS101", "value", "ZOOMPWD1", "zzzzzzzzzzzzzzzzzzzzzzzzzzzz", "Conference-Session-Number-Twelve",
    "123456789012345", "abcdefABCDEF-ghijkl_mnop",
  ];
  it.each(YES)("%s looks like a key", (v) => expect(keyLikeValue(v)).toBe(true));
  it.each(NO)("%j does not", (v) => expect(keyLikeValue(v)).toBe(false));

  it("sessionLike keeps its three patterns (one piece, no splitting)", () => {
    expect([HEX_KEY, MIXED_KEY, ASPNET_KEY].every((r) => r instanceof RegExp)).toBe(true);
    expect(sessionLike("5f2b8c9e0a1d4e7f")).toBe(true);
    expect(sessionLike("4/0AX4XfWhAbCdEfGhIjKlMnOpQrStUvWxYz0123456789")).toBe(false);
  });

  it("a signed token: three base64url runs joined by dots, the first beginning eyJ", () => {
    expect(signedTokenValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl")).toBe(true);
    expect(signedTokenValue("eyJ.x")).toBe(false);
    expect(signedTokenValue("abc.def.ghi")).toBe(false);
    expect(secretName("state", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl")).toBe(true);
  });
});

describe("a UUID and a long lower-case id also look like a key (R415 b, review 2 M1)", () => {
  const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const B32 = "mfrggzdfmztwq2lknnwg23tpobyxe43u"; // 32 lower-case base32 characters
  it.each([UUID, UUID.toUpperCase(), `x_${UUID}`, `a.${UUID}.b`, B32, "abcdefghijkl0123456789ab", `id-${B32}`])("%s looks like a key", (v) =>
    expect(keyLikeValue(v)).toBe(true),
  );
  it.each(["123456", "12", "value", "verb", "abcdefghijklmnopqrstuvwxyzab", "123456789012345678901234".slice(0, 15), "abcdefghijk0123456789ab"])(
    "%j does not",
    (v) => expect(keyLikeValue(v)).toBe(false),
  );
  it("by name: a session id as a UUID and a base32 session id go; short codes, words and an `id` stay", () => {
    expect(secretName("sid", UUID)).toBe(true);
    expect(secretName("session", B32)).toBe(true);
    expect(secretName("code", "123456")).toBe(false);
    expect(secretName("session", "12")).toBe(false);
    expect(secretName("key", "value")).toBe(false);
    expect(secretName("token", "verb")).toBe(false);
    expect(secretName("id", UUID)).toBe(false);
  });
});
