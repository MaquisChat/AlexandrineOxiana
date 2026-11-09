// Runs Playwright end-to-end tests once apps/desktop exists; skips cleanly before that.
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (!existsSync("apps/desktop")) {
  console.log("Skipping end-to-end tests: apps/desktop does not exist yet.");
  process.exit(0);
}
mkdirSync("reports", { recursive: true });
const r = spawnSync("pnpm", ["--filter", "@ao/desktop", "run", "e2e"], {
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: `${process.cwd()}/reports/playwright.json` },
});
process.exit(r.status ?? 1);
