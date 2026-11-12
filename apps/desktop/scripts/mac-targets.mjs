#!/usr/bin/env node
// Which Mac downloads a run of .github/workflows/desktop-macos.yml builds (Task 37f; R133, R167 a).
//
//   Started by hand (Run workflow): the choice "both", "apple-silicon" or "intel".
//   Started by a tag pushed from any branch (no need for the workflow to be on main):
//     vX.Y.Z-mac.N     both downloads
//     vX.Y.Z-arm.N     Apple Silicon only
//     vX.Y.Z-intel.N   Intel only
//     vX.Y.Z           both (a release)
//   Any other tag (a mistyped -arm1, -ARM.1, -rc.1, ...) builds nothing.
//   X.Y.Z must be the app's version (src-tauri/tauri.conf.json), so a mistyped tag fails here, in a
//   minute on Linux, instead of spending Mac minutes, and the disk image carries the tag's version.
//
//   node apps/desktop/scripts/mac-targets.mjs     (in the workflow: prints matrix=<JSON> for $GITHUB_OUTPUT)
// Reads GITHUB_EVENT_NAME, GITHUB_REF and INPUT_ARCHITECTURES.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RUNNERS = {
  arm64: { runner: "macos-15", arch: "arm64", label: "apple-silicon" },
  x64: { runner: "macos-15-intel", arch: "x64", label: "intel" },
};
const BOTH = [RUNNERS.arm64, RUNNERS.x64];

/** The matrix entries for one run. Throws (in plain words) for a run that must build nothing. */
export function macTargets({ event, input, ref = "", version }) {
  if (event === "workflow_dispatch") {
    const choice = input || "both";
    const out = { both: BOTH, "apple-silicon": [RUNNERS.arm64], intel: [RUNNERS.x64] }[choice];
    if (!out) throw new Error(`the choice must be both, apple-silicon or intel, not "${choice}"`);
    return out;
  }
  if (event !== "push") throw new Error(`a Mac build starts only by hand or from a tag, not on ${event}`);
  if (!ref.startsWith("refs/tags/")) throw new Error(`a Mac build starts only from a tag, not from ${ref}`);
  const tag = ref.slice("refs/tags/".length);
  // Only the exact documented forms build; anything else (a mistyped -arm1, -ARM.1, -arm.1.2, -rc.1)
  // stops here rather than falling back to building both, the costliest run.
  const m = /^v(\d+\.\d+\.\d+)(?:-(mac|arm|intel)\.(\d+))?$/.exec(tag);
  if (!m) throw new Error(`${tag} is not a version tag; the accepted forms: vX.Y.Z, vX.Y.Z-mac.N, vX.Y.Z-arm.N, vX.Y.Z-intel.N (N a number)`);
  if (m[1] !== version) throw new Error(`the tag ${tag} names version ${m[1]}, but the app's version (tauri.conf.json) is ${version}`);
  return m[2] === "arm" ? [RUNNERS.arm64] : m[2] === "intel" ? [RUNNERS.x64] : BOTH;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const conf = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "tauri.conf.json"), "utf8"));
    const targets = macTargets({ event: process.env.GITHUB_EVENT_NAME, input: process.env.INPUT_ARCHITECTURES, ref: process.env.GITHUB_REF, version: conf.version });
    process.stderr.write(`mac-targets: ${targets.map((t) => `${t.label} on ${t.runner}`).join(", ")}\n`);
    process.stdout.write(`matrix=${JSON.stringify(targets)}\n`);
  } catch (e) {
    process.stderr.write(`mac-targets: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
