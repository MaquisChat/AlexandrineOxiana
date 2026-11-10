import { defineConfig } from "vitest/config";

// The tests spawn the CLI (and its media worker): each takes a few seconds.
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 120_000 } });
