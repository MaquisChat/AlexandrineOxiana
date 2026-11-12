import { defineConfig } from "@playwright/test";

/**
 * The desktop app end to end (Task 37h): the built Linux app (`pnpm --filter @ao/desktop run
 * build:linux`) driven through its real window by WebDriver (tauri-driver in front of
 * WebKitWebDriver). Playwright is only the test runner here: no browser of its own is started.
 *
 *   pnpm e2e -- --desktop-only        (not part of a plain `pnpm e2e`: it needs the built app)
 *
 * Spec files are *.e2e.ts so that Vitest's default pattern (the apps/desktop project of the root
 * vitest.workspace.ts) does not run them as unit tests. One worker, no retries: a flaky run is a
 * finding, not something to retry.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  // A healthy run takes about a minute; this is a hang detector, not a budget (R150).
  timeout: 360_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  outputDir: "test-results",
  // `pnpm e2e` sets PLAYWRIGHT_JSON_OUTPUT_NAME (reports/playwright-desktop.json) for `pnpm report`.
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ? [["list"], ["json"]] : "list",
  projects: [{ name: "linux-webkitgtk" }],
});
