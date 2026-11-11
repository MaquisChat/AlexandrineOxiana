/**
 * The one place that finds the files the library and the service need besides their own code
 * (Task 37a): worker-thread scripts, SQL migrations, the citation style bundle, the citation
 * processor for the sandbox, the media worker's source folder (development only) and the
 * package's version.
 *
 * Two layouts:
 *   - source: running from the repository (tsx, Vitest). Paths are relative to this file, as they
 *     were in each caller before.
 *   - bundle: running from the folder `apps/library-service/scripts/build.mjs` produces. The build
 *     defines `__AO_BUNDLE__`; every path is then inside the folder that holds the bundled
 *     service (the folder of this code's `import.meta.url`), laid out as BUNDLE_LAYOUT says. The
 *     bundle never looks in a source tree or in a workspace's node_modules.
 *
 * A file missing from a built folder is a ResourceMissingError naming what is missing in plain
 * words, never the path (R96: an error can reach a client). The citation bundle is the exception:
 * its absence is reported by the caller as CslBundleMissingError, in both layouts, as before.
 *
 * Native modules (better-sqlite3, @napi-rs/keyring, @napi-rs/canvas) and the packages kept
 * outside the bundle are not resolved here: Node's own resolution finds them in the folder's
 * `node_modules/` (see the build script and ADR 0013).
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Set by the build (esbuild `define`); absent when running from source. */
declare const __AO_BUNDLE__: { libraryVersion: string } | undefined;

/** Where each resource sits inside a built folder (relative paths; the build script uses the same). */
export const BUNDLE_LAYOUT = {
  sandboxWorker: "workers/citation-sandbox-worker.mjs",
  htmlStripWorker: "workers/html-strip-worker.mjs",
  migrations: "migrations",
  csl: "csl",
} as const;

export class ResourceMissingError extends Error {
  constructor(what: string) {
    super(`The library service cannot start part of its work: ${what} is missing from the installation. Reinstall the app.`);
    this.name = "ResourceMissingError";
  }
}

export interface ResourceRoots {
  layout: "source" | "bundle";
  /** The folder resources are found under (source: the library package's src/). */
  root: string;
}

export interface Resolver {
  roots(): ResourceRoots;
  /** The citation-style sandbox's worker script (citation/sandbox.ts). */
  sandboxWorkerUrl(): URL;
  /** The HTML snapshot cleaner's worker script (capture/browser-capture.ts). */
  htmlStripWorkerUrl(): URL;
  /** The folder of the index's SQL migrations, as a URL ending in "/" (index/db.ts). */
  migrationsUrl(): URL;
  /** The folder holding styles.zip and locales/ (citation/custom-styles.ts); not checked here. */
  cslBundleDir(): string;
  /** A file to `createRequire` from so that `require("citeproc")` finds the citation processor. */
  citeprocRequireFrom(): string;
  /** The media worker's source folder (its dev venv); undefined in a built folder. */
  mediaWorkerSourceDir(): string | undefined;
  libraryVersion(): string;
}

/** Resources found relative to this source file (the repository). */
export function sourceResolver(): Resolver {
  const here = (rel: string) => new URL(rel, import.meta.url);
  const corePackageJson = () => createRequire(import.meta.url).resolve("@ao/core/package.json");
  let version: string | undefined;
  return {
    roots: () => ({ layout: "source", root: fileURLToPath(here("./")).replace(/[\\/]$/, "") }),
    sandboxWorkerUrl: () => here("./citation/sandbox-worker.mjs"),
    htmlStripWorkerUrl: () => here("./capture/html-strip-worker.mjs"),
    migrationsUrl: () => here("./index/migrations/"),
    cslBundleDir: () => join(dirname(corePackageJson()), "csl"),
    citeprocRequireFrom: corePackageJson,
    mediaWorkerSourceDir: () => fileURLToPath(here("../../../services/media-worker/")).replace(/[\\/]$/, ""),
    libraryVersion: () => (version ??= (JSON.parse(readFileSync(here("../package.json"), "utf8")) as { version: string }).version),
  };
}

/** Resources found inside a built folder `root` (the folder of the bundled service). */
export function bundleResolver(root: string, info: { libraryVersion: string }): Resolver {
  const need = (rel: string, what: string): string => {
    const p = join(root, rel);
    if (!existsSync(p)) throw new ResourceMissingError(what);
    return p;
  };
  return {
    roots: () => ({ layout: "bundle", root }),
    sandboxWorkerUrl: () => pathToFileURL(need(BUNDLE_LAYOUT.sandboxWorker, "the citation style sandbox")),
    htmlStripWorkerUrl: () => pathToFileURL(need(BUNDLE_LAYOUT.htmlStripWorker, "the web page cleaner")),
    migrationsUrl: () => pathToFileURL(need(BUNDLE_LAYOUT.migrations, "the index database's set-up files") + "/"),
    cslBundleDir: () => join(root, BUNDLE_LAYOUT.csl),
    citeprocRequireFrom: () => {
      need(join("node_modules", "citeproc", "package.json"), "the citation processor (citeproc)");
      // A file directly in the folder: require("citeproc") from it looks in <root>/node_modules only.
      return join(root, "package.json");
    },
    mediaWorkerSourceDir: () => undefined,
    libraryVersion: () => info.libraryVersion,
  };
}

let current: Resolver | undefined;
function resolver(): Resolver {
  if (current) return current;
  current =
    typeof __AO_BUNDLE__ !== "undefined" && __AO_BUNDLE__
      ? bundleResolver(dirname(fileURLToPath(import.meta.url)), __AO_BUNDLE__)
      : sourceResolver();
  return current;
}

export const resourceRoots = (): ResourceRoots => resolver().roots();
export const sandboxWorkerUrl = (): URL => resolver().sandboxWorkerUrl();
export const htmlStripWorkerUrl = (): URL => resolver().htmlStripWorkerUrl();
export const migrationsUrl = (): URL => resolver().migrationsUrl();
export const cslBundleDir = (): string => resolver().cslBundleDir();
export const citeprocRequireFrom = (): string => resolver().citeprocRequireFrom();
export const mediaWorkerSourceDir = (): string | undefined => resolver().mediaWorkerSourceDir();
export const libraryVersion = (): string => resolver().libraryVersion();
