import { defineConfig, devices } from "@playwright/test";

/**
 * The app end to end (R130): the built UI (packages/ui/dist) in Chromium and WebKit, served under the
 * desktop shell's own origin, talking to the real library service and media worker. See fixtures.ts.
 *
 *   pnpm e2e -- --app-only --trace off                     both browsers
 *   pnpm e2e -- --app-only --trace off --project chromium  one
 *
 * One worker: each test starts its own service and worker (fixtures.ts), and the two browsers run one
 * after the other, which keeps a CI runner's memory and CPU predictable.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // `pnpm e2e` sets PLAYWRIGHT_JSON_OUTPUT_NAME (reports/playwright-app.json) for `pnpm report`.
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ? [["list"], ["json"]] : "list",
  use: { trace: "off", screenshot: "off", video: "off" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
