import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `pnpm test:scale` (after vitest.scale.config.ts): the Zotero Web files scale test (Task Z4), alone in its own
// process, under the plan's cap (--max-old-space-size=512, R64) and with --expose-gc, so that the test measures
// the LIVE heap after a forced collection (its bound, 300 MB) rather than a peak that depends on when V8 collects.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["src/import/zotero-web-files.scale.test.ts"],
    testTimeout: 300_000,
    pool: "forks",
    fileParallelism: false,
    poolOptions: { forks: { execArgv: ["--max-old-space-size=512", "--expose-gc"] } },
  },
});
