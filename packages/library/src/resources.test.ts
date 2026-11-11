import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUNDLE_LAYOUT,
  ResourceMissingError,
  bundleResolver,
  citeprocRequireFrom,
  cslBundleDir,
  htmlStripWorkerUrl,
  libraryVersion,
  mediaWorkerSourceDir,
  migrationsUrl,
  resourceRoots,
  sandboxWorkerUrl,
  sourceResolver,
} from "./resources.js";

const PKG_DIR = fileURLToPath(new URL("../", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), "ao-resources-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("resources: running from the source tree", () => {
  it("reports the source layout rooted at the repository's library package", () => {
    const r = resourceRoots();
    expect(r.layout).toBe("source");
    expect(r.root + sep).toBe(join(PKG_DIR, "src") + sep);
  });

  it("finds each worker-thread script, the migrations and the citation bundle where they are today", () => {
    expect(fileURLToPath(sandboxWorkerUrl())).toBe(join(PKG_DIR, "src", "citation", "sandbox-worker.mjs"));
    expect(fileURLToPath(htmlStripWorkerUrl())).toBe(join(PKG_DIR, "src", "capture", "html-strip-worker.mjs"));
    expect(existsSync(new URL("0001.sql", migrationsUrl()))).toBe(true);
    expect(cslBundleDir()).toBe(join(REPO, "packages", "core", "csl"));
    expect(existsSync(citeprocRequireFrom())).toBe(true);
    expect(mediaWorkerSourceDir()).toBe(join(REPO, "services", "media-worker"));
  });

  it("gives the library package's version", () => {
    expect(libraryVersion()).toBe((JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as { version: string }).version);
  });

  it("the source resolver of an explicit folder says it is the source layout", () => {
    expect(sourceResolver().roots().layout).toBe("source");
  });
});

describe("resources: running from a built folder", () => {
  const root = join(tmp, "built");
  const make = (rel: string, body = "x") => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  make(BUNDLE_LAYOUT.sandboxWorker);
  make(BUNDLE_LAYOUT.htmlStripWorker);
  make(join(BUNDLE_LAYOUT.migrations, "0001.sql"), "-- sql");
  make(join(BUNDLE_LAYOUT.csl, "styles.zip"));
  make(join(BUNDLE_LAYOUT.csl, "locales", "locales-en-US.xml"));
  make(join("node_modules", "citeproc", "package.json"), "{}");
  const r = bundleResolver(root, { libraryVersion: "9.9.9" });

  it("finds everything inside its own folder, never in a source tree", () => {
    expect(r.roots()).toEqual({ layout: "bundle", root });
    const inside = (p: string) => expect(p.startsWith(root + sep)).toBe(true);
    inside(fileURLToPath(r.sandboxWorkerUrl()));
    inside(fileURLToPath(r.htmlStripWorkerUrl()));
    inside(fileURLToPath(r.migrationsUrl()));
    expect(statSync(fileURLToPath(r.migrationsUrl())).isDirectory()).toBe(true);
    inside(r.cslBundleDir());
    inside(r.citeprocRequireFrom());
    expect(r.libraryVersion()).toBe("9.9.9");
  });

  it("has no media worker of its own: the worker comes from configuration (AO_WORKER_BIN)", () => {
    expect(r.mediaWorkerSourceDir()).toBeUndefined();
  });

  it("fails with a plain error naming what is missing, without a path", () => {
    const empty = join(tmp, "empty");
    mkdirSync(empty);
    const e = bundleResolver(empty, { libraryVersion: "1.0.0" });
    const cases: Array<[() => unknown, RegExp]> = [
      [() => e.sandboxWorkerUrl(), /citation style sandbox/],
      [() => e.htmlStripWorkerUrl(), /web page cleaner/],
      [() => e.migrationsUrl(), /index database/],
      [() => e.citeprocRequireFrom(), /citation processor/],
    ];
    for (const [fn, what] of cases) {
      let err: unknown;
      try {
        fn();
      } catch (x) {
        err = x;
      }
      expect(err).toBeInstanceOf(ResourceMissingError);
      const msg = (err as Error).message;
      expect(msg).toMatch(what);
      expect(msg).toMatch(/missing from the installation/);
      expect(msg).not.toContain(tmp);
      expect(msg).not.toContain(sep + "empty");
    }
  });

  it("an absent citation bundle is left to the caller (CslBundleMissingError, as from source)", () => {
    const e = bundleResolver(join(tmp, "empty"), { libraryVersion: "1.0.0" });
    expect(e.cslBundleDir().startsWith(join(tmp, "empty") + sep)).toBe(true);
  });
});
