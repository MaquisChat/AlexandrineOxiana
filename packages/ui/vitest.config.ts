import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // themes.ts reads tokens.css as text (?raw); Vitest otherwise replaces CSS with an empty module.
    css: { include: [/tokens\.css/] },
    // A hang detector, not a performance budget (R150): the first render in a test file can take
    // seconds on a two-processor runner. Tests that assert a speed keep their own explicit limits.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
