#!/usr/bin/env node
// Which Mac downloads a run of .github/workflows/desktop-macos.yml builds (Task 37f; R133, R167 a).
//
// APPLE SILICON ONLY (R169, the owner's decision of 2026-11-12): the Intel download is not built.
// INTEL_BUILDS below is the one switch. While it is off, a release tag builds Apple Silicon alone and
// anything that asks for Intel ("intel", "both", -intel.N, -mac.N) is refused in plain words and
// builds nothing. The Intel runner, pins and packaging stay in the repository, unused, so the
// decision can be reversed by the owner in one line.
//
//   Started by hand (Run workflow): "apple-silicon" (with Intel on: also "both" and "intel").
//   Started by a tag pushed from any branch (no need for the workflow to be on main):
//     vX.Y.Z-arm.N     Apple Silicon only
//     vX.Y.Z           a release: Apple Silicon (with Intel on: both)
//     vX.Y.Z-mac.N     both downloads      (refused while Intel is off)
//     vX.Y.Z-intel.N   Intel only          (refused while Intel is off)
//   Any other tag (a mistyped -arm1, -ARM.1, -rc.1, ...) builds nothing.
//   Started by a push to a branch that changed apps/desktop/mac-build-request.json (R168): what that
//   file asks for, {"request": <a whole number, raised by one for each build>, "architectures":
//   "apple-silicon"} (with Intel on: also "both" and "intel"). A branch push without a valid request
//   file builds nothing.
//   X.Y.Z must be the app's version (src-tauri/tauri.conf.json), so a mistyped tag fails here, in a
//   minute on Linux, instead of spending Mac minutes, and the disk image carries the tag's version.
//
//   node apps/desktop/scripts/mac-targets.mjs     (in the workflow: prints matrix=<JSON> for $GITHUB_OUTPUT)
// Reads GITHUB_EVENT_NAME, GITHUB_REF and INPUT_ARCHITECTURES.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RUNNERS = {
  arm64: { runner: "macos-15", arch: "arm64", label: "apple-silicon" },
  x64: { runner: "macos-15-intel", arch: "x64", label: "intel" },
};
const BOTH = [RUNNERS.arm64, RUNNERS.x64];

/** R169: the Intel download is not built. The owner's decision; `true` here reverses it. */
export const INTEL_BUILDS = false;

const BY_CHOICE = new Map([["both", BOTH], ["apple-silicon", [RUNNERS.arm64]], ["intel", [RUNNERS.x64]]]);

/** The targets asked for, or a refusal in plain words if they include Intel while Intel builds are off (R169). */
function allowed(targets, asked, intel) {
  if (!intel && targets.includes(RUNNERS.x64)) {
    throw new Error(`${asked} asks for the Intel download, and Intel builds are switched off: the app is built for Apple Silicon only (R169). Ask for apple-silicon`);
  }
  return targets;
}

/** What a build-request file asks for (R168). Throws in plain words if it is not a valid request. */
export function requestedTargets(text, { intel = INTEL_BUILDS } = {}) {
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    throw new Error("mac-build-request.json is not valid JSON");
  }
  if (r === null || typeof r !== "object" || Array.isArray(r)) throw new Error("mac-build-request.json must be an object");
  if (!Number.isInteger(r.request) || r.request < 1) throw new Error('mac-build-request.json: "request" must be a whole number, raised by one for each build asked for');
  const out = typeof r.architectures === "string" ? BY_CHOICE.get(r.architectures) : undefined;
  if (!out) throw new Error(`mac-build-request.json: "architectures" must be ${intel ? '"both", "apple-silicon" or "intel"' : '"apple-silicon"'}`);
  return allowed(out, `mac-build-request.json ("architectures": "${r.architectures}")`, intel);
}

/** The matrix entries for one run. Throws (in plain words) for a run that must build nothing. */
export function macTargets({ event, input, ref = "", version, request, intel = INTEL_BUILDS }) {
  if (event === "workflow_dispatch") {
    const choice = input || (intel ? "both" : "apple-silicon");
    const out = BY_CHOICE.get(choice);
    if (!out) throw new Error(`the choice must be ${intel ? "both, apple-silicon or intel" : "apple-silicon"}, not "${choice}"`);
    return allowed(out, `the choice "${choice}"`, intel);
  }
  if (event !== "push") throw new Error(`a Mac build starts only by hand or from a tag, not on ${event}`);
  if (ref.startsWith("refs/heads/")) {
    // A branch push reaches this workflow only when it changed the build-request file (the workflow's
    // `paths` filter); the file itself says what to build.
    if (typeof request !== "string") throw new Error(`a Mac build from the branch ${ref.slice("refs/heads/".length)} needs apps/desktop/mac-build-request.json`);
    return requestedTargets(request, { intel });
  }
  if (!ref.startsWith("refs/tags/")) throw new Error(`a Mac build starts only from a tag or a build request, not from ${ref}`);
  const tag = ref.slice("refs/tags/".length);
  // Only the exact documented forms build; anything else (a mistyped -arm1, -ARM.1, -arm.1.2, -rc.1)
  // stops here rather than falling back to building both, the costliest run.
  const m = /^v(\d+\.\d+\.\d+)(?:-(mac|arm|intel)\.(\d+))?$/.exec(tag);
  if (!m) throw new Error(`${tag} is not a version tag; the accepted forms: vX.Y.Z, vX.Y.Z-mac.N, vX.Y.Z-arm.N, vX.Y.Z-intel.N (N a number)`);
  if (m[1] !== version) throw new Error(`the tag ${tag} names version ${m[1]}, but the app's version (tauri.conf.json) is ${version}`);
  // A release (a plain vX.Y.Z) builds every download there is: Apple Silicon alone while Intel is off.
  if (m[2] === undefined) return intel ? BOTH : [RUNNERS.arm64];
  return allowed(m[2] === "arm" ? [RUNNERS.arm64] : m[2] === "intel" ? [RUNNERS.x64] : BOTH, `the tag ${tag}`, intel);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const conf = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "tauri.conf.json"), "utf8"));
    const requestFile = join(dirname(fileURLToPath(import.meta.url)), "..", "mac-build-request.json");
    const request = existsSync(requestFile) ? readFileSync(requestFile, "utf8") : undefined;
    const targets = macTargets({ event: process.env.GITHUB_EVENT_NAME, input: process.env.INPUT_ARCHITECTURES, ref: process.env.GITHUB_REF, version: conf.version, request });
    process.stderr.write(`mac-targets: ${targets.map((t) => `${t.label} on ${t.runner}`).join(", ")}\n`);
    process.stdout.write(`matrix=${JSON.stringify(targets)}\n`);
  } catch (e) {
    process.stderr.write(`mac-targets: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
