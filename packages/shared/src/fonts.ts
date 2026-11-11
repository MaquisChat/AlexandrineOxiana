/**
 * Whether a string can be used as a CSS font-family value (a single name or a comma list): not
 * empty, at most 300 characters, and none of the characters that could end the value or the rule
 * (`; { } < > \`), no C0/C1 control characters, no bidi controls (U+202A–202E, U+2066–2069, LRM/RLM,
 * ALM), no zero-width characters (U+200B–200D, U+2060, U+FEFF) and no line/paragraph separators
 * (U+2028/2029). Shared by the service's appearance validation and the UI (R105, R108).
 */
// eslint-disable-next-line no-control-regex
const REFUSED = /[;{}<>\\\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\u061c\ufeff]/;

export function isUsableFontFamily(family: string): boolean {
  return family.trim().length > 0 && family.length <= 300 && !REFUSED.test(family);
}
