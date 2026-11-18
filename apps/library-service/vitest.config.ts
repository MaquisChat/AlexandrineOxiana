import { defineConfig } from "vitest/config";

// Each test opens a library (and some spawn the service): allow a few seconds each.
// R297 e: every test file starts with the library's in-memory secret store, and none may reach the system keyring.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000, setupFiles: ["./src/test-setup.ts"] } });
