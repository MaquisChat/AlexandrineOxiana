// Runs the Playwright end-to-end tests: the browser extension's (apps/browser-extension), the app's
// (e2e/: the real UI, service and media worker in Chromium and WebKit), and the desktop app's
// (apps/desktop/e2e: the built Linux app driven through its real window by WebDriver).
//
//   pnpm e2e                                   the extension and app suites, no extra arguments
//                                              (not the desktop suite: it needs the built app)
//   pnpm e2e -- --extension-only <args…>       only the extension suite, <args…> passed to its Playwright
//   pnpm e2e -- --app-only <args…>             only the app suite, <args…> passed to its Playwright
//   pnpm e2e -- --desktop-only <args…>         only the desktop suite, <args…> passed to its Playwright
//
// The flag may stand anywhere among the arguments (e2e-args.mjs). Extra arguments need a flag, so one
// suite's spec path never reaches another.
//
// Each suite writes its JSON results to reports/playwright-<suite>.json for `pnpm report`.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { needsSuiteFlag, noResults, parseE2eArgs, suitesToRun } from "./e2e-args.mjs";

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
  // Needs `pnpm --filter @ao/desktop run build:linux` first, tauri-driver, WebKitWebDriver, Xvfb,
  // dbus-daemon and xdotool (apps/desktop/README.md): only with --desktop-only.
  { name: "desktop", dir: "apps/desktop/e2e", filter: "@ao/desktop", report: "playwright-desktop.json", onlyWhenAsked: true },
];

if (!only) console.log("The desktop end-to-end test is not part of a plain `pnpm e2e` (it needs the built app): run it with `pnpm e2e -- --desktop-only`.");
let status = 0;
for (const s of suitesToRun(only, SUITES)) {
  if (!existsSync(s.dir)) {
    console.log(`Skipping the ${s.name} end-to-end tests: ${s.dir} does not exist yet.`);
    continue;
  }
  // A stale result from an earlier run must never stand in for this one.
  const report = `reports/${s.report}`;
  rmSync(report, { force: true });
  const r = suite(s.filter, s.report, only === s.name ? args : []);
  if (!existsSync(report)) writeFileSync(report, JSON.stringify(noResults(s.name, r)));
  status = status || r;
}
process.exit(status);
