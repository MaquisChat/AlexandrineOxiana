// Runs the Playwright end-to-end tests: the browser extension's (apps/browser-extension), then the
// desktop app's once apps/desktop exists. Extra arguments (e.g. `e2e/extension.spec.ts --trace off`)
// go to the extension's Playwright run.
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

mkdirSync("reports", { recursive: true });
const args = process.argv.slice(2).filter((a) => a !== "--");
let status = 0;

if (existsSync("apps/browser-extension")) {
  const r = spawnSync("pnpm", ["--filter", "@ao/browser-extension", "run", "e2e", ...args], {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: `${process.cwd()}/reports/playwright-extension.json` },
  });
  status = r.status ?? 1;
}

if (!existsSync("apps/desktop")) {
  console.log("Skipping the desktop end-to-end tests: apps/desktop does not exist yet.");
  process.exit(status);
}
const r = spawnSync("pnpm", ["--filter", "@ao/desktop", "run", "e2e"], {
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: `${process.cwd()}/reports/playwright.json` },
});
process.exit(status || (r.status ?? 1));
