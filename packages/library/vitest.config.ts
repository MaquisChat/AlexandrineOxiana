import { configDefaults, defineConfig } from "vitest/config";

// The scale test runs on its own (`pnpm test:scale`, vitest.scale.config.ts), not in `pnpm test`.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "**/*.scale.test.ts"] },
});
