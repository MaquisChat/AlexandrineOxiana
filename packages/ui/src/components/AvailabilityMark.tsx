/**
 * Task 69 (D17): a captured item that a later capture found gone from its platform keeps its record
 * and files; the library records `availability: { status: "unavailable-on-platform", firstNoticedAt }`.
 * This mark says so in words, with the date it was noticed when the record holds one. It shows
 * exactly what the record says: "available" (or a post that reappeared, which the library sets back
 * to its earlier status) shows nothing; "incomplete" is about the library's own copy, not the
 * source, so it is not this mark; an unknown status shows nothing.
 */
import type { SourceAvailability } from "../api/library";
import "./library.css";

const DATE = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/** The mark's words, or undefined when the record does not say the item is gone from its source. */
export function availabilityText(a: SourceAvailability | undefined): string | undefined {
  if (a?.status !== "unavailable-on-platform") return undefined;
  const d = a.firstNoticedAt ? new Date(a.firstNoticedAt) : undefined;
  return d && !Number.isNaN(d.getTime()) ? `No longer available at its source, noticed on ${DATE.format(d)}` : "No longer available at its source";
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
