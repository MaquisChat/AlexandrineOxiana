// Which Mac downloads a run of .github/workflows/desktop-macos.yml builds (Task 37f, R167 a): from the
// "Run workflow" choice, or from the tag that started it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { macTargets, RUNNERS } from "./mac-targets.mjs";

const both = [RUNNERS.arm64, RUNNERS.x64];

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
    // A plain version tag, or another pre-release, builds both.
    assert.deepEqual(tag("v0.4.0"), both);
    assert.deepEqual(tag("v0.4.0-rc.1"), both);
  });

  it("refuses a tag that is not a version, or names another version than the app's (tauri.conf.json)", () => {
    const tag = (t) => () => macTargets({ event: "push", ref: `refs/tags/${t}`, version: "0.4.0" });
    assert.throws(tag("v0.4.0junk"), /not a version tag/);
    assert.throws(tag("v0.4"), /not a version tag/);
    assert.throws(tag("v0.4.1-mac.1"), /0\.4\.1.*0\.4\.0/);
    assert.throws(tag("v0.4.0-arm"), /not a version tag/);
    assert.throws(() => macTargets({ event: "push", ref: "refs/heads/main", version: "0.4.0" }), /only from a tag/);
    assert.throws(() => macTargets({ event: "pull_request", version: "0.4.0" }), /only by hand or from a tag/);
  });

  it("names the runners R133 gives", () => {
    assert.deepEqual(RUNNERS.arm64, { runner: "macos-15", arch: "arm64", label: "apple-silicon" });
    assert.deepEqual(RUNNERS.x64, { runner: "macos-15-intel", arch: "x64", label: "intel" });
  });
});
