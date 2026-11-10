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
 * a locale the bundle lacks falls back to en-US.
 */
import CSL from "citeproc";
import type { CslItem, LocatorLabel } from "./csl-map.js";
import { currentCslLoader, loadStyle, type CslLoader } from "./styles.js";

export type CitationFormat = "text" | "html" | "rtf";

export interface CitationItemInput {
  item: CslItem;
  locator?: string;
  label?: LocatorLabel;
}

interface CachedEngine {
  engine: InstanceType<typeof CSL.Engine>;
  items: Map<string, CslItem>;
}

const ENGINE_CACHE_MAX = 8;
const engines = new WeakMap<CslLoader, Map<string, CachedEngine>>();

function engineFor(loader: CslLoader, styleId: string, lang: string): CachedEngine {
  let byKey = engines.get(loader);
  if (!byKey) engines.set(loader, (byKey = new Map()));
  const key = `${styleId}\u0000${lang}`;
  const hit = byKey.get(key);
  if (hit) {
    byKey.delete(key);
    byKey.set(key, hit); // most recently used last
    return hit;
  }
  const items = new Map<string, CslItem>();
  const sys = {
    retrieveLocale: (l: string) => loader.localeXml(l) ?? loader.localeXml("en-US") ?? false,
    retrieveItem: (id: string) => items.get(id),
  };
  const engine = new CSL.Engine(sys, loadStyle(styleId, loader), lang, true);
  const made = { engine, items };
  byKey.set(key, made);
  if (byKey.size > ENGINE_CACHE_MAX) byKey.delete(byKey.keys().next().value!);
  return made;
}

function prepare(loader: CslLoader, styleId: string, format: CitationFormat, lang: string, list: CslItem[]): CachedEngine {
  const e = engineFor(loader, styleId, lang);
  e.items.clear();
  // citeproc-js annotates the objects it is given; hand it copies.
  for (const it of list) e.items.set(it.id, structuredClone(it));
  e.engine.setOutputFormat(format);
  e.engine.updateItems([...e.items.keys()]);
  return e;
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
  const e = prepare(loader, styleId, format, lang, items.map((i) => i.item));
  return e.engine.makeCitationCluster(
    items.map((i) => ({ id: i.item.id, ...(i.locator ? { locator: i.locator } : {}), ...(i.locator && i.label ? { label: i.label } : {}) })),
  );
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
  const e = prepare(loader, styleId, format, lang, items);
  const out = e.engine.makeBibliography();
  if (!out) return "";
  const [meta, entries] = out;
  if (format === "html") return `${meta.bibstart}${entries.join("")}${meta.bibend}`;
  return entries.map((x) => x.trim()).join("\n");
}
