import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { defineConfig } from "@playwright/test";

// The extension end-to-end test. `pnpm e2e` builds dist/ first (scripts/build.mjs).
// AO_EXTENSION_DIR (Task 65): run the test against another unpacked extension, such as the unzipped
// download from scripts/package.mjs, instead of dist/. Read only here; the spec gets the checked,
// absolute folder through AO_E2E_EXTENSION_DIR.
const other = process.env.AO_EXTENSION_DIR;
if (other !== undefined && other !== "") {
  const dir = isAbsolute(other) ? other : resolve(process.cwd(), other);
  if (!existsSync(join(dir, "manifest.json"))) throw new Error(`AO_EXTENSION_DIR has no manifest.json at its top level: ${dir}`);
  process.env.AO_E2E_EXTENSION_DIR = dir;
} else {
  delete process.env.AO_E2E_EXTENSION_DIR;
}

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ? [["list"], ["json"]] : "list",
  use: { trace: "off" },
});
