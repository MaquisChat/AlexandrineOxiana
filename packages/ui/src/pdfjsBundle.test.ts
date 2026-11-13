// @vitest-environment node
/**
 * pdf.js in the built app (Task R6, A6): the pinned version, the files copied from it into
 * dist/pdfjs/, and their licence notices.
 *
 *  - The interface and the library pin the same pdfjs-dist, exactly (Global Constraints).
 *  - A real build (`vite build` into a temporary folder) has the character maps, the two standard
 *    fonts pdf.js reads with useSystemFonts (Symbol, ZapfDingbats) and the image decoders' JavaScript
 *    fallbacks under pdfjs/, byte for byte as the pinned package ships them, and nothing else of it:
 *    no Liberation Sans (GPL, R199), no iccs/, no WebAssembly, no QuickJS, no sandbox anywhere.
 *  - Every shipped asset, one by one, is covered by a licence file that is shipped beside it and is
 *    whole in the notices the desktop build collects for the interface (R165); every shipped licence
 *    covers a shipped asset; core-js (MIT), bundled inside pdf.js's legacy build, is listed with its
 *    licence text.
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
import { loadStandardTexts, verifyVerbatim } from "../../../scripts/notices/licence-texts.mjs";
// @ts-expect-error: plain JavaScript build script without type declarations.
import { licencesOfAsset, PDFJS_CODE_LICENCES, PDFJS_FORBIDDEN, pdfjsDir } from "../scripts/pdfjs-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const UI = join(here, "..");
const REPO = join(UI, "..", "..");

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as { version?: string; dependencies?: Record<string, string> };
const isLicenceName = (path: string) => /^LICEN[CS]E/.test(path.slice(path.lastIndexOf("/") + 1));

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

/** The interface's licence texts as the desktop build writes them, for a `pnpm list` naming only pdfjs-dist. */
function interfaceNotices(pkg: string): { list: Array<{ name: string; version: string; licence: string }>; text: string } {
  const list = [{ dependencies: { "pdfjs-dist": { version: readJson(join(pkg, "package.json")).version, path: pkg } } }];
  const readPackage = (p: string) => JSON.parse(readFileSync(join(p, "package.json"), "utf8")) as unknown;
  return { list: npmNotices(list, readPackage), text: (npmLicenceTexts(list, readPackage) as { text: string }).text };
}

/**
 * What is wrong with the licences of a built pdfjs/ folder (`built`: its files; `read`: a shipped
 * licence file's text; `notices`: the interface's licence texts). Empty when every asset is covered.
 */
function licenceProblems(built: string[], read: (path: string) => string, notices: string): string[] {
  const problems: string[] = [];
  const shippedLicences = built.filter(isLicenceName);
  const used = new Set<string>();
  for (const f of built) {
    if (PDFJS_FORBIDDEN.test(f)) problems.push(`${f} must not be shipped`);
    if (isLicenceName(f)) continue;
    const licences = (licencesOfAsset(f) as string[] | undefined) ?? [];
    if (!licences.length) problems.push(`${f} is shipped with no licence that covers it`);
    for (const l of licences) {
      used.add(l);
      if (!built.includes(l)) problems.push(`${f}: its licence ${l} is not shipped beside it`);
      else if (verifyVerbatim(notices, [{ label: l, text: read(l) }]).length) problems.push(`${f}: its licence ${l} is not whole in the notices`);
    }
  }
  for (const l of shippedLicences) if (!used.has(l)) problems.push(`${l} is shipped but covers no shipped asset`);
  if (/LIBERATION FONT SOFTWARE|LiberationSans/.test(notices)) problems.push("the notices carry Liberation Sans");
  return problems;
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
    const bcmaps = readdirSync(join(pkg, "cmaps")).filter((f) => f.endsWith(".bcmap")).map((f) => `cmaps/${f}`);
    expect(bcmaps.length).toBeGreaterThan(150);
    // Exactly these, named here rather than derived from the list the build itself uses.
    expect(built).toEqual(
      [
        ...bcmaps,
        "cmaps/LICENSE",
        "standard_fonts/FoxitDingbats.pfb",
        "standard_fonts/FoxitSymbol.pfb",
        "standard_fonts/LICENSE_FOXIT",
        "wasm/LICENSE_JBIG2",
        "wasm/LICENSE_OPENJPEG",
        "wasm/LICENSE_PDFJS_JBIG2",
        "wasm/LICENSE_PDFJS_OPENJPEG",
        "wasm/jbig2_nowasm_fallback.js",
        "wasm/openjpeg_nowasm_fallback.js",
      ].sort(),
    );
    // Byte for byte as the pinned package ships them.
    for (const f of built) expect(readFileSync(join(dist, "pdfjs", f)).equals(readFileSync(join(pkg, f))), f).toBe(true);
    // No GPL font, no colour profiles, no WebAssembly, no scripting engine, no sandbox, anywhere in the build.
    expect(filesUnder(dist).filter((f) => /\.wasm$|\.ttf$|\.icc$|quickjs|sandbox|liberation/i.test(f))).toEqual([]);
  });

  it("every licensed asset in dist/pdfjs has its notice, verbatim, in the interface's licence texts", () => {
    const pkg = pdfjsDir() as string;
    const built = filesUnder(join(dist, "pdfjs"));
    const read = (p: string) => readFileSync(join(dist, "pdfjs", p), "utf8");
    const { list, text } = interfaceNotices(pkg);
    // Every asset, one by one.
    expect(licenceProblems(built, read, text)).toEqual([]);
    // The check itself catches a missing licence: LICENSE_FOXIT gone from the build, or from the notices.
    const withoutFoxit = built.filter((f) => f !== "standard_fonts/LICENSE_FOXIT");
    expect(licenceProblems(withoutFoxit, read, text)).toEqual(["standard_fonts/FoxitDingbats.pfb: its licence standard_fonts/LICENSE_FOXIT is not shipped beside it", "standard_fonts/FoxitSymbol.pfb: its licence standard_fonts/LICENSE_FOXIT is not shipped beside it"]);
    const noticesWithoutFoxit = text.replace(read("standard_fonts/LICENSE_FOXIT").trim().split("\n")[0]!, "");
    expect(licenceProblems(built, read, noticesWithoutFoxit).length).toBe(2);
    // An asset nothing covers, and the forbidden fonts.
    expect(licenceProblems([...built, "standard_fonts/FoxitSerif.pfb"], read, text)).toEqual(["standard_fonts/FoxitSerif.pfb is shipped with no licence that covers it"]);
    expect(licenceProblems([...built, "standard_fonts/LiberationSans-Regular.ttf"], read, text)[0]).toMatch(/must not be shipped/);

    // pdf.js itself (Apache-2.0, its own LICENSE) and the qcms glue in its worker.
    expect(list).toContainEqual({ name: "pdfjs-dist", version: "6.4.299", licence: "Apache-2.0" });
    const codeLicences = ["LICENSE", ...(PDFJS_CODE_LICENCES as string[])].map((name) => ({ label: name, text: readFileSync(join(pkg, name), "utf8") }));
    expect(verifyVerbatim(text, codeLicences)).toEqual([]);
    // core-js, inside the legacy build: listed, with the MIT text and the copyright line the bundle states.
    expect(list).toContainEqual(expect.objectContaining({ name: "core-js", version: "3.50.0", licence: "MIT" }));
    expect(text).toMatch(/^core-js 3\.50\.0 {2}MIT$/m);
    expect(text).toContain("bundled inside pdfjs-dist 6.4.299");
    expect(text).toContain("© 2013–2025 Denis Pushkarev (zloirock.ru), 2025–2026 CoreJS Company (core-js.io). All rights reserved.");
    expect(verifyVerbatim(text, [{ label: "MIT", text: (loadStandardTexts() as Map<string, string>).get("MIT")! }])).toEqual([]);
    // No GPL text anywhere in what the interface's notices carry for pdf.js.
    expect(text).not.toMatch(/GNU GENERAL PUBLIC LICENSE|LIBERATION/);
  });
});
