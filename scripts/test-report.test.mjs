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
