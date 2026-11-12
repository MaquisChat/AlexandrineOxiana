import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, isSpecFile } from "./test-report.mjs";
import { noResults } from "./e2e-args.mjs";

const vitest = {
  testResults: [
    {
      name: "/repo/packages/core/test/naming.test.ts",
      assertionResults: [
        { ancestorTitles: [], title: "makes safe file names", status: "passed" },
        { ancestorTitles: [], title: "keeps Arabic titles readable", status: "failed" },
      ],
    },
    {
      name: "/repo/packages/core/test/ids.test.ts",
      assertionResults: [
        { ancestorTitles: [], title: "creates unique ids", status: "passed" },
        { ancestorTitles: [], title: "sorts ids by time", status: "passed" },
      ],
    },
  ],
};

test("report summarises counts and names failures in plain language", () => {
  const md = buildReport({ vitest });
  assert.match(md, /## Summary/);
  assert.match(md, /3 of 4 checks passed/);
  assert.match(md, /✗ File naming: keeps Arabic titles readable/);
  assert.match(md, /✓ IDs: creates unique ids/);
});

test("report reads pytest junit xml and handles no input", () => {
  const xml = `<testsuites><testsuite><testcase classname="tests.test_langdetect" name="detects_arabic"/><testcase classname="tests.test_langdetect" name="detects_hindi"><failure message="x"/></testcase></testsuite></testsuites>`;
  const md = buildReport({ pytest: xml });
  assert.match(md, /1 of 2 checks passed/);
  assert.match(md, /✗ .*: detects hindi/);
  assert.match(buildReport({}), /No test results found/);
});

// Playwright JSON reporter output (shape as written by @playwright/test 1.63).
const pwSpec = (title, statuses, file = "smoke.spec.ts") => ({ title, file, tests: statuses.map((status) => ({ projectName: "chromium", status })) });
const pwRun = (specs, extra = {}) => ({ suites: [{ title: "smoke.spec.ts", file: "smoke.spec.ts", specs, suites: [] }], errors: [], ...extra });

test("app end-to-end results are reported under a plain-language area", () => {
  const md = buildReport({ playwrightApp: pwRun([pwSpec("creates a library at a typed folder", ["expected", "expected"])]) });
  assert.match(md, /1 of 1 checks passed/);
  assert.match(md, /✓ The app end to end: creates a library at a typed folder/);
});

test("extension and app end-to-end results are both read", () => {
  const ext = { suites: [{ title: "extension.spec.ts", file: "extension.spec.ts", specs: [pwSpec("captures a post", ["expected"], "extension.spec.ts")] }], errors: [] };
  const md = buildReport({ playwrightExtension: ext, playwrightApp: pwRun([pwSpec("lists the project", ["unexpected"])]) });
  assert.match(md, /1 of 2 checks passed/);
  assert.match(md, /✓ Extension: captures a post/);
  assert.match(md, /✗ The app end to end: lists the project/);
});

test("a Playwright spec with no test that ran is not a pass", () => {
  const md = buildReport({ playwrightApp: pwRun([pwSpec("an empty spec", [])]) });
  assert.doesNotMatch(md, /1 of 1 checks passed/);
  assert.match(md, /✗ The app end to end: an empty spec/);
});

test("a Playwright spec file containing no tests is not a pass", () => {
  const run = { suites: [{ title: "empty.spec.ts", file: "empty.spec.ts", specs: [], suites: [] }], errors: [] };
  const md = buildReport({ playwrightApp: run });
  assert.match(md, /0 of 1 checks passed/);
  assert.match(md, /✗ The app end to end: empty\.spec\.ts contains no tests/);
});

// What Playwright 1.63 actually writes for a run over smoke.spec.ts and a spec file with no tests in
// it: the empty file does not appear in `suites` at all, so it is found from the files on disk.
const pwConfig = (argv) => ({ rootDir: "/repo/e2e", projects: [{ name: "chromium", testDir: "/repo/e2e" }], argv: ["/usr/bin/node", "/repo/e2e/node_modules/@playwright/test/cli.js", "test", ...argv] });
const onDisk = (dir) => (dir === "/repo/e2e" ? ["/repo/e2e/smoke.spec.ts", "/repo/e2e/empty.spec.ts"] : []);

test("a spec file on disk that the run did not report contains no tests: not a pass", () => {
  const run = pwRun([pwSpec("works", ["expected"])], { config: pwConfig(["--trace", "off", "--project", "chromium"]) });
  const md = buildReport({ playwrightApp: run }, { listSpecFiles: onDisk });
  assert.match(md, /1 of 2 checks passed/);
  assert.match(md, /✗ The app end to end: empty\.spec\.ts contains no tests/);
});

test("a run narrowed to some spec files does not flag the files it was not asked to run", () => {
  const run = pwRun([pwSpec("works", ["expected"])], { config: pwConfig(["smoke.spec.ts", "--trace", "off"]) });
  assert.match(buildReport({ playwrightApp: run }, { listSpecFiles: onDisk }), /1 of 1 checks passed/);
  const grep = pwRun([pwSpec("works", ["expected"])], { config: pwConfig(["--grep", "works"]) });
  assert.match(buildReport({ playwrightApp: grep }, { listSpecFiles: onDisk }), /1 of 1 checks passed/);
});

test("a Playwright run that found no tests or failed to start is not a pass", () => {
  const md = buildReport({ playwrightApp: { suites: [], errors: [{ message: "Error: No tests found" }] } });
  assert.match(md, /0 of 1 checks passed/);
  assert.match(md, /✗ The app end to end: Playwright could not run the tests: Error: No tests found/);
  assert.match(buildReport({ playwrightApp: { suites: [], errors: [] } }), /✗ The app end to end: no tests ran/);
});

test("skipped Playwright tests are left out, as skipped unit tests are", () => {
  const md = buildReport({ playwrightApp: pwRun([pwSpec("works", ["expected"]), pwSpec("creates a project in the UI", ["skipped", "skipped"])]) });
  assert.match(md, /1 of 1 checks passed/);
  assert.doesNotMatch(md, /creates a project in the UI/);
});

test("a flaky Playwright test (passed only on retry) needs attention", () => {
  const md = buildReport({ playwrightApp: pwRun([pwSpec("works", ["flaky"])]) });
  assert.match(md, /✗ The app end to end: works/);
});

// The desktop app end to end (apps/desktop/e2e, `pnpm e2e -- --desktop-only`): its own area, and a
// run that found or ran no tests is never a pass.
const desktopRun = (specs, extra = {}) => ({ suites: [{ title: "desktop.e2e.ts", file: "desktop.e2e.ts", specs, suites: [] }], errors: [], ...extra });

test("desktop end-to-end results are reported under their own plain-language area", () => {
  const md = buildReport({ playwrightDesktop: desktopRun([pwSpec("creates a library in the real window", ["expected"], "desktop.e2e.ts")]) });
  assert.match(md, /1 of 1 checks passed/);
  assert.match(md, /✓ The desktop app end to end: creates a library in the real window/);
});

test("a desktop suite that wrote no results, or ran no test, is not a pass", () => {
  assert.match(buildReport({ playwrightDesktop: noResults("desktop", 1) }), /✗ The desktop app end to end: Playwright could not run the tests: the desktop suite wrote no results \(exit status 1\)/);
  assert.match(buildReport({ playwrightDesktop: { suites: [], errors: [] } }), /✗ The desktop app end to end: no tests ran/);
  const allSkipped = buildReport({ playwrightDesktop: desktopRun([pwSpec("creates a library in the real window", ["skipped"], "desktop.e2e.ts")]) });
  assert.match(allSkipped, /0 of 1 checks passed/);
  assert.match(allSkipped, /✗ The desktop app end to end: no tests ran/);
});

test("the desktop spec file (*.e2e.ts, kept out of Vitest's way) counts as a spec file on disk", () => {
  assert.equal(isSpecFile("desktop.e2e.ts"), true);
  assert.equal(isSpecFile("smoke.spec.ts"), true);
  assert.equal(isSpecFile("webdriver.test.ts"), true);
  assert.equal(isSpecFile("webdriver.ts"), false);
  assert.equal(isSpecFile("playwright.config.ts"), false);
  const run = desktopRun([pwSpec("works", ["expected"], "desktop.e2e.ts")], {
    config: { rootDir: "/repo/apps/desktop/e2e", projects: [{ name: "desktop", testDir: "/repo/apps/desktop/e2e" }], argv: ["node", "cli.js", "test", "-c", "e2e/playwright.config.ts"] },
  });
  const md = buildReport({ playwrightDesktop: run }, { listSpecFiles: () => ["/repo/apps/desktop/e2e/desktop.e2e.ts", "/repo/apps/desktop/e2e/other.e2e.ts"] });
  assert.match(md, /✗ The desktop app end to end: other\.e2e\.ts contains no tests/);
});

test("files the project's testMatch leaves out (the desktop suite's Vitest unit tests beside it) are not spec files of that run", () => {
  const run = desktopRun([pwSpec("works", ["expected"], "desktop.e2e.ts")], {
    config: { rootDir: "/repo/apps/desktop/e2e", projects: [{ name: "desktop", testDir: "/repo/apps/desktop/e2e", testMatch: ["*.e2e.ts"] }], argv: ["node", "cli.js", "test", "-c", "e2e/playwright.config.ts"] },
  });
  const files = () => ["/repo/apps/desktop/e2e/desktop.e2e.ts", "/repo/apps/desktop/e2e/webdriver.test.ts", "/repo/apps/desktop/e2e/sub/other.e2e.ts"];
  const md = buildReport({ playwrightDesktop: run }, { listSpecFiles: files });
  assert.doesNotMatch(md, /webdriver\.test\.ts/);
  assert.match(md, /✗ The desktop app end to end: other\.e2e\.ts contains no tests/);
  assert.match(md, /1 of 2 checks passed/);
});

test("a testMatch this report cannot read (Playwright's default extended glob) falls back to the usual spec-file names", () => {
  const run = desktopRun([pwSpec("works", ["expected"], "desktop.e2e.ts")], {
    config: { rootDir: "/r", projects: [{ name: "p", testDir: "/r", testMatch: ["**/*.@(spec|test).?(c|m)[jt]s?(x)"] }], argv: ["node", "cli.js", "test"] },
  });
  assert.match(buildReport({ playwrightDesktop: run }, { listSpecFiles: () => ["/r/desktop.e2e.ts", "/r/a.test.ts"] }), /✗ The desktop app end to end: a\.test\.ts contains no tests/);
});
