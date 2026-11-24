import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
// The list of pdf.js's shipped files, shared with the desktop build's licence texts (R165).
// @ts-expect-error: plain JavaScript build script without type declarations.
import { pdfjsAssetFiles, pdfjsDir } from "./scripts/pdfjs-assets.mjs";

/**
 * index.html carries the app's Content-Security-Policy (R105). The dev server injects inline scripts
 * (React refresh, HMR client) that this policy refuses, so in `vite` dev mode only the tag is
 * dropped; builds keep it.
 */
function dropCspInDev(): Plugin {
  return {
    name: "ao-drop-csp-in-dev",
    apply: "serve",
    transformIndexHtml: (html) => html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, ""),
  };
}

/**
 * pdf.js's data files, from the pinned pdfjs-dist, served by the app itself under /pdfjs/ (Task R6):
 * the character maps (cMapUrl "/pdfjs/cmaps/"), the standard fonts ("/pdfjs/standard_fonts/"), the
 * image decoders' JavaScript fallbacks ("/pdfjs/wasm/", useWasm: false) and the CMYK colour profile
 * ("/pdfjs/iccs/"), each folder with its licence files (scripts/pdfjs-assets.mjs lists them). Nothing
 * pdf.js reads ever comes from the network. Emitted as assets of the build at fixed names (pdf.js
 * builds the file names itself); served from the package in dev mode.
 */
export function copyPdfJsAssets(): Plugin {
  const dir = pdfjsDir() as string;
  const files = pdfjsAssetFiles(dir) as string[];
  return {
    name: "ao-copy-pdfjs-assets",
    generateBundle() {
      for (const f of files) this.emitFile({ type: "asset", fileName: `pdfjs/${f}`, source: readFileSync(join(dir, f)) });
    },
    configureServer(server) {
      const known = new Set(files);
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0] ?? "";
        if (!path.startsWith("/pdfjs/")) return next();
        const f = path.slice("/pdfjs/".length);
        if (!known.has(f)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", f.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        res.end(readFileSync(join(dir, f)));
      });
    },
  };
}

// The desktop shell (Tauri, Task 37) loads the built app and hands it the service URL and token at
// start-up; the token is never put in a URL.
export default defineConfig({
  plugins: [react(), dropCspInDev(), copyPdfJsAssets()],
  server: { host: "127.0.0.1", strictPort: true },
  // Two pages: the app, and the desktop shell's closing window (closing.html; FR-297, R470 c).
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        closing: fileURLToPath(new URL("./closing.html", import.meta.url)),
      },
    },
  },
});
