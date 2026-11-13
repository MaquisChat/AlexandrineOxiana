import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `pnpm test:scale`: Bulk Import at scale, alone in its own process (time and memory are measured).
// Once pdf.js is loaded (the first PDF), V8 sizes its old generation from a larger live heap and lets
// short-lived import garbage pile up to ~250 MB before a full collection (the live heap stays near
// 100 MB). The old-space cap makes V8 collect at the size the app is meant to run in (budget: RSS <
// 500 MB); the app's own process needs the same setting (noted for the app shell).
// The Zotero Web files scale test runs under its own flags (vitest.zotero-scale.config.ts, also run by
// `pnpm test:scale`): Vitest applies process flags per configuration, not per project.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["src/**/*.scale.test.ts"],
    exclude: ["src/import/zotero-web-files.scale.test.ts"],
    testTimeout: 300_000,
    pool: "forks",
    fileParallelism: false,
    poolOptions: { forks: { execArgv: ["--max-old-space-size=320"] } },
  },
});
