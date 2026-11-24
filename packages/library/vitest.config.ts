import { configDefaults, defineConfig } from "vitest/config";

// The scale test runs on its own (`pnpm test:scale`, vitest.scale.config.ts), not in `pnpm test`.
// The default time-outs are hang detectors, not performance budgets (R150): many tests here drive real
// files, SQLite and worker threads, and GitHub's two-processor runners take several times a developer
// machine's time. Tests that assert a speed keep their own explicit limits.
// The network guard (FR-748, R544): no test reaches a host that is not this machine (tests/net-guard.ts).
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "**/*.scale.test.ts"], testTimeout: 30_000, hookTimeout: 30_000, setupFiles: ["./tests/net-guard.ts"] },
});
