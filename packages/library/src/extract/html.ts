/**
 * HTML: Highwire `citation_*`, then Dublin Core, then OpenGraph, then `<title>`. The page is
 * scanned as text in linear time (scan.ts): no DOM, no scripts, and nothing it references
 * (scripts, styles, images, frames, refresh targets) is ever fetched. Metadata is read from the
 * first 512 KB only; body text stops once enough has been collected.
 */
import * as fsp from "node:fs/promises";
import type { Creator } from "@ao/core";
import { clean, decodeEntities, markupToText, normalizeDate, parseName } from "./names.js";
import { attrPairs, attrValue, textOf, tokens } from "./scan.js";
import { MAX_TEXT_CHARS, type RawExtract } from "./types.js";

const MAX_HTML_BYTES = 16 * 1024 * 1024;
export const MAX_METADATA_SCAN = 512 * 1024;
/** Values kept per meta key (creators: per creator key), so repeats stay cheap. */
const MAX_VALUES_PER_KEY = 200;
const MAX_CREATORS = 500;
const CREATOR_KEYS = new Set(["citation_author", "dc.creator", "dcterms.creator", "author", "article:author"]);

export async function extractHtml(path: string): Promise<RawExtract> {
  const fh = await fsp.open(path, "r");
  let html: string;
  try {
    const buf = Buffer.alloc(Math.min((await fh.stat()).size, MAX_HTML_BYTES));
    await fh.read(buf, 0, buf.length, 0);
    html = buf.toString("utf8");
  } finally {
    await fh.close();
  }

  // One linear pass over the first 512 KB: <meta>, <html lang>, the first complete <title>, <body>.
  const head = html.slice(0, MAX_METADATA_SCAN);
  const meta = new Map<string, string[]>();
  let lang: string | undefined;
  let docTitle: string | undefined;
  let titleOpen = -1;
  let bodyAt = -1;
  for (const t of tokens(head)) {
    if (t.kind !== "tag") continue;
    if (t.local === "meta" && !t.end) {
      const a = new Map(attrPairs(t.attrs));
      const key = (a.get("name") ?? a.get("property") ?? "").toLowerCase();
      const content = clean(decodeEntities(a.get("content") ?? ""));
      if (key && content) {
        let values = meta.get(key);
        if (!values) meta.set(key, (values = []));
        if (values.length < (CREATOR_KEYS.has(key) ? MAX_CREATORS : MAX_VALUES_PER_KEY)) values.push(content);
      }
    } else if (t.local === "html" && !t.end && lang === undefined) {
      lang = attrValue(t.attrs, "lang");
    } else if (t.local === "title" && docTitle === undefined) {
      if (!t.end && !t.self) titleOpen = t.stop;
      else if (t.end && titleOpen >= 0) docTitle = clean(decodeEntities(textOf(head.slice(titleOpen, t.start))));
    } else if (t.local === "body" && !t.end && bodyAt < 0) {
      bodyAt = t.start;
    }
  }
  const first = (...keys: string[]) => keys.map((k) => meta.get(k)?.[0]).find((v) => v);
  const list = (...keys: string[]) => keys.map((k) => meta.get(k) ?? []).find((v) => v.length) ?? [];

  const out: RawExtract = {};
  const title = first("citation_title", "dc.title", "dcterms.title", "og:title") ?? (docTitle || undefined);
  if (title) out.title = title;

  let creators = list("citation_author").map((n) => parseName(n));
  if (!creators.length) creators = list("dc.creator", "dcterms.creator").map((n) => parseName(n));
  if (!creators.length) creators = list("author", "article:author").filter((n) => !/^https?:/iu.test(n)).map((n) => parseName(n));
  const cs = creators.filter((c): c is Creator => !!c).slice(0, MAX_CREATORS);
  if (cs.length) out.creators = cs;

  const issued = normalizeDate(
    first("citation_publication_date", "citation_date", "citation_online_date", "dc.date", "dcterms.issued", "dcterms.created", "article:published_time"),
  );
  if (issued) out.issued = issued;

  const language = first("citation_language", "dc.language", "dcterms.language") ?? (lang ? clean(decodeEntities(lang)) : undefined);
  if (language) out.language = language;

  const dois = [...list("citation_doi"), ...list("dc.identifier", "dcterms.identifier").filter((v) => /10\.\d{4,9}\//u.test(v))].map((d) =>
    d.replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/iu, ""),
  );
  const isbns = list("citation_isbn");
  if (dois.length || isbns.length) out.ids = { dois, isbns };

  // Body text (head-only elements are skipped by markupToText when there is no <body>).
  const text = markupToText(bodyAt >= 0 ? html.slice(bodyAt) : html, MAX_TEXT_CHARS);
  if (text) out.text = text;
  return out;
}
