/** Open Library: `https://openlibrary.org/isbn/{isbn}.json` (redirects to the edition) + author records. */
import { biblioOf, toIsbn13, type Creator } from "@ao/core";
import { clean, normalizeDate, parseName } from "../extract/names.js";
import { isSensitive, type LookupContext, type LookupResult } from "./context.js";
import { cleanBiblio } from "./crossref.js";

interface Edition {
  title?: string;
  subtitle?: string;
  authors?: Array<{ key?: string }>;
  publishers?: string[];
  publish_date?: string;
  isbn_13?: string[];
  isbn_10?: string[];
  by_statement?: string;
  number_of_pages?: number;
  publish_places?: string[];
  edition_name?: string;
  series?: string[];
}

const MAX_AUTHORS = 10;
const AUTHOR_KEY = /^\/authors\/OL\d+A$/u;

export async function openLibraryIsbn(isbn13: string, ctx: LookupContext): Promise<LookupResult | null> {
  const opts = { ttlDays: 30, sensitive: isSensitive(ctx) };
  const ed = await ctx.http.getJson<Edition>(`https://openlibrary.org/isbn/${isbn13}.json`, { ...opts, cacheKey: `openlibrary:isbn:${isbn13}` });
  const title = clean(ed?.title ?? "");
  if (!ed || !title) return null;

  const creators: Creator[] = [];
  for (const a of (ed.authors ?? []).slice(0, MAX_AUTHORS)) {
    if (!a.key || !AUTHOR_KEY.test(a.key)) continue;
    const rec = await ctx.http.getJson<{ name?: string; personal_name?: string }>(`https://openlibrary.org${a.key}.json`, {
      ...opts,
      cacheKey: `openlibrary:author:${a.key}`,
    });
    const c = parseName(rec?.name ?? rec?.personal_name ?? "");
    if (c) creators.push(c);
  }

  const isbns = [...new Set([isbn13, ...(ed.isbn_13 ?? []), ...(ed.isbn_10 ?? [])].map((i) => toIsbn13(i)).filter((i): i is string => !!i))];
  const issued = normalizeDate(ed.publish_date);
  const sub = clean(ed.subtitle ?? "");
  return {
    title: sub ? `${title}: ${sub}` : title,
    creators,
    ...(issued ? { issued } : {}),
    ...(ed.publishers?.[0] ? { publisher: clean(ed.publishers[0]) } : {}),
    ...cleanBiblio(
      biblioOf({
        publisherPlace: ed.publish_places?.[0],
        edition: ed.edition_name,
        numberOfPages: Number.isInteger(ed.number_of_pages) && ed.number_of_pages! > 0 ? ed.number_of_pages : undefined,
        collectionTitle: ed.series?.[0],
      }),
    ),
    type: "book",
    identifiers: { isbn: isbns },
    provider: "openlibrary",
  };
}
