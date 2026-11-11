import { defineConfig } from "@playwright/test";

// The extension end-to-end test. `pnpm e2e` builds dist/ first (scripts/build.mjs).
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ? [["list"], ["json"]] : "list",
  use: { trace: "off" },
});
