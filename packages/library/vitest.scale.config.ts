import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const ZOTERO = "src/import/zotero-web-files.scale.test.ts";

// `pnpm test:scale`: the imports at scale, each file alone in its own process (time and memory are measured).
// Bulk Import: once pdf.js is loaded (the first PDF), V8 sizes its old generation from a larger live heap and
// lets short-lived import garbage pile up to ~250 MB before a full collection (the live heap stays near
// 100 MB). The old-space cap makes V8 collect at the size the app is meant to run in (budget: RSS <
// 500 MB); the app's own process needs the same setting (noted for the app shell).
// Zotero Web files (Task Z4): the plan's cap, --max-old-space-size=512 (R64), with --expose-gc so the test
// can measure the LIVE heap after a forced collection (its bound, 300 MB) rather than a peak that depends on
// when V8 chooses to collect.
const shared = { testTimeout: 300_000, pool: "forks" as const, fileParallelism: false };
export default defineConfig({
  root,
  test: {
    // One file at a time across both projects: each measures time and memory alone.
    fileParallelism: false,
    projects: [
      { test: { ...shared, name: "bulk", root, include: ["src/**/*.scale.test.ts"], exclude: [ZOTERO], poolOptions: { forks: { execArgv: ["--max-old-space-size=320"] } } } },
      { test: { ...shared, name: "zotero-web", root, include: [ZOTERO], poolOptions: { forks: { execArgv: ["--max-old-space-size=512", "--expose-gc"] } } } },
    ],
  },
});
