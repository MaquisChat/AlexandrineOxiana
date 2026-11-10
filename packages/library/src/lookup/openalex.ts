/** OpenAlex: `https://api.openalex.org/works/doi:{doi}` and title search. */
import type { SourceType } from "@ao/core";
import { clean, normalizeDate, parseName } from "../extract/names.js";
import type { LookupContext, LookupResult } from "./context.js";
import { encodeDoi } from "./crossref.js";

interface OpenAlexWork {
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_date?: string | null;
  publication_year?: number | null;
  type?: string | null;
  authorships?: Array<{ author?: { display_name?: string | null } | null; raw_author_name?: string | null }> | null;
  primary_location?: { source?: { display_name?: string | null; host_organization_name?: string | null } | null } | null;
}

const TYPES: Record<string, SourceType> = {
  article: "article-journal",
  review: "article-journal",
  letter: "article-journal",
  editorial: "article-journal",
  book: "book",
  "book-chapter": "chapter",
  preprint: "preprint",
  dissertation: "thesis",
  dataset: "dataset",
  report: "report",
};

export function mapOpenAlex(w: OpenAlexWork): LookupResult | null {
  const title = clean(w.title ?? w.display_name ?? "");
  if (!title) return null;
  const doi = w.doi ? w.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "").toLowerCase() : undefined;
  const issued = normalizeDate(w.publication_date) ?? (w.publication_year ? String(w.publication_year) : undefined);
  const source = w.primary_location?.source;
  const creators = (w.authorships ?? []).flatMap((a) => {
    const c = parseName(a.author?.display_name ?? a.raw_author_name ?? "");
    return c ? [c] : [];
  });
  return {
    title,
    creators,
    ...(issued ? { issued } : {}),
    ...(source?.display_name ? { container: clean(source.display_name) } : {}),
    ...(source?.host_organization_name ? { publisher: clean(source.host_organization_name) } : {}),
    type: TYPES[w.type ?? ""] ?? "other",
    identifiers: doi ? { doi } : {},
    provider: "openalex",
  };
}

export async function openAlexWork(doi: string, ctx: LookupContext): Promise<LookupResult | null> {
  const w = await ctx.http.getJson<OpenAlexWork>(`https://api.openalex.org/works/doi:${encodeDoi(doi)}`, {
    cacheKey: `openalex:doi:${doi}`,
    ttlDays: 30,
    sensitive: ctx.sensitive,
  });
  return w ? mapOpenAlex(w) : null;
}

export async function openAlexSearch(title: string, creator: string | undefined, ctx: LookupContext): Promise<LookupResult[]> {
  const q = clean([title, creator].filter(Boolean).join(" "));
  if (!q) return [];
  const url = `https://api.openalex.org/works?${new URLSearchParams({ search: q, "per-page": "5" })}`;
  const res = await ctx.http.getJson<{ results?: OpenAlexWork[] }>(url, {
    cacheKey: `openalex:search:${q.toLowerCase()}`,
    ttlDays: 30,
    sensitive: ctx.sensitive,
  });
  return (res?.results ?? []).map(mapOpenAlex).filter((r): r is LookupResult => r !== null);
}
