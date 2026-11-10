import { defineConfig } from "vitest/config";

// Each test opens a library (and some spawn the service): allow a few seconds each.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
