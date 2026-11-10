/** EPUB: OPF metadata (dc:title, dc:creator, dc:date, dc:identifier, dc:language) and the first spine items' text. */
import type { Creator } from "@ao/core";
import { clean, decodeEntities, markupToText, normalizeDate, parseName } from "./names.js";
import { MAX_TEXT_CHARS, type RawExtract } from "./types.js";
import { openZip } from "./zip.js";

const MAX_XML_BYTES = 2 * 1024 * 1024;
const TEXT_SECTIONS = 3;

/** Text of each `<dc:tag ...>` element (namespace prefix optional), entity-decoded. */
export function dcValues(xml: string, tag: string): Array<{ attrs: string; value: string }> {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}\\s*>)`, "giu");
  return [...xml.matchAll(re)]
    .map((m) => ({ attrs: m[1] ?? "", value: clean(decodeEntities((m[2] ?? "").replace(/<[^>]*>/gu, " "))) }))
    .filter((v) => v.value);
}

const attr = (attrs: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "iu").exec(attrs)?.slice(2).find((v) => v !== undefined);

/** Joins an OPF-relative href to the OPF's folder (no `..` escapes past the root). */
function resolveHref(opfPath: string, href: string): string {
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const parts: string[] = [];
  for (const seg of (base + decodeURIComponent(href.split("#")[0]!)).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

export async function extractEpub(path: string): Promise<RawExtract> {
  const zip = await openZip(path);
  try {
    const container = (await zip.read("META-INF/container.xml", MAX_XML_BYTES))?.toString("utf8") ?? "";
    const opfPath = attr(/<rootfile\b([^>]*)>/iu.exec(container)?.[1] ?? "", "full-path") ?? zip.names().find((n) => n.endsWith(".opf"));
    const opf = opfPath ? (await zip.read(opfPath, MAX_XML_BYTES))?.toString("utf8") : undefined;
    if (!opf || !opfPath) return {};
    const meta = /<(?:[\w-]+:)?metadata\b[\s\S]*?<\/(?:[\w-]+:)?metadata>/iu.exec(opf)?.[0] ?? opf;

    const out: RawExtract = {};
    const title = dcValues(meta, "title")[0]?.value;
    if (title) out.title = title;
    const creators = dcValues(meta, "creator")
      .map((c) => parseName(attr(c.attrs, "opf:file-as") && !c.value.includes(" ") ? attr(c.attrs, "opf:file-as")! : c.value))
      .filter((c): c is Creator => !!c);
    if (creators.length) out.creators = creators;
    const issued = normalizeDate(dcValues(meta, "date")[0]?.value);
    if (issued) out.issued = issued;
    const language = dcValues(meta, "language")[0]?.value;
    if (language) out.language = language;

    const isbns: string[] = [];
    const dois: string[] = [];
    for (const id of dcValues(meta, "identifier")) {
      const scheme = (attr(id.attrs, "opf:scheme") ?? "").toLowerCase();
      const v = id.value.replace(/^urn:/iu, "");
      if (scheme === "isbn" || /^isbn[:\s]/iu.test(v)) isbns.push(v.replace(/^isbn[:\s]*/iu, ""));
      else if (scheme === "doi" || /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\//iu.test(v)) dois.push(v.replace(/^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)/iu, ""));
    }
    if (isbns.length || dois.length) out.ids = { isbns, dois };

    // Text of the first spine items (scripts and styles dropped, never run).
    const manifest = new Map<string, string>();
    for (const m of opf.matchAll(/<(?:[\w-]+:)?item\b([^>]*)\/?>/giu)) {
      const id = attr(m[1]!, "id");
      const href = attr(m[1]!, "href");
      const type = attr(m[1]!, "media-type") ?? "";
      if (id && href && /html/iu.test(type)) manifest.set(id, href);
    }
    const texts: string[] = [];
    let length = 0;
    for (const m of opf.matchAll(/<(?:[\w-]+:)?itemref\b([^>]*)\/?>/giu)) {
      if (texts.length >= TEXT_SECTIONS || length >= MAX_TEXT_CHARS) break;
      const href = manifest.get(attr(m[1]!, "idref") ?? "");
      if (!href) continue;
      const body = (await zip.read(resolveHref(opfPath, href), MAX_XML_BYTES))?.toString("utf8");
      if (!body) continue;
      const t = markupToText(/<body\b[\s\S]*/iu.exec(body)?.[0] ?? body);
      if (t) {
        texts.push(t);
        length += t.length;
      }
    }
    if (texts.length) out.text = texts.join("\n\n");
    return out;
  } finally {
    zip.close();
  }
}
