/** Duplicate detection against existing sources. Pure and platform-neutral. */
import { toIsbn13 } from "./identifiers.js";
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

function canonDoi(d: string | undefined): string {
  return (d ?? "").trim().replace(/^(?:(?:https?:\/\/)?(?:dx\.|www\.)?doi\.org\/|doi:\s*|doi\s+)/i, "").trim().toLowerCase();
}

function canonIsbns(xs: string[] | undefined): string[] {
  const out: string[] = [];
  for (const x of xs ?? []) {
    const v = toIsbn13(x);
    if (v) out.push(v);
  }
  return out;
}

function canonShas(xs: string[]): string[] {
  return xs.map((h) => h.trim().toLowerCase()).filter((h) => h !== "");
}

function yearOf(y: string | undefined): number | null {
  const m = y?.match(/\d{4}/);
  return m ? Number(m[0]) : null;
}

/**
 * Finds the best duplicate. Precedence across all existing items: same-file > same-doi >
 * same-isbn > fuzzy (fuzzy is only ever `likely`). The first existing item wins within a reason.
 * Identifiers are canonicalised first; a fuzzy match is vetoed by conflicting DOIs or ISBNs.
 */
export function findDuplicate(candidate: DupKey, existing: Iterable<DupKey & { sourceId: string }>): DupMatch | null {
  const shas = new Set(canonShas(candidate.sha256s));
  const doi = canonDoi(candidate.doi);
  const isbns = new Set(canonIsbns(candidate.isbns));
  const family = candidate.firstCreatorFamily ? normalizeTitle(candidate.firstCreatorFamily) : "";
  const year = yearOf(candidate.year);
  const title = candidate.title ? normalizeTitle(candidate.title) : "";

  let doiHit: string | undefined;
  let isbnHit: string | undefined;
  let fuzzyHit: string | undefined;

  for (const e of existing) {
    if (canonShas(e.sha256s).some((h) => shas.has(h))) return { sourceId: e.sourceId, reason: "same-file", certainty: "certain" };
    const eDoi = canonDoi(e.doi);
    const eIsbns = canonIsbns(e.isbns);
    if (doiHit === undefined && doi && eDoi === doi) doiHit = e.sourceId;
    if (isbnHit === undefined && isbns.size && eIsbns.some((i) => isbns.has(i))) isbnHit = e.sourceId;
    if (fuzzyHit === undefined && title && family && year !== null && e.title && e.firstCreatorFamily) {
      const ey = yearOf(e.year);
      if (doi && eDoi && doi !== eDoi) continue;
      if (isbns.size && eIsbns.length && !eIsbns.some((i) => isbns.has(i))) continue;
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
