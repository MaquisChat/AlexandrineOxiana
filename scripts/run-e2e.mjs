// Runs the Playwright end-to-end tests: the browser extension's (apps/browser-extension), the app's
// (e2e/: the real UI, service and media worker in Chromium and WebKit), then the desktop shell's once
// apps/desktop exists.
//
//   pnpm e2e                                   every suite, no extra arguments
//   pnpm e2e -- --extension-only <args…>       only the extension suite, <args…> passed to its Playwright
//   pnpm e2e -- --app-only <args…>             only the app suite, <args…> passed to its Playwright
//   pnpm e2e -- --desktop-only <args…>         only the desktop suite, <args…> passed to its Playwright
//
// The flag may stand anywhere among the arguments (e2e-args.mjs). Extra arguments need a flag, so one
// suite's spec path never reaches another.
//
// Each suite writes its JSON results to reports/playwright-<suite>.json for `pnpm report`.
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { needsSuiteFlag, parseE2eArgs } from "./e2e-args.mjs";

mkdirSync("reports", { recursive: true });
let parsed;
try {
  parsed = parseE2eArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
if (needsSuiteFlag(parsed)) {
  console.error("Extra arguments need --extension-only, --app-only or --desktop-only (they would reach every suite).");
  process.exit(2);
}
const { args, only } = parsed;

const suite = (filter, report, suiteArgs) =>
  spawnSync("pnpm", ["--filter", filter, "run", "e2e", ...suiteArgs], {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: `${process.cwd()}/reports/${report}` },
  }).status ?? 1;

const SUITES = [
  { name: "extension", dir: "apps/browser-extension", filter: "@ao/browser-extension", report: "playwright-extension.json" },
  { name: "app", dir: "e2e", filter: "@ao/e2e", report: "playwright-app.json" },
  { name: "desktop", dir: "apps/desktop", filter: "@ao/desktop", report: "playwright.json" },
];

let status = 0;
for (const s of SUITES) {
  if (only && only !== s.name) continue;
  if (!existsSync(s.dir)) {
    console.log(`Skipping the ${s.name} end-to-end tests: ${s.dir} does not exist yet.`);
    continue;
  }
  const r = suite(s.filter, s.report, only === s.name ? args : []);
  status = status || r;
}
process.exit(status);
