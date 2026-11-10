/**
 * HTML: Highwire `citation_*`, then Dublin Core, then OpenGraph, then `<title>`. The page is
 * parsed as text with regular expressions: no DOM, no scripts, and nothing it references
 * (scripts, styles, images, frames, refresh targets) is ever fetched.
 */
import * as fsp from "node:fs/promises";
import type { Creator } from "@ao/core";
import { clean, decodeEntities, markupToText, normalizeDate, parseName } from "./names.js";
import type { RawExtract } from "./types.js";

const MAX_HTML_BYTES = 16 * 1024 * 1024;

function attrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gu)) {
    out.set(m[1]!.toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

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

  const meta = new Map<string, string[]>();
  for (const m of html.matchAll(/<meta\b([^>]*)>/giu)) {
    const a = attrs(m[1]!);
    const key = (a.get("name") ?? a.get("property") ?? "").toLowerCase();
    const content = clean(a.get("content") ?? "");
    if (!key || !content) continue;
    meta.set(key, [...(meta.get(key) ?? []), content]);
  }
  const first = (...keys: string[]) => keys.map((k) => meta.get(k)?.[0]).find((v) => v);
  const list = (...keys: string[]) => keys.map((k) => meta.get(k) ?? []).find((v) => v.length) ?? [];

  const out: RawExtract = {};
  const docTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1];
  const title = first("citation_title", "dc.title", "dcterms.title", "og:title") ?? (docTitle ? clean(decodeEntities(docTitle)) : undefined);
  if (title) out.title = title;

  let creators = list("citation_author").map((n) => parseName(n));
  if (!creators.length) creators = list("dc.creator", "dcterms.creator").map((n) => parseName(n));
  if (!creators.length) creators = list("author", "article:author").filter((n) => !/^https?:/iu.test(n)).map((n) => parseName(n));
  const cs = creators.filter((c): c is Creator => !!c);
  if (cs.length) out.creators = cs;

  const issued = normalizeDate(
    first("citation_publication_date", "citation_date", "citation_online_date", "dc.date", "dcterms.issued", "dcterms.created", "article:published_time"),
  );
  if (issued) out.issued = issued;

  const lang = first("citation_language", "dc.language", "dcterms.language") ?? attrs(/<html\b([^>]*)>/iu.exec(html)?.[1] ?? "").get("lang");
  if (lang) out.language = clean(lang);

  const dois = [...list("citation_doi"), ...list("dc.identifier", "dcterms.identifier").filter((v) => /10\.\d{4,9}\//u.test(v))].map((d) =>
    d.replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/iu, ""),
  );
  const isbns = list("citation_isbn");
  if (dois.length || isbns.length) out.ids = { dois, isbns };

  const body = /<body\b[\s\S]*/iu.exec(html)?.[0] ?? html.replace(/<head\b[\s\S]*?<\/head>/iu, " ");
  const text = markupToText(body);
  if (text) out.text = text;
  return out;
}
