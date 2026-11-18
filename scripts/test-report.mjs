// Plain-language test report.
// Turns Vitest / pytest / Playwright results into reports/test-report.md.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
  "webdriver.test.ts": "Desktop test's WebDriver client",
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
/** Where the desktop app's end-to-end results (apps/desktop/e2e, `pnpm e2e -- --desktop-only`) are listed. */
export const DESKTOP_E2E_AREA = "The desktop app end to end";

// A spec passes only when at least one of its tests ran and every one that ran passed; specs whose
// tests were all skipped are left out (as skipped unit tests are). A spec with no test at all, a spec
// file containing none, and a run that found no tests, ran none (all skipped) or could not start are
// failures, never passes.
// `playwright test` options that take a value (so the value is not a spec-file filter).
const PW_VALUE_OPTIONS = new Set(["-c", "--config", "--project", "--trace", "--workers", "-j", "--reporter", "--shard", "--timeout", "--retries", "--repeat-each", "--max-failures", "--output", "--global-timeout", "--update-snapshots", "--update-source-method", "--tsconfig", "--browser"]);
// Options that leave out tests on purpose: then a file without results is not a finding.
const PW_NARROWING = new Set(["-g", "--grep", "--grep-invert", "--last-failed", "--only-changed", "--tag"]);

/** Whether the run recorded in `config.argv` was asked for every test (no file filter, no grep). */
function unfiltered(argv) {
  const i = argv.indexOf("test");
  if (i < 0) return false;
  const rest = argv.slice(i + 1);
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    const name = a.split("=")[0];
    if (PW_NARROWING.has(name)) return false;
    if (PW_VALUE_OPTIONS.has(name)) {
      if (!a.includes("=")) k++;
      continue;
    }
    if (!a.startsWith("-")) return false; // a spec file or path filter
  }
  return true;
}

/**
 * Whether a file name is a Playwright spec file of this repository: *.spec.* / *.test.* (the
 * extension's and the app's suites), or *.e2e.* (the desktop suite's, named so that Vitest's default
 * pattern does not pick it up), js or ts.
 */
export function isSpecFile(name) {
  return /\.(spec|test|e2e)\.[cm]?[jt]sx?$/.test(name);
}

/**
 * A test of a file's name against a project's `testMatch` as Playwright's JSON report records it,
 * when every pattern is a plain name glob ("*.e2e.ts", "**\/*.spec.ts": letters, digits, ".", "-",
 * "_" and "*"); undefined otherwise (Playwright's default extended glob, a regular expression), and
 * the usual spec-file names (isSpecFile) apply.
 */
function testMatcher(testMatch) {
  const patterns = Array.isArray(testMatch) ? testMatch : testMatch === undefined ? [] : [testMatch];
  if (!patterns.length || !patterns.every((p) => typeof p === "string" && /^(\*\*\/)?[\w.*-]+$/.test(p))) return undefined;
  const res = patterns.map((p) => new RegExp(`^${p.replace(/^\*\*\//, "").replace(/[.+?^${}()|[\]\\-]/g, "\\$&").replace(/\*/g, "[^/]*")}$`));
  return (name) => res.some((re) => re.test(name));
}

/** Spec files under `dir` (isSpecFile). */
function specFilesOnDisk(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (isSpecFile(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function fromPlaywright(json, area, listSpecFiles = specFilesOnDisk) {
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
  // Playwright leaves a spec file with no tests out of its results entirely: compare with the disk.
  const cfg = json.config;
  if (cfg?.rootDir && Array.isArray(cfg.argv) && unfiltered(cfg.argv)) {
    const reported = new Set((json.suites ?? []).map((s) => s.file).filter(Boolean));
    const files = [
      ...new Set(
        (cfg.projects ?? [])
          .filter((p) => p.testDir)
          .flatMap((p) => {
            const match = testMatcher(p.testMatch);
            return listSpecFiles(p.testDir).filter((f) => !match || match(basename(f)));
          }),
      ),
    ].map((f) => relative(cfg.rootDir, f).split(sep).join("/"));
    for (const f of files.sort()) if (!reported.has(f)) out.push({ area: areaOf(f), name: `${basename(f)} contains no tests`, passed: false });
  }
  for (const e of json.errors ?? []) {
    const msg = String(e?.message ?? e?.value ?? "unknown error").split("\n")[0];
    out.push({ area: areaOf(), name: `Playwright could not run the tests: ${msg}`, passed: false });
  }
  // Nothing found, or every test skipped: no test ran, which is never a pass.
  if (!out.length) out.push({ area: areaOf(), name: "no tests ran", passed: false });
  return out;
}

/** `opts.listSpecFiles(dir)`: the spec files under a Playwright testDir (default: read from disk). */
export function buildReport(results = {}, opts = {}) {
  const list = opts.listSpecFiles;
  const checks = [
    ...(results.vitest ? fromVitest(results.vitest) : []),
    ...(results.pytest ? fromPytest(results.pytest) : []),
    ...(results.playwrightExtension ? fromPlaywright(results.playwrightExtension, undefined, list) : []),
    ...(results.playwrightApp ? fromPlaywright(results.playwrightApp, APP_E2E_AREA, list) : []),
    ...(results.playwrightDesktop ? fromPlaywright(results.playwrightDesktop, DESKTOP_E2E_AREA, list) : []),
    ...(results.playwright ? fromPlaywright(results.playwright, undefined, list) : []),
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
    playwrightDesktop: json("playwright-desktop.json"),
    playwright: json("playwright.json"),
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "test-report.md"), md);
  console.log(md);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
