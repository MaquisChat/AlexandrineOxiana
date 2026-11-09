import { z } from "zod";
import { isId } from "../ids.js";

/** A UUIDv7 id string. */
export const Id = z.string().refine(isId, { message: "not a UUIDv7 id" });

/** ISO 8601 UTC timestamp, e.g. 2026-11-09T10:00:00.000Z. */
export const Timestamp = z.string().datetime();

/**
 * Path relative to the library root, using forward slashes.
 * Rejects empty, leading "/", backslashes, ".." segments, and Windows drive letters.
 */
export const LibraryRelativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/"), { message: "must not start with /" })
  .refine((p) => !p.includes("\\"), { message: "must not contain backslashes" })
  .refine((p) => !p.split("/").includes(".."), { message: "must not contain .. segments" })
  .refine((p) => !/^[A-Za-z]:/.test(p), { message: "must not start with a drive letter" });

const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validEdtfLite(s: string): boolean {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s);
  if (!m) return false;
  if (m[2] === undefined) return true;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return false;
  if (m[3] === undefined) return true;
  const day = Number(m[3]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const max = month === 2 ? (leap ? 29 : 28) : DAYS[month - 1]!;
  return day >= 1 && day <= max;
}

/** EDTF-lite date: YYYY, YYYY-MM, or YYYY-MM-DD (validated). */
export const EdtfLite = z.string().refine(validEdtfLite, { message: "expected YYYY, YYYY-MM or YYYY-MM-DD" });

export const MultiText = z.object({
  variants: z.array(
    z.object({
      lang: z.string().min(1), // BCP-47
      kind: z.enum(["original", "romanized", "translated"]),
      value: z.string(),
      producedBy: z
        .object({ by: z.enum(["human", "machine"]), tool: z.string().optional(), at: Timestamp })
        .optional(),
    }),
  ),
});
export type MultiText = z.infer<typeof MultiText>;

/** First `original` variant's value, else the first variant's, else "". */
export function primary(t: MultiText): string {
  const v = t.variants.find((x) => x.kind === "original") ?? t.variants[0];
  return v?.value ?? "";
}

/** Value of the first variant in `lang`, if any. */
export function inLang(t: MultiText, lang: string): string | undefined {
  return t.variants.find((x) => x.lang === lang)?.value;
}
