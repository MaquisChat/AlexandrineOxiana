/**
 * Task 69 (D17): a captured item that a later capture found gone from its platform keeps its record
 * and files; the library records `availability: { status: "unavailable-on-platform", firstNoticedAt }`.
 * This mark says so in words, with the date it was noticed when the record holds one. It shows
 * exactly what the record says: "available" (or a post that reappeared, which the library sets back
 * to its earlier status) shows nothing; "incomplete" is about the library's own copy, not the
 * source, so it is not this mark; an unknown status shows nothing.
 *
 * Task Z5: an item deleted in the researcher's Zotero library, or moved to its bin, is marked the same way
 * with `zotero: "deleted" | "bin"`, and the mark says which, with the date in the form "12 March 2027".
 */
import type { SourceAvailability } from "../api/library";
import "./library.css";

const DATE = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
/** The Zotero marks' dates (Global Constraints of the Zotero plan): "12 March 2027". */
const BRITISH_DATE = new Intl.DateTimeFormat("en-GB", { dateStyle: "long" });

const ZOTERO_WORDS: Record<NonNullable<SourceAvailability["zotero"]>, string> = {
  deleted: "No longer in your Zotero library",
  bin: "In your Zotero bin",
};

/** The mark's words, or undefined when the record does not say the item is gone from its source. */
export function availabilityText(a: SourceAvailability | undefined): string | undefined {
  if (a?.status !== "unavailable-on-platform") return undefined;
  const d = a.firstNoticedAt ? new Date(a.firstNoticedAt) : undefined;
  const dated = d && !Number.isNaN(d.getTime()) ? d : undefined;
  const zotero = a.zotero && Object.hasOwn(ZOTERO_WORDS, a.zotero) ? ZOTERO_WORDS[a.zotero] : undefined;
  if (zotero) return dated ? `${zotero}, noticed on ${BRITISH_DATE.format(dated)}` : zotero;
  return dated ? `No longer available at its source, noticed on ${DATE.format(dated)}` : "No longer available at its source";
}

export function AvailabilityMark({ availability }: { availability: SourceAvailability | undefined }) {
  const text = availabilityText(availability);
  if (!text) return null;
  return (
    <span role="note" aria-label={text} className="ao-badge ao-badge--gone">
      {text}
    </span>
  );
}
