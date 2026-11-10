/**
 * Citation styles for a library (spec 8.1, Task 28, R86): the bundled CSL styles (built by
 * scripts/fetch-csl.mjs into packages/core/csl/) plus the library's own imported styles in
 * `<Library>/styles/<id>.csl`.
 *
 * `addCustomStyle(repo, projectId, xml)` imports a style the researcher chose, from inside a
 * project (whose rules govern the write and whose audit log records it):
 *
 *   - refused before anything else: more than 1 MB (UTF-8 bytes); any `<!DOCTYPE` or `<!ENTITY`
 *     (no entity expansion, no external entities); markup that is not plainly well-formed (the
 *     linear pre-scan shared with Zotero RDF import); a root element that is not `<style>` in the
 *     CSL namespace (http://purl.org/net/xbiblio/csl); no `<info><id>` or `<info><title>`; an
 *     independent style without `<citation>`, or one citeproc-js cannot load; a dependent style
 *     whose independent parent is not a bundled or imported independent style.
 *   - governed: evaluated as a `store` with no identifiable data and no location
 *     (authorizeProcessing; a deny is audited and thrown as PolicyDeniedError).
 *   - ids: the last segment of the style's `<info><id>` URI, reduced to [a-z0-9-]. An id taken by
 *     a bundled style (or an upstream renamed id) gets `custom-` in front, so a bundled style is
 *     never shadowed or overwritten; an id taken by another file in styles/ gets `-2`, `-3` …
 *     (the same bytes again return the existing id, writing nothing).
 *   - written atomically, 0600 (styles/ created 0700), then audited as `style.add` with the id,
 *     sha256 and size (never the title or XML). Runs one at a time per library (in-process; the
 *     library lock keeps other processes out).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DOMParser, type Element } from "@xmldom/xmldom";
import {
  CslBundleMissingError,
  dependentParentOf,
  listStyles as coreListStyles,
  loadStyle,
  renderBibliography,
  renderCitation,
  withCustomStyles,
  zipCslLoader,
  type CslItem,
  type CslLoader,
  type StyleEntry,
} from "@ao/core";
import { writeSmallFileAtomic } from "../fs/atomic.js";
import { prescanXml } from "../import/zotero-rdf.js";
import type { Library } from "../library.js";
import { appendLibraryEvent, authorizeProcessing, type Repo } from "../repo/repo.js";
import { repoLibrary } from "../repo/repo.js";

export const CSL_NS = "http://purl.org/net/xbiblio/csl";
export const CUSTOM_STYLE_MAX_BYTES = 1024 * 1024;
const STYLES_DIR = "styles";
const MAX_ID = 80;

export class CustomStyleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomStyleError";
  }
}

const REASONS = {
  tooLarge: "This style file is larger than 1 MB, so it was not imported.",
  declaration: "This style file contains a DOCTYPE or ENTITY declaration, which styles never need, so it was not imported.",
  notWellFormed: "This file is not well-formed XML, so it is not a CSL style.",
  notCsl: "This file is not a CSL style (its root element must be <style> in the CSL namespace).",
  noId: "This CSL style has no id (<info><id>).",
  noTitle: "This CSL style has no title (<info><title>).",
  noCitation: "This CSL style has no <citation> section, so it cannot cite.",
  unusable: "This CSL style cannot be used: the citation processor could not load it.",
  unknownParent: "This dependent CSL style refers to a parent style that is neither bundled nor imported.",
} as const;

// ------------------------------------------------------------------------------------------
// The bundle

/** packages/core/csl/, next to @ao/core's sources. */
function bundleDir(): string {
  const corePackage = createRequire(import.meta.url).resolve("@ao/core/package.json");
  return join(dirname(corePackage), "csl");
}

/** Whether `pnpm fetch-csl` has built the bundle. */
export function bundleAvailable(): boolean {
  const dir = bundleDir();
  return existsSync(join(dir, "styles.zip")) && existsSync(join(dir, "locales", "locales-en-US.xml"));
}

let bundled: CslLoader | undefined;

/** The bundled styles and locales (read once). CslBundleMissingError when not built. */
export function bundledCslLoader(): CslLoader {
  if (bundled) return bundled;
  const dir = bundleDir();
  if (!bundleAvailable()) throw new CslBundleMissingError();
  const loader = zipCslLoader(new Uint8Array(readFileSync(join(dir, "styles.zip"))), (name) => {
    if (!/^locales(-[A-Za-z0-9-]+\.xml|\.json)$/.test(name)) return undefined;
    try {
      return readFileSync(join(dir, "locales", name), "utf8");
    } catch {
      return undefined;
    }
  });
  bundled = loader;
  return loader;
}

// ------------------------------------------------------------------------------------------
// Custom styles on disk

interface CustomStyle {
  id: string;
  title: string;
  xml: string;
  parent?: string | null;
}

const stylesDirOf = (lib: Pick<Library, "root">) => join(lib.root, STYLES_DIR);

/** The library's imported styles (files that no longer validate are skipped). */
export async function listCustomStyles(lib: Pick<Library, "root">): Promise<CustomStyle[]> {
  const dir = stylesDirOf(lib);
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((n) => /^[a-z0-9][a-z0-9-]*\.csl$/.test(n)).sort();
  } catch {
    return [];
  }
  const out: CustomStyle[] = [];
  for (const n of names) {
    try {
      const st = await fsp.lstat(join(dir, n));
      if (!st.isFile() || st.size > CUSTOM_STYLE_MAX_BYTES) continue;
      const xml = await fsp.readFile(join(dir, n), "utf8");
      const info = inspect(xml);
      out.push({ id: n.slice(0, -4), title: info.title, xml, ...(info.parent !== undefined ? { parent: info.parent } : {}) });
    } catch {
      // not a style we can offer
    }
  }
  return out;
}

/** The bundled styles plus the library's imported ones. */
export async function libraryCslLoader(lib: Pick<Library, "root">): Promise<CslLoader> {
  return withCustomStyles(bundledCslLoader(), await listCustomStyles(lib));
}

/** listStyles over the bundled and the library's imported styles (imported ones carry `custom: true`). */
export async function listStyles(lib: Pick<Library, "root">, query?: string): Promise<StyleEntry[]> {
  return coreListStyles(query, await libraryCslLoader(lib));
}

// ------------------------------------------------------------------------------------------
// Validation

const childrenNamed = (el: Element, name: string): Element[] => {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).localName === name && (n as Element).namespaceURI === CSL_NS) out.push(n as Element);
  }
  return out;
};

/** Checks the text is a CSL style; returns its id URI, title and (for a dependent style) parent id. */
function inspect(xml: string): { idUri: string; title: string; parent?: string; independent: boolean } {
  if (new TextEncoder().encode(xml).length > CUSTOM_STYLE_MAX_BYTES) throw new CustomStyleError(REASONS.tooLarge);
  if (/<!\s*(?:doctype|entity)/iu.test(xml)) throw new CustomStyleError(REASONS.declaration);
  const src = xml.replace(/^﻿/u, "");
  if (prescanXml(src) !== undefined) throw new CustomStyleError(REASONS.notWellFormed);
  let root: Element | null;
  try {
    root = new DOMParser({
      onError: (level: string) => {
        if (level !== "warning") throw new CustomStyleError(REASONS.notWellFormed);
      },
    }).parseFromString(src, "text/xml").documentElement;
  } catch {
    throw new CustomStyleError(REASONS.notWellFormed);
  }
  if (!root || root.localName !== "style" || root.namespaceURI !== CSL_NS) throw new CustomStyleError(REASONS.notCsl);
  const info = childrenNamed(root, "info")[0];
  const idUri = info ? childrenNamed(info, "id")[0]?.textContent?.trim() : undefined;
  if (!idUri) throw new CustomStyleError(REASONS.noId);
  const title = info ? childrenNamed(info, "title")[0]?.textContent?.trim() : undefined;
  if (!title) throw new CustomStyleError(REASONS.noTitle);
  const parentLink = info ? childrenNamed(info, "link").find((l) => l.getAttribute("rel") === "independent-parent") : undefined;
  if (parentLink) {
    const href = parentLink.getAttribute("href")?.trim().replace(/\/+$/, "") ?? "";
    const parent = href.replace(/^.*\//, "");
    if (!parent) throw new CustomStyleError(REASONS.unknownParent);
    return { idUri, title, parent, independent: false };
  }
  if (childrenNamed(root, "citation").length === 0) throw new CustomStyleError(REASONS.noCitation);
  return { idUri, title, independent: true };
}

function baseIdOf(idUri: string): string {
  const last = idUri.replace(/[?#].*$/u, "").replace(/\/+$/u, "").replace(/^.*\//u, "");
  const id = last
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_ID)
    .replace(/-+$/u, "");
  return id || "custom-style";
}

const PROBE_ID = "\u0000probe";
const PROBE_ITEM: CslItem = { id: "probe", type: "book", title: "Probe", issued: { "date-parts": [[2000]] }, author: [{ family: "Probe", given: "A" }] };

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// ------------------------------------------------------------------------------------------
// Import

const locks = new Map<string, Promise<unknown>>();

function serialFor<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(root) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.catch(() => {});
  locks.set(root, settled);
  void settled.then(() => {
    if (locks.get(root) === settled) locks.delete(root);
  });
  return next;
}

/** Imports a CSL style into `<Library>/styles/`; returns its style id. See the file comment. */
export async function addCustomStyle(repo: Repo, projectId: string, xml: string): Promise<string> {
  const info = inspect(xml);
  const base = bundledCslLoader(); // ids must stay clear of the bundled styles
  const lib = repoLibrary(repo);
  return serialFor(lib.root, async () => {
    const custom = await listCustomStyles(lib);
    const loader = withCustomStyles(base, custom);
    if (info.independent) {
      // citeproc-js must be able to load it (a style it cannot load could never render).
      const probe = withCustomStyles(base, [{ id: PROBE_ID, title: info.title, xml }]);
      let out: string;
      try {
        out = renderCitation([{ item: PROBE_ITEM, locator: "1", label: "page" }], PROBE_ID, "text", "en-US", probe) + renderBibliography([PROBE_ITEM], PROBE_ID, "text", "en-US", probe);
      } catch {
        throw new CustomStyleError(REASONS.unusable);
      }
      if (out.includes("CSL STYLE ERROR")) throw new CustomStyleError(REASONS.unusable);
    } else {
      try {
        loadStyle(info.parent!, loader);
        if (loader.styleXml(info.parent!) !== undefined && dependentParentOf(loader.styleXml(info.parent!)!) !== undefined) throw new Error("dependent parent");
      } catch {
        throw new CustomStyleError(REASONS.unknownParent);
      }
    }

    const dir = stylesDirOf(lib);
    const hash = sha256(xml);
    let id = baseIdOf(info.idUri);
    const bundledTaken = (x: string) => base.styleXml(x) !== undefined || base.renamed?.(x) !== undefined;
    if (bundledTaken(id)) id = `custom-${id}`.slice(0, MAX_ID + 7);
    const stem = id;
    for (let n = 2; ; n++) {
      if (bundledTaken(id)) {
        id = `${stem}-${n}`;
        continue;
      }
      const path = join(dir, `${id}.csl`);
      const existing = await fsp.readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? undefined : ""));
      if (existing === undefined) break; // free
      if (sha256(existing) === hash) return id; // the same style again
      id = `${stem}-${n}`;
    }

    await authorizeProcessing(repo, projectId, { action: "store", store: { identifiable: false, hasLocation: false } }, { op: "style.add" });
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `${id}.csl`);
    await writeSmallFileAtomic(target, xml, { mode: 0o600 });
    // Audited once the file exists: a failed write imported nothing.
    await appendLibraryEvent(repo, projectId, "style.add", { styleId: id, sha256: hash, bytes: Buffer.byteLength(xml, "utf8") });
    return id;
  });
}
