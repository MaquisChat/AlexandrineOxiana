// @vitest-environment node
/**
 * pdf.js in the built app (Task R6): the pinned version, the files copied from it into
 * dist/pdfjs/, and their licence notices.
 *
 *  - The interface and the library pin the same pdfjs-dist, exactly (Global Constraints).
 *  - A real build (`vite build` into a temporary folder) has the character maps, the standard fonts,
 *    the colour profile and the image decoders' JavaScript fallbacks under pdfjs/, byte for byte as
 *    the pinned package ships them, and nothing else of it: no WebAssembly, no QuickJS (the
 *    scripting engine), no sandbox bundle anywhere in the build.
 *  - Every folder of pdfjs/ in the build carries its licence files, and the notices the desktop build
 *    collects for the interface's packages (apps/desktop/scripts/notices.mjs, R165) contain each of
 *    them whole. A folder of licensed assets copied without its notice fails here.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error: plain JavaScript build script without type declarations.
import { npmLicenceTexts, npmNotices } from "../../../apps/desktop/scripts/notices.mjs";
// @ts-expect-error: plain JavaScript build script without type declarations.
import { verifyVerbatim } from "../../../scripts/notices/licence-texts.mjs";
// @ts-expect-error: plain JavaScript build script without type declarations.
import { PDFJS_ASSET_DIRS, pdfjsAssetFiles, pdfjsDir, pdfjsLicenceFiles } from "../scripts/pdfjs-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const UI = join(here, "..");
const REPO = join(UI, "..", "..");

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as { version?: string; dependencies?: Record<string, string> };

/** Every file under `dir`, as paths relative to it with "/" separators. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

describe("pdfjs-dist version", () => {
  it("ui and library pin the same pdfjs-dist", () => {
    const ui = readJson(join(UI, "package.json")).dependencies?.["pdfjs-dist"];
    const lib = readJson(join(REPO, "packages", "library", "package.json")).dependencies?.["pdfjs-dist"];
    expect(ui, "packages/ui depends on pdfjs-dist").toBeDefined();
    expect(ui).toMatch(/^\d+\.\d+\.\d+$/); // exact, no range
    expect(ui).toBe(lib);
    // And what is installed for the interface is that version.
    const installed = readJson(createRequire(join(UI, "package.json")).resolve("pdfjs-dist/package.json")).version;
    expect(installed).toBe(ui);
  });
});

describe("the build's pdfjs/ folder", () => {
  let out = "";
  let dist = "";

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "ao-ui-build-"));
    dist = join(out, "dist");
    const vite = join(dirname(createRequire(join(UI, "package.json")).resolve("vite/package.json")), "bin", "vite.js");
    const r = spawnSync(process.execPath, [vite, "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: UI, encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } });
    if (r.status !== 0) throw new Error(`vite build failed:\n${r.stdout}\n${r.stderr}`);
  }, 300_000);

  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  it("the build has cmaps, standard fonts and the fallbacks under dist/pdfjs", () => {
    const pkg = pdfjsDir() as string;
    const built = filesUnder(join(dist, "pdfjs"));
    const expected = (pdfjsAssetFiles(pkg) as string[]).slice().sort();
    expect(built).toEqual(expected);
    // The folders pdf.js is pointed at (cMapUrl, standardFontDataUrl, wasmUrl, iccUrl).
    expect(PDFJS_ASSET_DIRS).toEqual(["cmaps", "standard_fonts", "wasm", "iccs"]);
    const count = (prefix: string, re: RegExp) => built.filter((f) => f.startsWith(prefix) && re.test(f)).length;
    expect(count("cmaps/", /\.bcmap$/)).toBe(readdirSync(join(pkg, "cmaps")).filter((f) => f.endsWith(".bcmap")).length);
    expect(count("cmaps/", /\.bcmap$/)).toBeGreaterThan(150);
    expect(count("standard_fonts/", /\.(pfb|ttf)$/)).toBe(14);
    expect(built).toContain("wasm/jbig2_nowasm_fallback.js");
    expect(built).toContain("wasm/openjpeg_nowasm_fallback.js");
    expect(built).toContain("iccs/CGATS001Compat-v2-micro.icc");
    // Byte for byte as the pinned package ships them.
    for (const f of built) expect(readFileSync(join(dist, "pdfjs", f)).equals(readFileSync(join(pkg, f))), f).toBe(true);
    // No WebAssembly (useWasm: false; no 'wasm-unsafe-eval'), no scripting engine, no sandbox, anywhere.
    const all = filesUnder(dist);
    expect(all.filter((f) => /\.wasm$|quickjs|sandbox/i.test(f))).toEqual([]);
  });

  it("every licensed asset in dist/pdfjs has its notice, verbatim, in the interface's licence texts", () => {
    const pkg = pdfjsDir() as string;
    const built = filesUnder(join(dist, "pdfjs"));
    const licences = (pdfjsLicenceFiles(pkg) as string[]).slice().sort();
    // Each folder of copied assets carries at least one licence file of its own, copied whole.
    const folders = [...new Set(built.map((f) => f.split("/")[0]!))].sort();
    expect(folders).toEqual([...PDFJS_ASSET_DIRS].sort());
    for (const folder of folders) {
      const assets = built.filter((f) => f.startsWith(`${folder}/`) && !licences.includes(f));
      const own = licences.filter((f) => f.startsWith(`${folder}/`));
      expect(assets.length, `${folder} has assets`).toBeGreaterThan(0);
      expect(own.length, `${folder} has its licence files`).toBeGreaterThan(0);
      for (const l of own) expect(built, `${l} is shipped with the assets`).toContain(l);
    }
    // The notices the desktop build writes for the interface (R165), from a `pnpm list` answer that
    // names pdfjs-dist: pdf.js is listed as Apache-2.0, and its own LICENSE and every licence file
    // of the copied folders are in the licence texts whole.
    const list = [{ dependencies: { "pdfjs-dist": { version: readJson(join(pkg, "package.json")).version, path: pkg } } }];
    const readPackage = (p: string) => JSON.parse(readFileSync(join(p, "package.json"), "utf8")) as unknown;
    expect(npmNotices(list, readPackage)).toEqual([{ name: "pdfjs-dist", version: "6.4.299", licence: "Apache-2.0" }]);
    const { text } = npmLicenceTexts(list, readPackage) as { text: string };
    const sources = ["LICENSE", ...licences].map((name) => ({ label: name, text: readFileSync(join(pkg, name), "utf8") }));
    expect(verifyVerbatim(text, sources)).toEqual([]);
  });
});
