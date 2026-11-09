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
  "library.test.ts": "Library folder",
  "test-report.test.mjs": "Test report",
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

function fromPlaywright(json) {
  const out = [];
  const walk = (suite, file) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      const ok = (spec.tests ?? []).every((t) => ["expected", "skipped"].includes(t.status));
      out.push({ area: areaName(spec.file ?? f ?? "end-to-end"), name: spec.title, passed: ok });
    }
    for (const s of suite.suites ?? []) walk(s, f);
  };
  for (const s of json.suites ?? []) walk(s);
  return out;
}

export function buildReport(results = {}) {
  const checks = [
    ...(results.vitest ? fromVitest(results.vitest) : []),
    ...(results.pytest ? fromPytest(results.pytest) : []),
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
    playwright: json("playwright.json"),
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "test-report.md"), md);
  console.log(md);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
