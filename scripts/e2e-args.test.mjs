import { test } from "node:test";
import assert from "node:assert/strict";
import { needsSuiteFlag, noResults, parseE2eArgs } from "./e2e-args.mjs";
import { buildReport } from "./test-report.mjs";

test("a suite that wrote no results is reported as a failure, never as nothing", () => {
  const md = buildReport({ playwrightApp: noResults("app", 1) });
  assert.match(md, /0 of 1 checks passed/);
  assert.match(md, /✗ The app end to end: Playwright could not run the tests: the app suite wrote no results \(exit status 1\)/);
});

test("the suite flag is found anywhere in argv (R116)", () => {
  assert.deepEqual(parseE2eArgs(["--", "--extension-only", "e2e/extension.spec.ts", "--trace", "off"]), { only: "extension", args: ["e2e/extension.spec.ts", "--trace", "off"] });
  assert.deepEqual(parseE2eArgs(["e2e/extension.spec.ts", "--extension-only", "--trace", "off"]), { only: "extension", args: ["e2e/extension.spec.ts", "--trace", "off"] });
  assert.deepEqual(parseE2eArgs(["--trace", "off", "--", "--desktop-only"]), { only: "desktop", args: ["--trace", "off"] });
  assert.deepEqual(parseE2eArgs([]), { only: undefined, args: [] });
  assert.deepEqual(parseE2eArgs(["--trace", "off"]), { only: undefined, args: ["--trace", "off"] });
});

test("--app-only selects the app suite, wherever it stands", () => {
  assert.deepEqual(parseE2eArgs(["--", "--app-only", "--trace", "off"]), { only: "app", args: ["--trace", "off"] });
  assert.deepEqual(parseE2eArgs(["smoke.spec.ts", "--app-only", "--project", "webkit"]), { only: "app", args: ["smoke.spec.ts", "--project", "webkit"] });
  assert.deepEqual(parseE2eArgs(["--app-only", "--app-only"]), { only: "app", args: [] });
});

test("both flags at once is an error", () => {
  assert.throws(() => parseE2eArgs(["--extension-only", "--desktop-only"]), /one of/);
  assert.throws(() => parseE2eArgs(["--app-only", "--extension-only"]), /one of/);
  assert.throws(() => parseE2eArgs(["--desktop-only", "--", "--app-only"]), /one of/);
});

test("extra arguments without a flag go nowhere by guess: the runner needs a flag", () => {
  assert.equal(needsSuiteFlag({ only: undefined, args: ["--trace", "off"] }), true);
  assert.equal(needsSuiteFlag({ only: undefined, args: [] }), false);
  assert.equal(needsSuiteFlag({ only: "app", args: ["--trace", "off"] }), false);
});
