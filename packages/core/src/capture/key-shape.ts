/**
 * "This looks like a session's key" (R328 b, narrowed by R333 b; moved here from the library's
 * `find/where.ts` by R391 so that the stored address judges parameter values by the same rule): 16 or
 * more hexadecimal digits alone, or 20 or more characters of letters, digits, `-` and `_` holding a
 * lower-case letter, an upper-case letter and a digit, or ASP.NET's cookieless form (`(S(…))`,
 * `(A(…)S(…))`, …). A long plain word is not one.
 */
export const HEX_KEY = /^[0-9A-Fa-f]{16,}$/u;
export const MIXED_KEY = /^[A-Za-z0-9_-]{20,}$/u;
export const ASPNET_KEY = /^\((?:[A-Z]\([^()/]+\))+\)$/u;

/** True when one piece (a path segment, a run of a value) looks like a session's key by the rule above. */
export function sessionLike(seg: string): boolean {
  return HEX_KEY.test(seg) || (MIXED_KEY.test(seg) && /[a-z]/u.test(seg) && /[A-Z]/u.test(seg) && /\d/u.test(seg)) || ASPNET_KEY.test(seg);
}

/**
 * True when a parameter's (decoded) value holds a key (R391): the whole value is `sessionLike`, or one
 * of its runs of letters, digits, `-` and `_` is (an OAuth code `4/0AX4…`, a signature with `~` in it).
 */
export function keyLikeValue(value: string): boolean {
  const v = String(value);
  return sessionLike(v) || v.split(/[^A-Za-z0-9_-]+/u).some(sessionLike);
}

/**
 * True when a value has the shape of a signed token (a JSON Web Token): three runs of base64url
 * characters joined by two dots, the first beginning `eyJ` (R391: dropped whatever its name).
 */
export function signedTokenValue(value: string): boolean {
  return /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(String(value).trim());
}
