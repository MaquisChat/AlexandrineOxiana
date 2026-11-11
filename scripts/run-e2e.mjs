// Runs the Playwright end-to-end tests: the browser extension's (apps/browser-extension), then the
// desktop app's once apps/desktop exists.
//
//   pnpm e2e                                   both suites, no extra arguments
//   pnpm e2e -- --extension-only <args…>       only the extension suite, <args…> passed to its Playwright
//   pnpm e2e -- --desktop-only <args…>         only the desktop suite, <args…> passed to its Playwright
//
// Extra arguments without a flag go to the extension suite while the desktop suite does not exist;
// once it does, a flag is needed so one suite's spec path never reaches the other.
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

mkdirSync("reports", { recursive: true });
let args = process.argv.slice(2).filter((a) => a !== "--");
let only;
if (args[0] === "--extension-only" || args[0] === "--desktop-only") {
  only = args[0] === "--extension-only" ? "extension" : "desktop";
  args = args.slice(1);
}
const hasExtension = existsSync("apps/browser-extension");
const hasDesktop = existsSync("apps/desktop");
if (!only && args.length) {
  if (hasDesktop) {
    console.error("Extra arguments need --extension-only or --desktop-only (they would reach both suites).");
    process.exit(2);
  }
  only = "extension";
}

const suite = (filter, report, suiteArgs) =>
  spawnSync("pnpm", ["--filter", filter, "run", "e2e", ...suiteArgs], {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: `${process.cwd()}/reports/${report}` },
  }).status ?? 1;

let status = 0;
if (only !== "desktop" && hasExtension) status = suite("@ao/browser-extension", "playwright-extension.json", only === "extension" ? args : []);
if (only !== "extension") {
  if (hasDesktop) {
    const desktop = suite("@ao/desktop", "playwright.json", only === "desktop" ? args : []);
    status = status || desktop;
  }
  else console.log("Skipping the desktop end-to-end tests: apps/desktop does not exist yet.");
}
process.exit(status);
