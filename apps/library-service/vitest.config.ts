import { defineConfig } from "vitest/config";

// Each test opens a library (and some spawn the service): allow a few seconds each.
// R297 e: every test file starts with the library's in-memory secret store, and none may reach the system keyring.
// The network guard (FR-748, R544): no test reaches a host that is not this machine (packages/library/tests/net-guard.ts).
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 60_000, setupFiles: ["./src/test-setup.ts", "../../packages/library/tests/net-guard.ts"] },
});
