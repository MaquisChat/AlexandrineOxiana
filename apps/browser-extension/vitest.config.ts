import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests only; the Playwright end-to-end test (e2e/) runs with `pnpm e2e`.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "jsdom",
    // The synthetic fixture pages (under jsdom, import.meta.url is not a file: URL).
    env: {
      AO_FIXTURE_PAGES: fileURLToPath(new URL("../../tests/fixtures/pages/", import.meta.url)),
      AO_EXTENSION_ROOT: fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
