import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SMOKE_ABSENCES, applyConstraints, defaultConstraints, parseArgs, parseConstraints, targetTriple } from "../apps/desktop/scripts/build-sidecars.mjs";

test("target triples follow Tauri's sidecar names", () => {
  assert.equal(targetTriple("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(targetTriple("darwin", "x64"), "x86_64-apple-darwin");
  assert.equal(targetTriple("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(targetTriple("linux", "arm64"), "aarch64-unknown-linux-gnu");
  assert.equal(targetTriple("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.throws(() => targetTriple("freebsd", "x64"), /not supported/);
});

test("arguments", () => {
  const none = { smoke: false, skipBuild: false, clean: false, constraints: undefined, resolveFor: undefined, noModelDownload: false, allowMissing: [], listSymlinks: false };
  assert.deepEqual(parseArgs([]), none);
  assert.deepEqual(parseArgs(["--smoke", "--constraints", "c.txt"]), { ...none, smoke: true, constraints: "c.txt" });
  assert.equal(parseArgs(["--constraints=none"]).constraints, "none");
  assert.equal(parseArgs(["--resolve-for", "macos-x86_64"]).resolveFor, "macos-x86_64");
  assert.equal(parseArgs(["--skip-build", "--smoke", "--no-model-download"]).noModelDownload, true);
  assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
  assert.throws(() => parseArgs(["--constraints"]), /needs a value/);
  assert.throws(() => parseArgs(["--resolve-for", "windows"]), /macos-x86_64/);
});

test("--allow-missing names absences the smoke test may skip; nothing is allowed by default", () => {
  assert.deepEqual(parseArgs(["--smoke", "--allow-missing", "model,dng"]).allowMissing, ["model", "dng"]);
  assert.deepEqual(parseArgs(["--allow-missing=clip"]).allowMissing, ["clip"]);
  assert.throws(() => parseArgs(["--allow-missing", "model,everything"]), /model, clip, dng, ffmpeg, tesseract/);
  assert.equal(parseArgs(["--list-symlinks", "--skip-build"]).listSymlinks, true);
});

test("the Intel constraints file is chosen by default on an Intel Mac only", () => {
  assert.match(defaultConstraints("darwin", "x64"), /constraints-macos-x86_64\.txt$/);
  assert.equal(defaultConstraints("darwin", "arm64"), undefined);
  assert.equal(defaultConstraints("linux", "x64"), undefined);
});

test("constraints files: names and pins, comments and blank lines ignored", () => {
  const c = parseConstraints("# comment\n\nonnxruntime==1.23.2\nPikePDF == 10.13.0.post1  # why\nrawpy==0.25.1\n");
  assert.deepEqual([...c.keys()], ["onnxruntime", "pikepdf", "rawpy"]);
  assert.equal(c.get("pikepdf"), "PikePDF == 10.13.0.post1");
  assert.throws(() => parseConstraints("rawpy>=0.25\n"), /exact pin/);
});

test("a package named in the constraints loses its direct pin; others keep theirs", () => {
  const deps = ["faster-whisper==1.2.1", "rawpy==0.28.0", "ocrmypdf==17.14.1", "numpy>=2.1,<3", "pillow_heif==1.8.1"];
  const c = parseConstraints("rawpy==0.25.1\nOCRmyPDF==17.12.1\nonnxruntime==1.23.2\n");
  assert.deepEqual(applyConstraints(deps, c), ["faster-whisper==1.2.1", "rawpy", "ocrmypdf", "numpy>=2.1,<3", "pillow_heif==1.8.1"]);
  assert.deepEqual(applyConstraints(deps, new Map()), deps);
});

test("the build script and the smoke test agree on the absences a smoke run may skip (R152: gallery-dl is not one)", () => {
  const smoke = readFileSync(new URL("../services/media-worker/packaging/smoke_test.py", import.meta.url), "utf8");
  const m = /^ABSENCES = \(([^)]*)\)/m.exec(smoke);
  assert.ok(m, "ABSENCES not found in smoke_test.py");
  const names = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(names, SMOKE_ABSENCES);
  assert.ok(!names.includes("gallery-dl"));
  // the CI invocation passes no wheel and no allowance: the smoke run must pass as it is
  assert.doesNotMatch(smoke, /res\.missing\([^)]*"gallery-dl"/);
});
