/** Crossref REST API: `https://api.crossref.org/works/{doi}`. */
import { toIsbn13, type Creator, type SourceType } from "@ao/core";
import { clean } from "../extract/names.js";
import { isSensitive, type LookupContext, type LookupResult } from "./context.js";

interface CrossrefPerson {
  given?: string;
  family?: string;
  name?: string;
}
interface CrossrefWork {
  DOI?: string;
  type?: string;
  title?: string[];
  subtitle?: string[];
  author?: CrossrefPerson[];
  editor?: CrossrefPerson[];
  translator?: CrossrefPerson[];
  "container-title"?: string[];
  publisher?: string;
  issued?: { "date-parts"?: Array<Array<number | null>> };
  published?: { "date-parts"?: Array<Array<number | null>> };
  ISSN?: string[];
  ISBN?: string[];
}

const TYPES: Record<string, SourceType> = {
  "journal-article": "article-journal",
  "proceedings-article": "article-journal",
  book: "book",
  monograph: "book",
  "edited-book": "book",
  "reference-book": "book",
  "book-chapter": "chapter",
  "book-section": "chapter",
  "book-part": "chapter",
  "reference-entry": "chapter",
  "posted-content": "preprint",
  report: "report",
  "report-component": "report",
  dissertation: "thesis",
  dataset: "dataset",
};

/** Path-encodes a DOI but keeps its slashes readable (Crossref and OpenAlex accept both). */
export const encodeDoi = (doi: string) => encodeURIComponent(doi).replace(/%2F/giu, "/");

/** Crossref date-parts to EDTF-lite; parts stop at the first missing one ([[2020, null, 5]] → "2020"). */
export function datePartsToEdtf(dp: Array<Array<number | null>> | undefined): string | undefined {
  const parts: number[] = [];
  for (const n of (dp?.[0] ?? []).slice(0, 3)) {
    if (typeof n !== "number" || !Number.isInteger(n)) break;
    parts.push(n);
  }
  if (!parts.length || parts[0]! < 1000) return undefined;
  return parts.map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, "0"))).join("-");
}

function people(list: CrossrefPerson[] | undefined, role: Creator["role"]): Creator[] {
  return (list ?? []).flatMap((p): Creator[] => {
    const family = p.family ? clean(p.family) : undefined;
    const given = p.given ? clean(p.given) : undefined;
    if (family) return [{ ...(given ? { given } : {}), family, role }];
    if (p.name) return [{ literal: clean(p.name), role }];
    return [];
  });
}

export function mapCrossref(w: CrossrefWork, doi: string): LookupResult | null {
  const title = clean(w.title?.[0] ?? "");
  if (!title) return null;
  const sub = clean(w.subtitle?.[0] ?? "");
  const issn = w.ISSN?.[0];
  const isbns = [...new Set((w.ISBN ?? []).map((i) => toIsbn13(i)).filter((i): i is string => !!i))];
  const issued = datePartsToEdtf(w.issued?.["date-parts"]) ?? datePartsToEdtf(w.published?.["date-parts"]);
  const container = clean(w["container-title"]?.[0] ?? "");
  return {
    title: sub ? `${title}: ${sub}` : title,
    creators: [...people(w.author, "author"), ...people(w.editor, "editor"), ...people(w.translator, "translator")],
    ...(issued ? { issued } : {}),
    ...(container ? { container } : {}),
    ...(w.publisher ? { publisher: clean(w.publisher) } : {}),
    type: TYPES[w.type ?? ""] ?? "other",
    identifiers: { doi: (w.DOI ?? doi).toLowerCase(), ...(isbns.length ? { isbn: isbns } : {}), ...(issn ? { issn } : {}) },
    provider: "crossref",
  };
}

/** null: Crossref does not know the DOI. Throws LookupHttpError when it cannot be asked. */
export async function crossrefWork(doi: string, ctx: LookupContext): Promise<LookupResult | null> {
  const res = await ctx.http.getJson<{ message?: CrossrefWork }>(`https://api.crossref.org/works/${encodeDoi(doi)}`, {
    cacheKey: `crossref:doi:${doi}`,
    ttlDays: 30,
    sensitive: isSensitive(ctx),
  });
  return res?.message ? mapCrossref(res.message, doi) : null;
}
