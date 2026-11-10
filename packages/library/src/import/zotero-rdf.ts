/**
 * Zotero RDF export for Bulk Import (spec 5.4; Task 24, R65). Provenance `zotero_import` (R66).
 *
 * Safety: the file is first checked by a linear scan that refuses any document type or entity
 * declaration (`<!DOCTYPE`, `<!ENTITY`: no entity expansion, no external entities, no "billion
 * laughs"), and anything that is not plainly well-formed markup — an unclosed tag, comment, CDATA
 * section or attribute value, "<" inside an attribute value, nesting deeper than 256 elements or
 * more than 256 attributes on one element. Only then is it parsed with @xmldom/xmldom (whose
 * own scanner is quadratic on some malformed input, e.g. a long run of "<"), with every parser
 * error treated as fatal.
 *
 * Mapping: `bib:Article`, `bib:Book`, `bib:BookSection` (and any other top-level node that carries a
 * `z:itemType` other than attachment/note) become items; their `link:link` references to
 * `z:Attachment` nodes give the files (the attachment's `rdf:resource`, relative to the export
 * file); `dc:subject` (plain or `z:AutomaticTag`) become tags; membership of `z:Collection` nodes
 * (nested through `dcterms:hasPart`) becomes `folderPath` (the first collection in document order
 * when an item is in several). A `z:Attachment` that no item links to is an item of its own.
 * Citation keys come from `z:citationKey` or a "Citation Key: …" line in `dc:description` (Better
 * BibTeX keeps them in Zotero's Extra field).
 */
import { createHash } from "node:crypto";
import { DOMParser, type Element } from "@xmldom/xmldom";
import type { Creator, SourceType } from "@ao/core";
import type { ImportSourceAdapter } from "./bulk/scan.js";
import {
  ExportUnreadable,
  MAX_EXPORT_RECORDS,
  REFMAN_REASONS,
  doiOf,
  exportAdapter,
  isbnsOf,
  issnOf,
  recordItem,
  linkFromPath,
  tagList,
  text,
  type RecordFields,
} from "./refman.js";

const NS = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  z: "http://www.zotero.org/namespaces/export#",
  dc: "http://purl.org/dc/elements/1.1/",
  dcterms: "http://purl.org/dc/terms/",
  bib: "http://purl.org/net/biblio#",
  foaf: "http://xmlns.com/foaf/0.1/",
  link: "http://purl.org/rss/1.0/modules/link/",
} as const;

export const RDF_REASONS = {
  declaration: "The export file contains a document type or entity declaration, which is not allowed for safety, so nothing was imported from it.",
} as const;

const MAX_DEPTH = 256;
const MAX_ATTRS = 256;
/**
 * Before a DOM is built (R70): top-level nodes ≤ MAX_EXPORT_RECORDS and elements in all ≤ 500,000
 * (an xmldom element with its text costs about 1 KB, so this keeps a parse within a few hundred MB).
 */
const MAX_ELEMENTS = 500_000;
const MAX_COLLECTION_DEPTH = 64;
const CALL_NUMBERS = new Set(["LCC", "DDC", "UDC"]);
const MAX_ABOUT_KEY = 256;

/** An rdf:about as an item key: longer than 256 characters → `about-<sha256>` (keys stay short). */
const keyOfAbout = (about: string) => (about.length > MAX_ABOUT_KEY ? `about-${createHash("sha256").update(about).digest("hex")}` : about);

const isNameStart = (c: string | undefined) => !!c && (/[A-Za-z_:]/u.test(c) || c.charCodeAt(0) > 0x7f);
const isNameChar = (c: string | undefined) => !!c && (/[A-Za-z0-9_.:-]/u.test(c) || c.charCodeAt(0) > 0x7f);
const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * Linear well-formedness pre-check: undefined when the text may be handed to the XML parser, else
 * the plain reason it is refused. Every step moves forward; nothing is scanned twice.
 */
export function prescanXml(src: string): string | undefined {
  const bad = REFMAN_REASONS.unreadable;
  if (/<!\s*(?:doctype|entity)/iu.test(src)) return RDF_REASONS.declaration;
  let i = 0;
  let depth = 0;
  let elements = 0;
  let top = 0;
  const n = src.length;
  for (;;) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    const c = src[lt + 1];
    if (c === "!") {
      if (src.startsWith("<!--", lt)) {
        const e = src.indexOf("-->", lt + 4);
        if (e < 0) return bad;
        i = e + 3;
        continue;
      }
      if (src.startsWith("<![CDATA[", lt)) {
        const e = src.indexOf("]]>", lt + 9);
        if (e < 0) return bad;
        i = e + 3;
        continue;
      }
      const word = src.slice(lt + 2, lt + 9).toUpperCase();
      return word.startsWith("DOCTYPE") || word.startsWith("ENTITY") ? RDF_REASONS.declaration : bad;
    }
    if (c === "?") {
      const e = src.indexOf("?>", lt + 2);
      if (e < 0) return bad;
      i = e + 2;
      continue;
    }
    let j = lt + 1;
    const end = c === "/";
    if (end) j++;
    if (!isNameStart(src[j])) return bad;
    while (j < n && isNameChar(src[j])) j++;
    let attrs = 0;
    let self = false;
    for (;;) {
      while (isWs(src[j])) j++;
      const d = src[j];
      if (d === ">") {
        j++;
        break;
      }
      if (d === "/" && !end && src[j + 1] === ">") {
        self = true;
        j += 2;
        break;
      }
      if (end || !isNameStart(d)) return bad;
      while (j < n && isNameChar(src[j])) j++;
      while (isWs(src[j])) j++;
      if (src[j] !== "=") return bad;
      j++;
      while (isWs(src[j])) j++;
      const q = src[j];
      if (q !== '"' && q !== "'") return bad;
      j++;
      while (j < n && src[j] !== q) {
        if (src[j] === "<") return bad;
        j++;
      }
      if (j >= n) return bad;
      j++;
      if (++attrs > MAX_ATTRS) return bad;
    }
    if (!end) {
      if (++elements > MAX_ELEMENTS || (depth === 1 && ++top > MAX_EXPORT_RECORDS)) return REFMAN_REASONS.tooMany;
    }
    if (end) depth--;
    else if (!self && ++depth > MAX_DEPTH) return bad;
    if (depth < 0) return bad;
    i = j;
  }
  return undefined;
}

/** The parsed document's root element, or ExportUnreadable. */
export function parseRdf(src: string): Element {
  const refused = prescanXml(src);
  if (refused) throw new ExportUnreadable(refused);
  let doc;
  try {
    doc = new DOMParser({
      onError: (level: string) => {
        if (level !== "warning") throw new ExportUnreadable(REFMAN_REASONS.unreadable);
      },
    }).parseFromString(src, "text/xml");
  } catch {
    throw new ExportUnreadable(REFMAN_REASONS.unreadable);
  }
  const root = doc.documentElement;
  if (!root || root.namespaceURI !== NS.rdf || root.localName !== "RDF") throw new ExportUnreadable(REFMAN_REASONS.unreadable);
  return root;
}

const is = (e: Element, ns: string, local: string) => e.namespaceURI === ns && e.localName === local;

function* children(e: Element, ns?: string, local?: string): Generator<Element> {
  for (let c = e.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue;
    const el = c as Element;
    if (ns === undefined || (local !== undefined ? is(el, ns, local) : el.namespaceURI === ns)) yield el;
  }
}
const child = (e: Element, ns: string, local: string) => children(e, ns, local).next().value as Element | undefined;
const content = (e: Element | undefined) => (e ? text(e.textContent ?? "") : "");
const childText = (e: Element, ns: string, local: string) => content(child(e, ns, local));
const resourceOf = (e: Element) => e.getAttributeNS(NS.rdf, "resource") ?? "";
const aboutOf = (e: Element) => e.getAttributeNS(NS.rdf, "about") ?? "";

const ITEM_TYPES: Record<string, SourceType> = {
  journalArticle: "article-journal", magazineArticle: "article-journal", newspaperArticle: "article-journal",
  conferencePaper: "article-journal", book: "book", bookSection: "chapter", encyclopediaArticle: "chapter",
  dictionaryEntry: "chapter", thesis: "thesis", report: "report", webpage: "webpage", blogPost: "webpage",
  forumPost: "social-post", preprint: "preprint", manuscript: "manuscript", presentation: "presentation",
  dataset: "dataset", interview: "interview", videoRecording: "video", film: "video", tvBroadcast: "video",
  audioRecording: "audio", podcast: "audio", radioBroadcast: "audio", artwork: "image", map: "image",
  document: "other", letter: "manuscript",
};
const ELEMENT_TYPES: Record<string, SourceType> = { Article: "article-journal", Book: "book", BookSection: "chapter" };

const CREATOR_LISTS: Array<[string, string, Creator["role"]]> = [
  [NS.bib, "authors", "author"],
  [NS.bib, "editors", "editor"],
  [NS.z, "translators", "translator"],
  [NS.bib, "contributors", "contributor"],
  [NS.z, "interviewers", "interviewer"],
  [NS.z, "interviewees", "interviewee"],
];

function creatorsOf(item: Element): Creator[] {
  const out: Creator[] = [];
  for (const [ns, local, role] of CREATOR_LISTS) {
    for (const list of children(item, ns, local)) {
      for (const seq of children(list, NS.rdf)) {
        for (const li of children(seq, NS.rdf, "li")) {
          for (const p of children(li)) {
            const family = childText(p, NS.foaf, "surname") || childText(p, NS.foaf, "family_name");
            const given = childText(p, NS.foaf, "givenName") || childText(p, NS.foaf, "givenname");
            const name = childText(p, NS.foaf, "name");
            if (family) out.push(given ? { family, given, role } : { family, role });
            else if (name || given) out.push({ literal: name || given, role });
            if (out.length >= 1000) return out;
          }
        }
      }
    }
  }
  return out;
}

/** "DOI 10…", "ISBN …", "ISSN …" texts and dcterms:URI values of a node's dc:identifier children. */
function identifiersOf(node: Element, f: RecordFields): void {
  const isbns: string[] = [];
  for (const id of children(node, NS.dc, "identifier")) {
    const uri = child(id, NS.dcterms, "URI");
    if (uri) {
      const v = childText(uri, NS.rdf, "value");
      if (v && !f.url) f.url = v;
      continue;
    }
    const v = content(id);
    const sp = v.indexOf(" ");
    const label = sp > 0 ? v.slice(0, sp).toUpperCase() : "";
    const rest = sp > 0 ? v.slice(sp + 1) : v;
    if (label === "DOI") f.doi ??= doiOf(rest);
    else if (label === "ISBN") isbns.push(rest);
    else if (label === "ISSN") f.issn ??= issnOf(rest);
    else if (!f.doi && doiOf(v)) f.doi = doiOf(v);
  }
  const about = aboutOf(node);
  if (about.toLowerCase().startsWith("urn:isbn:")) isbns.push(about.slice(9));
  if (about.toLowerCase().startsWith("urn:issn:")) f.issn ??= issnOf(about.slice(9));
  if (isbns.length) f.isbn = [...new Set([...(f.isbn ?? []), ...isbnsOf(isbns)])];
}

function citekeyOf(item: Element): string | undefined {
  const direct = childText(item, NS.z, "citationKey");
  if (direct) return direct.slice(0, 1000);
  for (const d of children(item, NS.dc, "description")) {
    for (const line of (d.textContent ?? "").slice(0, 64 * 1024).split("\n")) {
      const t = line.trim();
      if (t.toLowerCase().startsWith("citation key:")) {
        const k = text(t.slice(13));
        if (k) return k.slice(0, 1000);
      }
    }
  }
  return undefined;
}

interface RdfRecord {
  key: string;
  fields: RecordFields;
  files: string[];
  folderPath: string[];
}

/** Items of a Zotero RDF export (see the module comment). */
export function rdfRecords(src: string): RdfRecord[] {
  const root = parseRdf(src);
  const byAbout = new Map<string, Element>();
  const tops: Element[] = [];
  for (const e of children(root)) {
    tops.push(e);
    const a = aboutOf(e);
    if (a && !byAbout.has(a)) byAbout.set(a, e);
  }
  // Collections: names, parents, and the first collection (document order) of each member.
  const collName = new Map<string, string>();
  const parent = new Map<string, string>();
  const firstColl = new Map<string, string>();
  for (const e of tops) {
    if (!is(e, NS.z, "Collection")) continue;
    const id = aboutOf(e);
    if (!id) continue;
    collName.set(id, childText(e, NS.dc, "title").slice(0, 200) || "Untitled");
    for (const part of children(e, NS.dcterms, "hasPart")) {
      const r = resourceOf(part);
      if (!r) continue;
      const target = byAbout.get(r);
      if (target && is(target, NS.z, "Collection")) {
        if (!parent.has(r) && r !== id) parent.set(r, id);
      } else if (!firstColl.has(r)) firstColl.set(r, id);
    }
  }
  const pathCache = new Map<string, string[]>();
  const collPath = (id: string): string[] => {
    const cached = pathCache.get(id);
    if (cached) return cached;
    const chain: string[] = [];
    const seen = new Set<string>();
    for (let c: string | undefined = id; c && !seen.has(c) && chain.length < MAX_COLLECTION_DEPTH; c = parent.get(c)) {
      seen.add(c);
      chain.push(collName.get(c) ?? "Untitled");
    }
    const out = chain.reverse();
    pathCache.set(id, out);
    return out;
  };

  const attachmentPath = (a: Element) => {
    const res = child(a, NS.rdf, "resource");
    return res ? resourceOf(res) : "";
  };
  const linked = new Set<string>();
  const out: RdfRecord[] = [];
  for (const e of tops) {
    const itemType = childText(e, NS.z, "itemType");
    const isBibType = e.namespaceURI === NS.bib && ELEMENT_TYPES[e.localName ?? ""] !== undefined;
    if (is(e, NS.z, "Attachment") || is(e, NS.z, "Collection") || itemType === "attachment" || itemType === "note") continue;
    if (!isBibType && !itemType) continue;
    const f: RecordFields = { type: ITEM_TYPES[itemType] ?? ELEMENT_TYPES[e.localName ?? ""] ?? "other" };
    const title = childText(e, NS.dc, "title");
    if (title) f.title = title;
    const creators = creatorsOf(e);
    if (creators.length) f.creators = creators;
    const date = childText(e, NS.dc, "date");
    if (date) f.issued = date;
    const pub = child(e, NS.dc, "publisher");
    if (pub) {
      const org = children(pub).next().value as Element | undefined;
      const name = org ? childText(org, NS.foaf, "name") : content(pub);
      if (name) f.publisher = name;
    }
    identifiersOf(e, f);
    for (const part of children(e, NS.dcterms, "isPartOf")) {
      const r = resourceOf(part);
      const node = r ? byAbout.get(r) : (children(part).next().value as Element | undefined);
      if (!node || is(node, NS.bib, "Series")) continue;
      const t = childText(node, NS.dc, "title");
      if (t && !f.container) f.container = t;
      identifiersOf(node, f);
      if (f.container) break;
    }
    // The container's ISBN (a chapter's book) is not the item's own.
    if (f.type === "chapter" || f.type === "article-journal") delete f.isbn;
    const citekey = citekeyOf(e);
    if (citekey) f.citekey = citekey;
    const tags = tagList(
      (function* () {
        for (const s of children(e, NS.dc, "subject")) {
          const inner = children(s).next().value as Element | undefined;
          // Library call numbers (dcterms:LCC, DDC, UDC) are not tags.
          if (inner && inner.namespaceURI === NS.dcterms && CALL_NUMBERS.has(inner.localName ?? "")) continue;
          yield inner ? childText(inner, NS.rdf, "value") || content(inner) : content(s);
        }
      })(),
    );
    if (tags.length) f.tags = tags;
    const files: string[] = [];
    for (const l of children(e, NS.link, "link")) {
      const r = resourceOf(l);
      if (!r) continue;
      const a = byAbout.get(r);
      if (a && is(a, NS.z, "Attachment")) {
        linked.add(r);
        const p = attachmentPath(a);
        if (p) files.push(p);
      } else if (!a) files.push(r);
      if (files.length >= 50) break;
    }
    const about = aboutOf(e);
    const coll = firstColl.get(about);
    out.push({ key: citekey ?? keyOfAbout(about), fields: f, files, folderPath: coll ? collPath(coll) : [] });
  }
  // Stand-alone attachments.
  for (const e of tops) {
    if (!is(e, NS.z, "Attachment")) continue;
    const about = aboutOf(e);
    if (linked.has(about)) continue;
    const p = attachmentPath(e);
    if (!p) continue;
    const f: RecordFields = {};
    const title = childText(e, NS.dc, "title");
    if (title) f.title = title;
    const tags = tagList([...children(e, NS.dc, "subject")].map((s) => content(s)));
    if (tags.length) f.tags = tags;
    const coll = firstColl.get(about);
    out.push({ key: keyOfAbout(about), fields: f, files: [p], folderPath: coll ? collPath(coll) : [] });
  }
  return out;
}

/** Zotero RDF export (Zotero's "Export Library…" → Zotero RDF, with files). */
export function zoteroRdfAdapter(path: string): ImportSourceAdapter {
  return exportAdapter("zotero-rdf", path, rdfRecords, async (r, keys, baseDir) =>
    recordItem(keys.next(r.key || undefined), r.fields, r.files.map((p) => linkFromPath(p, baseDir)), { folderPath: r.folderPath }),
  );
}
