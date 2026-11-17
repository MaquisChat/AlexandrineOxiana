/**
 * The one rule for names that carry a secret (R41 I4, R379, R391): a query or path parameter, an
 * attribute, a form field or a JSON key. A name is compared without regard to case, split into words
 * at every character that is not a letter or digit and at camel-case boundaries, and also looked at
 * run together (every run of up to four consecutive words, joined: `access_token`, `accessToken` and
 * `accesstoken` are the same name; `tOkEn` is `token`).
 *
 * Two classes (R391 a):
 *  - ALWAYS a secret, whatever the value: SECRET_WORDS, the token compounds (TOKEN_PREFIXES + `token`),
 *    the key compounds (KEY_PREFIXES + `key`), `client` + `secret`, the signed-link names of the large
 *    storage services (SIGNED_LINK_NAMES), and a run-together name that ends in one of ALWAYS_SUFFIXES
 *    or in a compound (`useraccesstoken`, `adminpassword`).
 *  - ORDINARY words (ORDINARY_WORDS, and a run-together name ending in `token`/`tokens` such as
 *    `usertoken`): a secret only when the VALUE looks like a key (`keyLikeValue`, the project's
 *    `sessionLike` rule). `?session=12` and `?code=CS101` stay; `?sid=<32 hex digits>` goes. When no
 *    value is given (an attribute or JSON key judged by its name alone) an ordinary word counts as a
 *    secret: unknown is treated as secret.
 * And any value with the shape of a signed token (`signedTokenValue`) is a secret whatever its name.
 *
 * Used by the stored address (capture/platforms.ts). The HTML snapshot cleaner
 * (packages/library/src/capture/html-strip.mjs) runs as plain JavaScript in a worker thread, where
 * this TypeScript cannot be loaded, and so keeps its own copy; a library test runs both copies over
 * one table of names and values.
 */

import { keyLikeValue, signedTokenValue } from "./key-shape.js";

/** Names that are a secret whatever their value. */
export const SECRET_WORDS: ReadonlySet<string> = new Set([
  "csrf", "xsrf", "authorization", "authentication", "authenticity", "bearer", "sessionid", "phpsessid", "jsessionid",
  "password", "passwd", "secret", "nonce", "otp", "jwt", "credential", "credentials", "passcode",
  "apikey", "accesskey", "privatekey", "secretkey", "authkey", "clientsecret", "cookie", "cookies",
]);

/** Words that name a secret when directly followed by `key` (`api_key`, `AccessKeyId`, `authkey`). */
export const KEY_PREFIXES: ReadonlySet<string> = new Set(["api", "auth", "access", "private", "secret"]);

/** Words that name a secret when directly followed by `token` (`access_token`, `idToken`, `sessiontoken`). */
export const TOKEN_PREFIXES: ReadonlySet<string> = new Set(["access", "auth", "id", "refresh", "session", "csrf", "xsrf", "bearer"]);

/** The signed-link parameters of the large storage services, run together (`X-Amz-Signature`, `Key-Pair-Id`). */
export const SIGNED_LINK_NAMES: ReadonlySet<string> = new Set(["xamzsignature", "xamzcredential", "xamzsecuritytoken", "keypairid"]);

/** Words that are also ordinary words: a secret only when the value looks like a key. */
export const ORDINARY_WORDS: ReadonlySet<string> = new Set([
  "token", "tokens", "auth", "session", "sid", "signature", "sig", "pwd", "pass", "key", "code", "hash", "ticket",
  // Named by the review of R391 (I1): the short forms of a session id, ColdFusion's client id and OAuth's verifier.
  "sess", "sessid", "cfid", "verifier",
]);

/** A run-together name ending in one of these is a secret whatever its value (`adminpassword`, `clientsecret`). */
const ALWAYS_SUFFIXES: readonly string[] = [
  "secret", "password", "passwd", "sessionid", "passcode", "credential", "credentials",
  ...[...TOKEN_PREFIXES].flatMap((p) => [`${p}token`, `${p}tokens`]),
  ...[...KEY_PREFIXES].map((p) => `${p}key`),
];

/** The longest run of consecutive words looked at together. */
const RUN = 4;

/** The words of a name: split at camelCase and at every character that is not a letter or digit, lower-cased. */
export function nameWords(name: string): string[] {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

type NameClass = "always" | "ordinary" | "none";

function classOfRun(run: string): NameClass {
  if (SECRET_WORDS.has(run) || SIGNED_LINK_NAMES.has(run) || ALWAYS_SUFFIXES.some((s) => run.endsWith(s))) return "always";
  if (ORDINARY_WORDS.has(run) || /tokens?$/u.test(run)) return "ordinary";
  return "none";
}

/** The class of a name: the strongest class of any of its words, or runs of words joined. */
export function nameClass(name: string): NameClass {
  const ws = nameWords(name);
  let out: NameClass = "none";
  const runs: string[] = [];
  for (let i = 0; i < ws.length; i++) for (let j = i + 1; j <= Math.min(ws.length, i + RUN); j++) runs.push(ws.slice(i, j).join(""));
  if (ws.length > RUN) runs.push(ws.join(""));
  for (const r of runs) {
    const c = classOfRun(r);
    if (c === "always") return "always";
    if (c === "ordinary") out = "ordinary";
  }
  return out;
}

/**
 * True when the parameter `name` (with its decoded `value`, when there is one) carries a secret by
 * the rule above.
 */
export function secretName(name: string, value?: string): boolean {
  if (value !== undefined && signedTokenValue(value)) return true;
  const c = nameClass(name);
  if (c === "always") return true;
  if (c === "ordinary") return value === undefined || keyLikeValue(value);
  return false;
}
