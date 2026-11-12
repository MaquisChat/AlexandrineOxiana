// Which Mac downloads a run of .github/workflows/desktop-macos.yml builds (Task 37f, R167 a): from the
// "Run workflow" choice, or from the tag that started it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { macTargets, requestedTargets, RUNNERS } from "./mac-targets.mjs";

const both = [RUNNERS.arm64, RUNNERS.x64];

describe("a build request (R168): a branch push that changed apps/desktop/mac-build-request.json", () => {
  const branch = (request) => macTargets({ event: "push", ref: "refs/heads/claude/some-branch", version: "0.4.0", request });

  it("builds what the request file names", () => {
    assert.deepEqual(branch('{"request": 1, "architectures": "apple-silicon"}'), [RUNNERS.arm64]);
    assert.deepEqual(branch('{"request": 7, "architectures": "intel", "note": "x"}'), [RUNNERS.x64]);
    assert.deepEqual(branch('{"request": 2, "architectures": "both"}'), both);
  });

  it("builds nothing from a branch push without a valid request", () => {
    assert.throws(() => branch(undefined), /needs apps\/desktop\/mac-build-request\.json/);
    assert.throws(() => branch("not json"), /not valid JSON/);
    assert.throws(() => branch("[]"), /must be an object/);
    assert.throws(() => branch("null"), /must be an object/);
    assert.throws(() => branch('{"architectures": "apple-silicon"}'), /"request" must be a whole number/);
    assert.throws(() => branch('{"request": 0, "architectures": "apple-silicon"}'), /"request" must be a whole number/);
    assert.throws(() => branch('{"request": 1.5, "architectures": "apple-silicon"}'), /"request" must be a whole number/);
    // A mistyped or missing choice never falls back to building both, the costliest run.
    for (const a of ['"arm"', '"Apple-Silicon"', '"constructor"', '"universal"', '""', "null", '["both"]', "1"]) {
      assert.throws(() => requestedTargets(`{"request": 1, "architectures": ${a}}`), /"architectures" must be/, a);
    }
    assert.throws(() => requestedTargets('{"request": 1}'), /"architectures" must be/);
  });

  it("the request file in the repository is a valid request", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("../mac-build-request.json", import.meta.url), "utf8");
    assert.ok(requestedTargets(text).length >= 1);
  });
});

describe("macTargets", () => {
  it("builds what the Run workflow choice says", () => {
    assert.deepEqual(macTargets({ event: "workflow_dispatch", input: "both", version: "0.0.0" }), both);
    assert.deepEqual(macTargets({ event: "workflow_dispatch", input: "apple-silicon", version: "0.0.0" }), [RUNNERS.arm64]);
    assert.deepEqual(macTargets({ event: "workflow_dispatch", input: "intel", version: "0.0.0" }), [RUNNERS.x64]);
    assert.deepEqual(macTargets({ event: "workflow_dispatch", input: "", version: "0.0.0" }), both);
    assert.throws(() => macTargets({ event: "workflow_dispatch", input: "universal", version: "0.0.0" }), /both, apple-silicon or intel/);
  });

  it("reads the architecture from a pre-release tag: -mac.N both, -arm.N Apple Silicon, -intel.N Intel", () => {
    const tag = (t) => macTargets({ event: "push", ref: `refs/tags/${t}`, version: "0.4.0" });
    assert.deepEqual(tag("v0.4.0-mac.1"), both);
    assert.deepEqual(tag("v0.4.0-arm.2"), [RUNNERS.arm64]);
    assert.deepEqual(tag("v0.4.0-intel.13"), [RUNNERS.x64]);
    // A plain version tag builds both.
    assert.deepEqual(tag("v0.4.0"), both);
  });

  it("refuses a tag that is not a version, or names another version than the app's (tauri.conf.json)", () => {
    const tag = (t) => () => macTargets({ event: "push", ref: `refs/tags/${t}`, version: "0.4.0" });
    assert.throws(tag("v0.4.0junk"), /not a version tag/);
    assert.throws(tag("v0.4"), /not a version tag/);
    assert.throws(tag("v0.4.1-mac.1"), /0\.4\.1.*0\.4\.0/);
    assert.throws(tag("v0.4.0-arm"), /not a version tag/);
    // A mistyped architecture must never fall back to building both (the costliest run).
    for (const t of ["v0.4.0-arm1", "v0.4.0-arm-1", "v0.4.0-ARM.1", "v0.4.0-arm.1.2", "v0.4.0-intel.", "v0.4.0-intel.x", "v0.4.0-macos.1", "v0.4.0-mac.1x", "v0.4.0-rc.1", "v0.4.0-Mac.1", "v0.4.0-arm.01a"]) {
      assert.throws(tag(t), /accepted forms: vX\.Y\.Z, vX\.Y\.Z-mac\.N, vX\.Y\.Z-arm\.N, vX\.Y\.Z-intel\.N/, t);
    }
    // A branch push with no request file builds nothing (with one, see the build-request tests above).
    assert.throws(() => macTargets({ event: "push", ref: "refs/heads/main", version: "0.4.0" }), /needs apps\/desktop\/mac-build-request\.json/);
    assert.throws(() => macTargets({ event: "push", ref: "refs/pull/1/merge", version: "0.4.0" }), /only from a tag or a build request/);
    assert.throws(() => macTargets({ event: "pull_request", version: "0.4.0" }), /only by hand or from a tag/);
  });

  it("names the runners R133 gives", () => {
    assert.deepEqual(RUNNERS.arm64, { runner: "macos-15", arch: "arm64", label: "apple-silicon" });
    assert.deepEqual(RUNNERS.x64, { runner: "macos-15-intel", arch: "x64", label: "intel" });
  });
});
