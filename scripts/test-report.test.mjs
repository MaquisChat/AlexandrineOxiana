import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "./test-report.mjs";

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
