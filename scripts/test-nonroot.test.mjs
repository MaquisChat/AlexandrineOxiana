// FR-421: the step that runs the tests skipped as root as another user (scripts/test-nonroot.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { NOBODY, byPackage, command, isRootSkipped, problems, rootSkippedFiles } from "./test-nonroot.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");

test("a file is found by how it skips as root: a name bound to getuid() === 0, used in skipIf or runIf(!…)", () => {
  assert.equal(isRootSkipped('const asRoot = process.getuid?.() === 0;\nit.skipIf(asRoot)("x", () => {});'), true);
  assert.equal(isRootSkipped('const asRoot = typeof process.getuid === "function" && process.getuid() === 0;\nit.skipIf(asRoot)("x", () => {});'), true);
  assert.equal(isRootSkipped('const root = process.getuid?.() === 0;\ndescribe.runIf(!root)("x", () => {});'), true);
  assert.equal(isRootSkipped('it.skipIf(process.getuid?.() === 0)("x", () => {});'), true);
  // Not skipped as root: a getuid that is not compared with 0, a name never used to skip, a test that runs ONLY as root.
  assert.equal(isRootSkipped("const uid = process.getuid?.();\nit.skipIf(uid)('x', () => {});"), false);
  assert.equal(isRootSkipped("const asRoot = process.getuid?.() === 0;\nit('x', () => { if (asRoot) return; });"), false);
  assert.equal(isRootSkipped("const CAN = process.getuid?.() === 0 && ok;\ntest.skip(!CAN, 'needs root');"), false);
  assert.equal(isRootSkipped("it.skipIf(!existsSync(f))('x', () => {});"), false);
});

test("the project's own: the three files that skip tests as root, and not the desktop's root-only end-to-end test", () => {
  const files = rootSkippedFiles(root);
  for (const f of ["packages/library/src/app-settings-strict.test.ts", "packages/library/src/import/zotero-sync-settings.test.ts", "apps/library-service/src/settings-files.test.ts"]) {
    assert.ok(files.includes(f), `${f} is found`);
  }
  assert.ok(!files.some((f) => f.includes("/e2e/")), "no end-to-end suite");
  assert.deepEqual(files, [...files].sort());
});

test("grouped by package, each path relative to its package", () => {
  assert.deepEqual(
    [...byPackage(["apps/library-service/src/a.test.ts", "packages/library/src/b.test.ts", "packages/library/src/x/c.test.ts"])],
    [
      ["apps/library-service", ["src/a.test.ts"]],
      ["packages/library", ["src/b.test.ts", "src/x/c.test.ts"]],
    ],
  );
});

test("as root the files run as nobody through setpriv (or runuser), with the configuration loaded without writing beside the package; otherwise directly", () => {
  const o = { node: "/usr/bin/node", vitest: "/r/node_modules/vitest/vitest.mjs", files: ["src/a.test.ts"], report: "/tmp/w/r.json" };
  const run = ["/usr/bin/node", "/r/node_modules/vitest/vitest.mjs", "run", "src/a.test.ts", "--configLoader", "runner", "--reporter=default", "--reporter=json", "--outputFile.json=/tmp/w/r.json"];
  assert.deepEqual(command({ ...o, asRoot: false }), run);
  assert.deepEqual(command({ ...o, asRoot: true, launcher: "setpriv" }), ["setpriv", `--reuid=${NOBODY.uid}`, `--regid=${NOBODY.gid}`, "--clear-groups", "--", ...run]);
  assert.deepEqual(command({ ...o, asRoot: true, launcher: "runuser" }), ["runuser", "-u", "nobody", "--", ...run]);
  assert.throws(() => command({ ...o, asRoot: true, launcher: undefined }), /Neither setpriv nor runuser/u);
});

test("a run fails when a file did not run, when any test is skipped, pending or failed, or when a file ran no test", () => {
  const pass = (n) => ({ fullName: n, status: "passed" });
  const report = (results) => ({ testResults: results.map(([f, assertionResults, status = "passed"]) => ({ name: `/r/p/${f}`, status, message: "", assertionResults })) });
  assert.deepEqual(problems(report([["src/a.test.ts", [pass("one"), pass("two")]]]), "/r/p", ["src/a.test.ts"]), []);
  assert.deepEqual(problems(report([["src/a.test.ts", [pass("one"), { fullName: "unreadable", status: "skipped" }]]]), "/r/p", ["src/a.test.ts"]), ['src/a.test.ts: "unreadable" skipped.']);
  assert.deepEqual(problems(report([["src/a.test.ts", [{ fullName: "x", status: "pending" }]]]), "/r/p", ["src/a.test.ts"]), ['src/a.test.ts: "x" pending.']);
  assert.deepEqual(problems(report([["src/a.test.ts", [{ fullName: "x", status: "failed" }]], "failed"]), "/r/p", ["src/a.test.ts"]), ['src/a.test.ts: "x" failed.']);
  assert.deepEqual(problems(report([]), "/r/p", ["src/a.test.ts"]), ["src/a.test.ts: did not run."]);
  assert.deepEqual(problems(report([["src/a.test.ts", [], "failed"]]), "/r/p", ["src/a.test.ts"]), ["src/a.test.ts: no test ran (failed).", "src/a.test.ts: failed."]);
  assert.deepEqual(problems(undefined, "/r/p", ["src/a.test.ts"]), ["Vitest wrote no report."]);
});
