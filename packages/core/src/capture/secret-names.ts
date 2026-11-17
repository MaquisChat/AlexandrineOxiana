/**
 * The one word rule for names that carry a secret (R41 I4, R379): a query parameter, an attribute, a
 * form field or a JSON key whose name has one of SECRET_WORDS as a word, or the word pair
 * api/access/private/secret + `key`. A bare `key` is not a secret name (`extractor_key`, a sheet's
 * `key`), nor is `code`.
 *
 * Used by the stored address (capture/platforms.ts). The HTML snapshot cleaner
 * (packages/library/src/capture/html-strip.mjs) runs as plain JavaScript in a worker thread and so
 * keeps its own copy of these lists; a library test keeps the two equal.
 */

export const SECRET_WORDS: ReadonlySet<string> = new Set([
  "csrf", "xsrf", "token", "tokens", "auth", "authorization", "authentication", "authenticity", "bearer",
  "session", "sessionid", "phpsessid", "jsessionid", "password", "passwd", "secret", "signature", "sig", "nonce", "otp", "jwt",
  "credential", "credentials", "apikey", "accesskey", "privatekey", "secretkey", "cookie", "cookies",
]);

/** Words that name a secret when directly followed by `key` (`api_key`, `AccessKeyId`). */
export const KEY_PREFIXES: ReadonlySet<string> = new Set(["api", "access", "private", "secret"]);

/** The words of a name: split on `_ - . :`, white space and camelCase, lower-cased. */
export function nameWords(name: string): string[] {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.:-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** True when `name` names a secret by the rule above. */
export function secretName(name: string): boolean {
  const ws = nameWords(name);
  return ws.some((w, i) => SECRET_WORDS.has(w) || (w === "key" && i > 0 && KEY_PREFIXES.has(ws[i - 1]!)));
}
