/**
 * Four builds into dist/ (run by scripts/build.mjs):
 *  - default: the popup (src/popup/popup.html → popup.html + assets/), ES modules, no inline scripts;
 *  - mode "background": src/background.ts → background.js (one classic script, so the same file
 *    serves Chrome's service worker and Firefox's background scripts);
 *  - mode "content": src/content/entry.ts → content.js (one classic script for executeScript);
 *  - mode "find-tab": src/find-tab-entry.ts → find-tab.js (the small script that reads the tab's PDF, R348 i).
 * manifest.json and selectors.json are copied next to them by the build script.
 */
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";

const dist = fileURLToPath(new URL("dist", import.meta.url));

function script(entry: string, fileName: string): UserConfig {
  return {
    publicDir: false,
    build: {
      outDir: dist,
      emptyOutDir: false,
      minify: false, // readable in the browser's extension review and in bug reports
      target: "es2022",
      sourcemap: false,
      rollupOptions: {
        input: fileURLToPath(new URL(entry, import.meta.url)),
        output: { format: "iife", entryFileNames: fileName, inlineDynamicImports: true },
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  if (mode === "background") return script("src/background.ts", "background.js");
  if (mode === "content") return script("src/content/entry.ts", "content.js");
  if (mode === "find-tab") return script("src/find-tab-entry.ts", "find-tab.js");
  return {
    root: fileURLToPath(new URL("src/popup", import.meta.url)),
    base: "./",
    publicDir: false,
    plugins: [react()],
    build: {
      outDir: dist,
      emptyOutDir: true,
      target: "es2022",
      modulePreload: { polyfill: false },
      rollupOptions: { input: fileURLToPath(new URL("src/popup/popup.html", import.meta.url)) },
    },
  };
});
