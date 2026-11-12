import { configDefaults, defineConfig } from "vitest/config";

// The root `pnpm test` runs Vitest over every workspace package. The test files under scripts/ are
// node:test files (run by this package's own `test` script and by the desktop CI job), and
// src-tauri/ holds the Rust program and its build output: neither is for Vitest.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "scripts/**", "src-tauri/**"], passWithNoTests: true },
});
