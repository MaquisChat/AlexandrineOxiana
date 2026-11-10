/**
 * CSL styles and locales (spec 8.1, R86). Core never touches the file system: styles and locales
 * come from an injected `CslLoader`. `zipCslLoader` reads the bundle that scripts/fetch-csl.mjs
 * builds (`styles.zip`: styles/, dependent/, index.json, renamed-styles.json) with fflate (pure
 * JS), and locales through a callback; `withCustomStyles` adds a library's own imported styles.
 * `setCslLoader` sets the loader the module-level functions use (the app sets it once at start).
 *
 * Styles are CC BY-SA 3.0 (Citation Style Language project, citationstyles.org); see
 * packages/core/csl/NOTICE.md.
 */
import { strFromU8, unzipSync } from "fflate";

export interface StyleEntry {
  /** Style id: the file name without `.csl`, e.g. 'apa'. */
  id: string;
  title: string;
  /** Dependent styles: the id of the independent style whose rules they use (null if unknown). */
  parent?: string | null;
  /** Imported into this library (not bundled). */
  custom?: boolean;
}

export interface CslLoader {
  /** Every style this loader offers. */
  styles(): readonly StyleEntry[];
  /** A style's own XML (for a dependent style, the dependent file itself), or undefined. */
  styleXml(id: string): string | undefined;
  /** A locale's XML, by tag ('en-US', 'de-DE'; a bare language such as 'de' maps to its primary dialect). */
  localeXml(lang: string): string | undefined;
  /** Old style ids renamed upstream → current id. */
  renamed?(id: string): string | undefined;
}

export class UnknownStyleError extends Error {
  constructor(readonly styleId: string) {
    super(`Unknown citation style: ${styleId}`);
    this.name = "UnknownStyleError";
  }
}

export class CslBundleMissingError extends Error {
  constructor() {
    super("No citation styles are available (the CSL bundle is not set up)");
    this.name = "CslBundleMissingError";
  }
}

const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

/**
 * Reads the CSL bundle zip. Entries are inflated on demand (one style at a time) and cached.
 * `locale(fileName)` returns `locales-<tag>.xml` or `locales.json` from the bundle's locales folder.
 */
export function zipCslLoader(zip: Uint8Array, locale: (fileName: string) => string | undefined): CslLoader {
  const read = (name: string): string | undefined => {
    const out = unzipSync(zip, { filter: (f) => f.name === name });
    const bytes = own(out, name);
    return bytes ? strFromU8(bytes) : undefined;
  };
  const indexText = read("index.json");
  if (!indexText) throw new CslBundleMissingError();
  const raw = JSON.parse(indexText) as Array<{ id: string; title: string; file: string; parent?: string | null }>;
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  const entries: StyleEntry[] = [];
  for (const e of raw) {
    files[e.id] = e.file;
    entries.push(e.parent === undefined ? { id: e.id, title: e.title } : { id: e.id, title: e.title, parent: e.parent });
  }
  const renamedText = read("renamed-styles.json");
  const renamed: Record<string, string> = renamedText ? (JSON.parse(renamedText) as Record<string, string>) : {};
  const styleCache = new Map<string, string>();
  const localeCache = new Map<string, string | undefined>();
  let dialects: Record<string, string> | undefined;
  const primaryDialect = (lang: string): string | undefined => {
    if (!dialects) {
      try {
        const j = JSON.parse(locale("locales.json") ?? "{}") as { "primary-dialects"?: Record<string, string> };
        dialects = j["primary-dialects"] ?? {};
      } catch {
        dialects = {};
      }
    }
    return own(dialects, lang.toLowerCase());
  };
  return {
    styles: () => entries,
    styleXml(id) {
      const file = own(files, id);
      if (!file) return undefined;
      let xml = styleCache.get(id);
      if (xml === undefined) {
        xml = read(file);
        if (xml === undefined) return undefined;
        if (styleCache.size > 64) styleCache.clear();
        styleCache.set(id, xml);
      }
      return xml;
    },
    localeXml(lang) {
      if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) return undefined;
      if (localeCache.has(lang)) return localeCache.get(lang);
      let xml = locale(`locales-${lang}.xml`);
      if (xml === undefined && !lang.includes("-")) {
        const d = primaryDialect(lang);
        if (d) xml = locale(`locales-${d}.xml`);
      }
      localeCache.set(lang, xml);
      return xml;
    },
    renamed: (id) => own(renamed, id),
  };
}

/** `base` plus a library's imported styles (ids never shadow bundled ones: addCustomStyle guarantees distinct ids). */
export function withCustomStyles(base: CslLoader, custom: ReadonlyArray<{ id: string; title: string; xml: string; parent?: string | null }>): CslLoader {
  const byId = new Map(custom.map((c) => [c.id, c]));
  const entries: StyleEntry[] = [
    ...base.styles(),
    ...custom.filter((c) => !base.styleXml(c.id)).map((c) => ({ id: c.id, title: c.title, custom: true, ...(c.parent !== undefined ? { parent: c.parent } : {}) })),
  ];
  return {
    styles: () => entries,
    styleXml: (id) => base.styleXml(id) ?? byId.get(id)?.xml,
    localeXml: (lang) => base.localeXml(lang),
    renamed: (id) => base.renamed?.(id),
  };
}

let current: CslLoader | undefined;

/** Sets (or clears) the loader the module-level style and render functions use. */
export function setCslLoader(loader: CslLoader | undefined): void {
  current = loader;
}

export function currentCslLoader(): CslLoader {
  if (!current) throw new CslBundleMissingError();
  return current;
}

/**
 * Styles whose id or title contains every word of `query` (case-insensitive), sorted by title;
 * all styles without a query.
 */
export function listStyles(query?: string, loader: CslLoader = currentCslLoader()): StyleEntry[] {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return loader
    .styles()
    .filter((s) => {
      const hay = `${s.id} ${s.title}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => a.title.localeCompare(b.title, "en") || a.id.localeCompare(b.id))
    .map((s) => ({ ...s }));
}

/** The id of the independent parent named in a dependent style's XML, if it is one. */
export function dependentParentOf(xml: string): string | undefined {
  const info = /<info>([\s\S]*?)<\/info>/.exec(xml)?.[1] ?? "";
  for (const m of info.matchAll(/<link\b[^>]*>/g)) {
    const tag = m[0];
    if (!/\brel="independent-parent"/.test(tag)) continue;
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (href) return href.replace(/\/+$/, "").replace(/^.*\//, "");
  }
  return undefined;
}

/**
 * The XML citeproc-js renders with for `id`: the style itself, or, for a dependent style, its
 * independent parent. Renamed ids resolve to their current style. Throws UnknownStyleError.
 */
export function loadStyle(id: string, loader: CslLoader = currentCslLoader()): string {
  const resolved = loader.styleXml(id) !== undefined ? id : (loader.renamed?.(id) ?? id);
  const xml = loader.styleXml(resolved);
  if (xml === undefined) throw new UnknownStyleError(id);
  const parent = dependentParentOf(xml);
  if (parent === undefined) return xml;
  const parentXml = loader.styleXml(parent) ?? loader.styleXml(loader.renamed?.(parent) ?? "");
  if (parentXml === undefined || dependentParentOf(parentXml) !== undefined) throw new UnknownStyleError(id);
  return parentXml;
}
