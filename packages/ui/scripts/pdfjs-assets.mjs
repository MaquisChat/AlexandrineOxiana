// The files of the pinned pdfjs-dist that the interface ships beside its own code (Task R6), and the
// licence that covers each, in one place for the three that need the same answer: the build, which
// copies them into dist/pdfjs/ (vite.config.ts, copyPdfJsAssets); the desktop build's licence texts
// (apps/desktop/scripts/notices.mjs, R165), which must carry every one of those licences whole; and
// the test of both (src/pdfjsBundle.test.ts), which checks every shipped asset one by one.
//
// What is shipped, and why only this (R199, A6):
//   cmaps/*.bcmap                   the packed character maps (cMapUrl)             Adobe, BSD-3-Clause
//   standard_fonts/FoxitSymbol.pfb  with useSystemFonts: true pdf.js fetches only    PDFium, BSD-3-Clause
//   standard_fonts/FoxitDingbats.pfb  Symbol and ZapfDingbats; every other standard
//                                   font comes from the system (Helvetica, Times …)
//   wasm/jbig2_nowasm_fallback.js   the JBIG2 decoder in JavaScript (useWasm: false)  PDFium BSD-3-Clause + Apache-2.0; Mozilla Apache-2.0
//   wasm/openjpeg_nowasm_fallback.js  the JPEG 2000 decoder in JavaScript             OpenJPEG BSD-2-Clause; Mozilla BSD-2-Clause
// Never shipped: the Liberation Sans fonts and their licence (GNU GPL version 2 with a font
// exception, R199), the iccs/ folder (never read with useWorkerFetch: false), any .wasm file, QuickJS
// (the scripting engine), the other Foxit fonts (never read with useSystemFonts: true).
//
// Licences of code inside pdf.js's own bundles (pdf.mjs and its worker, which the build bundles):
// its root LICENSE (Apache-2.0, collected like every package's), the qcms colour-management glue in the
// worker (wasm/LICENSE_QCMS, wasm/LICENSE_PDFJS_QCMS: MIT), and core-js (MIT), which the legacy build
// contains without shipping its text (pdfjsBundledComponents).
//
// Plain JavaScript so that the desktop build's scripts can use it without a TypeScript step.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The folders of pdfjs-dist copied to dist/pdfjs/, in the order of the pdf.js options that name them. */
export const PDFJS_ASSET_DIRS = ["cmaps", "standard_fonts", "wasm"];

/** Each kind of shipped asset and the licence files that cover it (paths inside pdfjs-dist and dist/pdfjs/). */
export const PDFJS_ASSET_LICENCES = [
  { folder: "cmaps", match: /^[^/]+\.bcmap$/, licences: ["cmaps/LICENSE"] },
  { folder: "standard_fonts", match: /^Foxit(Symbol|Dingbats)\.pfb$/, licences: ["standard_fonts/LICENSE_FOXIT"] },
  { folder: "wasm", match: /^jbig2_nowasm_fallback\.js$/, licences: ["wasm/LICENSE_JBIG2", "wasm/LICENSE_PDFJS_JBIG2"] },
  { folder: "wasm", match: /^openjpeg_nowasm_fallback\.js$/, licences: ["wasm/LICENSE_OPENJPEG", "wasm/LICENSE_PDFJS_OPENJPEG"] },
];

/** Licence files (inside pdfjs-dist's sub-folders) of code inside pdf.js's own bundles, not of a copied asset. */
export const PDFJS_CODE_LICENCES = ["wasm/LICENSE_QCMS", "wasm/LICENSE_PDFJS_QCMS"];

/** What must never be shipped: GPL fonts (R199), the unused colour profiles, WebAssembly, the scripting engine. */
export const PDFJS_FORBIDDEN = /\.ttf$|LIBERATION|^iccs\/|\.wasm$|quickjs|sandbox/i;

/** The folder of the pdfjs-dist the interface depends on (packages/ui/node_modules/pdfjs-dist). */
export function pdfjsDir() {
  const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
  return dirname(require.resolve("pdfjs-dist/package.json"));
}

/** The licence files that cover one shipped asset ("cmaps/78-H.bcmap" …), or undefined if it is not an asset. */
export function licencesOfAsset(path) {
  const slash = path.indexOf("/");
  const folder = path.slice(0, slash);
  const name = path.slice(slash + 1);
  return PDFJS_ASSET_LICENCES.find((r) => r.folder === folder && r.match.test(name))?.licences;
}

/** The shipped assets (not their licences), as "<folder>/<name>" paths. */
export function pdfjsAssets(dir = pdfjsDir()) {
  const out = [];
  for (const folder of PDFJS_ASSET_DIRS) {
    for (const name of readdirSync(join(dir, folder)).sort()) {
      const path = `${folder}/${name}`;
      if (statSync(join(dir, path)).isFile() && licencesOfAsset(path)) out.push(path);
    }
  }
  return out;
}

/** Every file copied to dist/pdfjs/: the assets and the licence files that cover them. */
export function pdfjsAssetFiles(dir = pdfjsDir()) {
  const assets = pdfjsAssets(dir);
  const licences = new Set(assets.flatMap((a) => licencesOfAsset(a)));
  return [...assets, ...licences].sort();
}

/** The licence files the notices carry for pdfjs-dist beyond its root LICENSE: the copied assets' and the bundled code's. */
export function pdfjsLicenceFiles(dir = pdfjsDir()) {
  const assets = pdfjsAssets(dir);
  return [...new Set([...assets.flatMap((a) => licencesOfAsset(a)), ...PDFJS_CODE_LICENCES])].sort();
}

/**
 * What pdf.js's legacy build bundles without shipping its licence text: core-js, as the bundles
 * themselves record it (version and copyright line), from pdf.mjs and the minified worker.
 * [{ name, version, licence, copyright }]
 */
export function pdfjsBundledComponents(dir = pdfjsDir()) {
  const found = new Map();
  for (const file of ["legacy/build/pdf.mjs", "legacy/build/pdf.worker.min.mjs"]) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const m of text.matchAll(/version:\s*['"](\d+\.\d+\.\d+)['"],\s*mode:[^,]+,\s*copyright:\s*['"]([^'"]*Denis Pushkarev[^'"]*)['"],\s*license:\s*['"]https:\/\/github\.com\/zloirock\/core-js\/blob\/v\d+\.\d+\.\d+\/LICENSE['"]/g)) {
      found.set(m[1], { name: "core-js", version: m[1], licence: "MIT", copyright: m[2] });
    }
  }
  if (!found.size) throw new Error("pdfjs-dist: the core-js record was not found in the legacy build; check what it bundles");
  return [...found.values()];
}
