/**
 * Whether a string can be used as a CSS font-family value (a single name or a comma list): not
 * empty, at most 300 characters, and none of the characters that could end the value or the rule
 * (`; { } < > \`) or any control character. Shared by the service's appearance validation and the
 * UI (R105).
 */
export function isUsableFontFamily(family: string): boolean {
  // eslint-disable-next-line no-control-regex
  return family.trim().length > 0 && family.length <= 300 && !/[;{}<>\\\u0000-\u001f\u007f]/.test(family);
}
