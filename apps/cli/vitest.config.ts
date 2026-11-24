import { defineConfig } from "vitest/config";

// The tests spawn the CLI (and its media worker): each takes a few seconds.
// The network guard (FR-748, R544): no test reaches a host that is not this machine (packages/library/tests/net-guard.ts).
// It guards the tests' own process only; the CLI they spawn keeps off the network by its projects' rules.
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 120_000, setupFiles: ["../../packages/library/tests/net-guard.ts"] } });
