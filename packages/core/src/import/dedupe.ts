/** Duplicate detection against existing sources. Pure and platform-neutral. */
import { normalizeTitle, titleSimilarity } from "../verify/evidence.js";

export type DupKey = {
  sha256s: string[];
  doi?: string;
  isbns?: string[];
  title?: string;
  firstCreatorFamily?: string;
  year?: string;
};

export type DupMatch = {
  sourceId: string;
  reason: "same-file" | "same-doi" | "same-isbn" | "fuzzy";
  certainty: "certain" | "likely";
};

export const FUZZY_THRESHOLD = 0.92;

/**
 * Finds the best duplicate. Precedence across all existing items: same-file > same-doi >
 * same-isbn > fuzzy (fuzzy is only ever `likely`). The first existing item wins within a reason.
 */
export function findDuplicate(candidate: DupKey, existing: Iterable<DupKey & { sourceId: string }>): DupMatch | null {
  const shas = new Set(candidate.sha256s);
  const doi = candidate.doi?.trim().toLowerCase();
  const isbns = new Set(candidate.isbns ?? []);
  const family = candidate.firstCreatorFamily ? normalizeTitle(candidate.firstCreatorFamily) : "";
  const year = candidate.year && /^\d{4}$/.test(candidate.year) ? Number(candidate.year) : null;
  const title = candidate.title ? normalizeTitle(candidate.title) : "";

  let doiHit: string | undefined;
  let isbnHit: string | undefined;
  let fuzzyHit: string | undefined;

  for (const e of existing) {
    if (e.sha256s.some((h) => shas.has(h))) return { sourceId: e.sourceId, reason: "same-file", certainty: "certain" };
    if (doiHit === undefined && doi && e.doi?.trim().toLowerCase() === doi) doiHit = e.sourceId;
    if (isbnHit === undefined && isbns.size && e.isbns?.some((i) => isbns.has(i))) isbnHit = e.sourceId;
    if (fuzzyHit === undefined && title && family && year !== null && e.title && e.firstCreatorFamily && e.year) {
      const ey = /^\d{4}$/.test(e.year) ? Number(e.year) : null;
      if (
        ey !== null &&
        Math.abs(ey - year) <= 1 &&
        normalizeTitle(e.firstCreatorFamily) === family &&
        titleSimilarity(candidate.title!, e.title) >= FUZZY_THRESHOLD
      ) fuzzyHit = e.sourceId;
    }
  }

  if (doiHit !== undefined) return { sourceId: doiHit, reason: "same-doi", certainty: "certain" };
  if (isbnHit !== undefined) return { sourceId: isbnHit, reason: "same-isbn", certainty: "certain" };
  if (fuzzyHit !== undefined) return { sourceId: fuzzyHit, reason: "fuzzy", certainty: "likely" };
  return null;
}
