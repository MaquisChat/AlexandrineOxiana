/**
 * The one test for "this required text holds nothing a reader would see" (R379, R391 c): absent,
 * empty, or only white space, zero-width and other default-ignorable characters (a no-break or
 * zero-width space, a soft hyphen, a byte-order mark, bidi marks), the fillers that render as nothing
 * (U+2800 braille blank, the Hangul fillers U+3164, U+115F, U+1160, U+FFA0), and combining marks with
 * nothing to combine with. Used wherever a required text is checked: the policy engine (legal basis,
 * protocol number, the set-aside and withdrawal-review reasons), the library's own legal-basis checks
 * and a governance exception's reason and approver.
 */
const BLANK = /^[\s\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}⠀ㅤᅟᅠﾠ]*$/u;

export function blank(v: string | null | undefined): boolean {
  return typeof v !== "string" || BLANK.test(v);
}

/** The text trimmed, or undefined when it is blank (a required text that is not there). */
export function nonBlank(v: string | null | undefined): string | undefined {
  return blank(v) ? undefined : (v as string).trim();
}
