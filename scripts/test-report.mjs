// Plain-language test report.
// Turns Vitest / pytest / Playwright results into reports/test-report.md.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// EDIT ME: map a test file name to the plain-language area it checks.
// Add an entry whenever a task adds a test file. Unknown files fall back
// to a readable version of the file name.
export const AREA_NAMES = {
  "naming.test.ts": "File naming",
  "ids.test.ts": "IDs",
  "audit.test.ts": "Audit log",
  "governance.test.ts": "Data governance",
  "citations.test.ts": "Citations",
  "citation.test.ts": "Citations",
  "custom-styles.test.ts": "Custom citation styles",
  "library.test.ts": "Library folder",
  "test-report.test.mjs": "Test report",
  "e2e-args.test.mjs": "End-to-end test arguments",
  "recorded.test.ts": "Recorded lookup answers (test mode)",
};

export function areaName(file) {
  const base = basename(String(file));
  if (AREA_NAMES[base]) return AREA_NAMES[base];
  const stem = base.replace(/\.(test|spec)\.[a-z]+$/i, "").replace(/^test_/, "").replace(/\.[a-z]+$/i, "");
  const words = stem.replace(/[-_.]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Other";
}

const decode = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function fromVitest(json) {
  const out = [];
  for (const file of json.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      if (t.status === "pending" || t.status === "skipped" || t.status === "todo") continue;
      out.push({ area: areaName(file.name), name: t.title, passed: t.status === "passed" });
    }
  }
  return out;
}

function fromPytest(xml) {
  const out = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attr = (n) => (m[1].match(new RegExp(`\\b${n}="([^"]*)"`)) ?? [])[1] ?? "";
    const body = m[3] ?? "";
    if (/<skipped\b/.test(body)) continue;
    const mod = decode(attr("classname")).split(".").pop() || "tests";
    const name = decode(attr("name")).replace(/^test_/, "").replace(/_/g, " ");
    out.push({ area: areaName(mod + ".py"), name, passed: !/<(failure|error)\b/.test(body) });
  }
  return out;
}

/** Where the app's end-to-end results (e2e/, run by `pnpm e2e`) are listed. */
export const APP_E2E_AREA = "The app end to end";

// A spec passes only when at least one of its tests ran and every one that ran passed; specs whose
// tests were all skipped are left out (as skipped unit tests are). A spec with no test at all, a spec
// file containing none, and a run that found no tests or could not start are failures, never passes.
function fromPlaywright(json, area) {
  const out = [];
  const areaOf = (file) => area ?? areaName(file ?? "end-to-end");
  const walk = (suite, file) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      const tests = spec.tests ?? [];
      const ran = tests.filter((t) => t.status !== "skipped");
      if (tests.length && !ran.length) continue;
      out.push({ area: areaOf(spec.file ?? f), name: spec.title, passed: ran.length > 0 && ran.every((t) => t.status === "expected") });
    }
    for (const s of suite.suites ?? []) walk(s, f);
    // A file's own suite with nothing in it: the spec file contains no tests.
    if (suite.file && !file && !(suite.specs ?? []).length && !(suite.suites ?? []).length) {
      out.push({ area: areaOf(suite.file), name: `${basename(suite.file)} contains no tests`, passed: false });
    }
  };
  for (const s of json.suites ?? []) walk(s);
  for (const e of json.errors ?? []) {
    const msg = String(e?.message ?? e?.value ?? "unknown error").split("\n")[0];
    out.push({ area: areaOf(), name: `Playwright could not run the tests: ${msg}`, passed: false });
  }
  if (!out.length && !(json.suites ?? []).length) out.push({ area: areaOf(), name: "no tests ran", passed: false });
  return out;
}

export function buildReport(results = {}) {
  const checks = [
    ...(results.vitest ? fromVitest(results.vitest) : []),
    ...(results.pytest ? fromPytest(results.pytest) : []),
    ...(results.playwrightExtension ? fromPlaywright(results.playwrightExtension) : []),
    ...(results.playwrightApp ? fromPlaywright(results.playwrightApp, APP_E2E_AREA) : []),
    ...(results.playwright ? fromPlaywright(results.playwright) : []),
  ];
  const lines = ["# Test report", ""];
  if (checks.length === 0) {
    lines.push("## Summary", "", "No test results found.", "");
    return lines.join("\n");
  }
  const passed = checks.filter((c) => c.passed).length;
  lines.push("## Summary", "", `${passed} of ${checks.length} checks passed.`, "");
  lines.push(passed === checks.length ? "Everything is working." : `${checks.length - passed} need attention (marked ✗ below).`, "");
  const failures = checks.filter((c) => !c.passed);
  if (failures.length) {
    lines.push("## Needs attention", "");
    for (const c of failures) lines.push(`- ✗ ${c.area}: ${c.name}`);
    lines.push("");
  }
  lines.push("## By area", "");
  const areas = [...new Set(checks.map((c) => c.area))].sort();
  for (const area of areas) {
    const mine = checks.filter((c) => c.area === area);
    lines.push(`### ${area} (${mine.filter((c) => c.passed).length} of ${mine.length} passed)`, "");
    for (const c of mine) lines.push(`- ${c.passed ? "✓" : "✗"} ${area}: ${c.name}`);
    lines.push("");
  }
  return lines.join("\n");
}

function main() {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "reports");
  const read = (f) => (existsSync(resolve(dir, f)) ? readFileSync(resolve(dir, f), "utf8") : undefined);
  const json = (f) => {
    const t = read(f);
    return t ? JSON.parse(t) : undefined;
  };
  const md = buildReport({
    vitest: json("vitest.json"),
    pytest: read("pytest.xml"),
    playwrightExtension: json("playwright-extension.json"),
    playwrightApp: json("playwright-app.json"),
    playwright: json("playwright.json"),
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "test-report.md"), md);
  console.log(md);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
