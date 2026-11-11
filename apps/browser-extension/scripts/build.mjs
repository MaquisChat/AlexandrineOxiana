// Builds the unpacked extension into dist/ (load it from there in chrome://extensions or about:debugging).
import { copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const configFile = fileURLToPath(new URL("../vite.config.ts", import.meta.url));

for (const mode of ["popup", "background", "content"]) await build({ configFile, mode, logLevel: "warn" });

copyFileSync(`${root}/manifest.json`, `${root}/dist/manifest.json`);
// Checked against its schema when the extension loads it; parse here so a broken file fails the build.
JSON.parse(readFileSync(`${root}/src/content/selectors.json`, "utf8"));
copyFileSync(`${root}/src/content/selectors.json`, `${root}/dist/selectors.json`);
console.log(`Extension built in ${root}dist`);
