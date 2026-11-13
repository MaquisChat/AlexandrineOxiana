// The files of the pinned pdfjs-dist that the interface ships beside its own code (Task R6), in one
// place for the three that need the same answer: the build, which copies them into dist/pdfjs/
// (vite.config.ts, copyPdfJsAssets); the desktop build's licence texts (apps/desktop/scripts/notices.mjs,
// R165), which must carry every licence file among them whole; and the test of both
// (src/pdfjsBundle.test.ts).
//
//   cmaps/           the packed character maps (cMapUrl) and their licence (Adobe)
//   standard_fonts/  the standard fonts (standardFontDataUrl) and their licences (Foxit, Liberation)
//   wasm/            only the image decoders' JavaScript fallbacks (useWasm: false) and the licences
//                    of the wasm/ folder; never a .wasm file, never QuickJS (the scripting engine)
//   iccs/            the CMYK colour profile (iccUrl) and its licence (CC0)
//
// Plain JavaScript so that the desktop build's scripts can use it without a TypeScript step.
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The folders of pdfjs-dist copied to dist/pdfjs/, in the order of the pdf.js options that name them. */
export const PDFJS_ASSET_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];

/** A licence file of pdfjs-dist's asset folders (LICENSE, LICENSE_FOXIT, LICENSE_JBIG2 …). */
const isLicence = (name) => /^LICEN[CS]E(?:_[A-Z0-9_]+)?$/.test(name);

/** Which files of each folder are shipped: wasm/ keeps only the JavaScript fallbacks and the licences. */
const SHIPPED = {
  cmaps: (name) => name.endsWith(".bcmap") || isLicence(name),
  standard_fonts: (name) => /\.(pfb|ttf)$/.test(name) || isLicence(name),
  wasm: (name) => name.endsWith("_nowasm_fallback.js") || isLicence(name),
  iccs: (name) => name.endsWith(".icc") || isLicence(name),
};

/** The folder of the pdfjs-dist the interface depends on (packages/ui/node_modules/pdfjs-dist). */
export function pdfjsDir() {
  const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
  return dirname(require.resolve("pdfjs-dist/package.json"));
}

/** Every shipped file, as "<folder>/<name>" paths inside pdfjs-dist (and inside dist/pdfjs/). */
export function pdfjsAssetFiles(dir = pdfjsDir()) {
  const out = [];
  for (const folder of PDFJS_ASSET_DIRS) {
    for (const name of readdirSync(join(dir, folder)).sort()) {
      if (statSync(join(dir, folder, name)).isFile() && SHIPPED[folder](name)) out.push(`${folder}/${name}`);
    }
  }
  return out;
}

/** The licence files among them ("cmaps/LICENSE", "standard_fonts/LICENSE_FOXIT" …). */
export function pdfjsLicenceFiles(dir = pdfjsDir()) {
  return pdfjsAssetFiles(dir).filter((p) => isLicence(p.slice(p.lastIndexOf("/") + 1)));
}
