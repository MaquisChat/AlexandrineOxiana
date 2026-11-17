/** EPUB: OPF metadata (dc:title, dc:creator, dc:date, dc:identifier, dc:language) and the first spine items' text. */
import { basename } from "node:path";
import type { Creator } from "@ao/core";
import { clean, decodeEntities, markupToText, normalizeDate, parseName } from "./names.js";
import { attrValue, elements, firstElement, startTags, textOf } from "./scan.js";
import { embeddedTitle, keepCreators } from "./title-like.js";
import { MAX_TEXT_CHARS, type RawExtract } from "./types.js";
import { openZip } from "./zip.js";

/** OPF and container are metadata: only their first 512 KB is read (R52). */
const MAX_XML_BYTES = 512 * 1024;
const MAX_CHAPTER_BYTES = 2 * 1024 * 1024;
const TEXT_SECTIONS = 3;

/** Text of each complete `<tag ...>` element (namespace prefix optional), entity-decoded. Linear time. */
export function dcValues(xml: string, tag: string): Array<{ attrs: string; value: string }> {
  const out: Array<{ attrs: string; value: string }> = [];
  for (const e of elements(xml, tag)) {
    const value = clean(decodeEntities(textOf(e.inner)));
    if (value) out.push({ attrs: e.attrs, value });
  }
  return out;
}

const attr = (attrs: string, name: string) => attrValue(attrs, name);

/** Joins an OPF-relative href to the OPF's folder (no `..` escapes past the root); undefined for a malformed href. */
function resolveHref(opfPath: string, href: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split("#")[0]!);
  } catch {
    return undefined;
  }
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const parts: string[] = [];
  for (const seg of (base + decoded).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

export async function extractEpub(path: string): Promise<RawExtract> {
  const zip = await openZip(path);
  try {
    const container = (await zip.read("META-INF/container.xml", MAX_XML_BYTES))?.toString("utf8") ?? "";
    let rootfile: string | undefined;
    for (const a of startTags(container, "rootfile")) {
      rootfile = attr(a, "full-path");
      break;
    }
    const opfPath = rootfile ?? zip.names().find((n) => n.endsWith(".opf"));
    const opf = opfPath ? (await zip.read(opfPath, MAX_XML_BYTES))?.toString("utf8") : undefined;
    if (!opf || !opfPath) return {};
    const meta = firstElement(opf, "metadata")?.inner ?? opf;

    const out: RawExtract = {};
    // R394: an OPF title that does not look like one and stock authors are dropped.
    const rawTitle = dcValues(meta, "title")[0]?.value;
    const title = embeddedTitle(rawTitle, basename(path));
    if (title) out.title = title;
    if (rawTitle) out.rawTitle = rawTitle;
    const creators = keepCreators(
      dcValues(meta, "creator")
        .map((c) => parseName(attr(c.attrs, "opf:file-as") && !c.value.includes(" ") ? attr(c.attrs, "opf:file-as")! : c.value))
        .filter((c): c is Creator => !!c),
    );
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
    for (const a of startTags(opf, "item")) {
      const id = attr(a, "id");
      const href = attr(a, "href");
      const type = attr(a, "media-type") ?? "";
      if (id && href && /html/iu.test(type)) manifest.set(id, href);
    }
    const texts: string[] = [];
    let length = 0;
    for (const a of startTags(opf, "itemref")) {
      if (texts.length >= TEXT_SECTIONS || length >= MAX_TEXT_CHARS) break;
      const href = manifest.get(attr(a, "idref") ?? "");
      const entry = href ? resolveHref(opfPath, href) : undefined;
      if (!entry) continue;
      const body = (await zip.read(entry, MAX_CHAPTER_BYTES))?.toString("utf8");
      if (!body) continue;
      const t = markupToText(body, MAX_TEXT_CHARS);
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
