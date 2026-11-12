import { defineConfig } from "@playwright/test";

/**
 * Only for lifetime.test.ts: runs hang.probe.ts, which starts stand-in processes through the desktop
 * suite's `run` fixture and then hangs, under a 3 s test limit, so that the test can check that the
 * fixture's teardown still stops everything after a time-out. Not part of `pnpm e2e`.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.probe.ts",
  timeout: 3_000,
  retries: 0,
  workers: 1,
  outputDir: process.env.AO_PROBE_RESULTS ?? "test-results",
  reporter: "list",
});
