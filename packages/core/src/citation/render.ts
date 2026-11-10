/// <reference path="./citeproc.d.ts" />
/**
 * Citations and bibliographies with citeproc-js (`CSL.Engine`, npm `citeproc` pinned 2.4.63).
 *
 * Formats: 'text' (plain), 'html' (citeproc's html format: field values are escaped by citeproc,
 * `<` → `&#60;` etc.; the only markup is citeproc's own; the bibliography is wrapped in citeproc's
 * `csl-bib-body` div), 'rtf' (an RTF fragment for pasting into an RTF document: citeproc escapes
 * `\ { }` and writes non-ASCII as `\uN`). Nothing else is interpolated into the output.
 *
 * `lang` is forced over the style's default locale (citations follow the document's language);
 * a locale the bundle lacks, or a tag that is not one, falls back to en-US. Locators are reduced to
 * plain text first (cleanLocator). Every call starts from fresh engine state (R88 C1). Imported (custom)
 * styles are never rendered here: @ao/library renders them in a sandboxed worker (R88 I3), and
 * this module throws CustomStyleSandboxError for them.
 */
import CSL from "citeproc";
import type { CslItem, LocatorLabel } from "./csl-map.js";
import { CustomStyleSandboxError, currentCslLoader, resolveStyle, type CslLoader } from "./styles.js";

export type CitationFormat = "text" | "html" | "rtf";

export interface CitationItemInput {
  item: CslItem;
  locator?: string;
  label?: LocatorLabel;
}

/** A BCP-47-looking tag, else en-US (R88: an invalid lang never reaches citeproc). */
export function citationLang(lang: string | undefined): string {
  return typeof lang === "string" && lang.length <= 35 && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u.test(lang) ? lang : "en-US";
}

/**
 * A locator as plain text (R88 I4): markup-like parts (`<…>`) are removed and only letters, digits,
 * spaces and the punctuation locators use are kept, at most 64 characters, so nothing in a locator
 * can become html or rtf markup through citeproc's rich-text parsing. Undefined when nothing is left.
 */
export function cleanLocator(locator: string | undefined): string | undefined {
  if (!locator) return undefined;
  const t = locator
    .replace(/<[^>]*>/gu, "")
    .replace(/[^\p{L}\p{N}\s.,:;()\-–—/§+]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 64);
  return t || undefined;
}

/** Citation items as citeproc takes them: locators cleaned, labels only with a locator. */
export function citeprocCitationItems(items: CitationItemInput[]): Array<{ id: string; locator?: string; label?: string }> {
  return items.map((i) => {
    const locator = cleanLocator(i.locator);
    return { id: i.item.id, ...(locator ? { locator } : {}), ...(locator && i.label ? { label: i.label } : {}) };
  });
}

/** Joins makeBibliography's output: html in citeproc's own wrapper, text and rtf one entry per line. */
export function joinBibliography(out: [{ bibstart: string; bibend: string }, string[]] | false, format: CitationFormat): string {
  if (!out) return "";
  const [meta, entries] = out;
  if (format === "html") return `${meta.bibstart}${entries.join("")}${meta.bibend}`;
  return entries.map((x) => x.trim()).join("\n");
}

interface CachedEngine {
  engine: InstanceType<typeof CSL.Engine>;
  xml: string;
  items: Map<string, CslItem>;
}
const ENGINE_CACHE_MAX = 8;
const engines = new WeakMap<CslLoader, Map<string, CachedEngine>>();

/**
 * An engine with fresh state for this call (R88 C1). Building an engine costs about half a
 * second (style and locale set-up), so one is kept per loader, style and language; but citeproc-js
 * keeps rendered items in its registry by id, and a reused registry could show an item as it was
 * before an edit (a name since replaced by a participant code). So every call first empties the
 * item registry (updateItems([]), which also drops the name-disambiguation state) and the citation
 * state, then registers this call's items afresh. Items are copies (citeproc annotates them).
 */
function engineFor(loader: CslLoader, styleId: string, format: CitationFormat, lang: string, list: CslItem[]): InstanceType<typeof CSL.Engine> {
  const resolved = resolveStyle(styleId, loader);
  if (resolved.custom) throw new CustomStyleSandboxError(styleId);
  const tag = citationLang(lang);
  let byKey = engines.get(loader);
  if (!byKey) engines.set(loader, (byKey = new Map()));
  const key = `${resolved.id}\u0000${tag}`;
  let e = byKey.get(key);
  if (e && e.xml !== resolved.xml) e = undefined;
  if (e) byKey.delete(key);
  else {
    const items = new Map<string, CslItem>();
    const sys = {
      retrieveLocale: (l: string) => loader.localeXml(l) ?? loader.localeXml("en-US") ?? false,
      retrieveItem: (id: string) => items.get(id),
    };
    e = { engine: new CSL.Engine(sys, resolved.xml, tag, true), xml: resolved.xml, items };
  }
  byKey.set(key, e); // most recently used last
  if (byKey.size > ENGINE_CACHE_MAX) byKey.delete(byKey.keys().next().value!);
  const { engine, items } = e;
  items.clear();
  engine.updateItems([]);
  engine.restoreProcessorState([]);
  for (const it of list) items.set(it.id, structuredClone(it));
  engine.setOutputFormat(format);
  engine.updateItems([...items.keys()]);
  return engine;
}

/** One in-text citation (a cluster) of `items`, each with an optional locator. */
export function renderCitation(
  items: CitationItemInput[],
  styleId: string,
  format: CitationFormat,
  lang = "en-US",
  loader: CslLoader = currentCslLoader(),
): string {
  if (items.length === 0) return "";
  return engineFor(loader, styleId, format, lang, items.map((i) => i.item)).makeCitationCluster(citeprocCitationItems(items));
}

/** The bibliography of `items` in the style's order ('' for styles without a bibliography). */
export function renderBibliography(
  items: CslItem[],
  styleId: string,
  format: CitationFormat,
  lang = "en-US",
  loader: CslLoader = currentCslLoader(),
): string {
  if (items.length === 0) return "";
  return joinBibliography(engineFor(loader, styleId, format, lang, items).makeBibliography(), format);
}
