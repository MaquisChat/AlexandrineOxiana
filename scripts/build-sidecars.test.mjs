import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ARM64_CONSTRAINTS, SMOKE_ABSENCES, applyConstraints, defaultConstraints, installRequirements, isCompletePinSet, manifestArgs, parseArgs, parseConstraints, targetTriple } from "../apps/desktop/scripts/build-sidecars.mjs";

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

test("each Mac takes its own constraints file by default; Linux and Windows none", () => {
  assert.match(defaultConstraints("darwin", "x64"), /constraints-macos-x86_64\.txt$/);
  // FR-730 (R503 j): Apple Silicon's pin set names every package of the bundle.
  assert.equal(defaultConstraints("darwin", "arm64"), ARM64_CONSTRAINTS);
  assert.match(ARM64_CONSTRAINTS, /services\/media-worker\/packaging\/constraints-macos-arm64\.txt$/);
  assert.equal(defaultConstraints("linux", "x64"), undefined);
  assert.equal(defaultConstraints("win32", "x64"), undefined);
});

test("Apple Silicon's constraints file is a complete pin set: the build checks the bundle against it and keeps the direct pins", () => {
  assert.equal(isCompletePinSet(ARM64_CONSTRAINTS), true);
  assert.equal(isCompletePinSet(defaultConstraints("darwin", "x64")), false);
  assert.equal(isCompletePinSet(undefined), false);
  const deps = ["faster-whisper==1.2.1", "rawpy==0.28.0"];
  const full = { file: ARM64_CONSTRAINTS, map: parseConstraints("rawpy==0.28.0\nfaster-whisper==1.2.1\n"), complete: true };
  // A complete set does not override pyproject.toml: a direct pin and its constraint that disagree stop pip.
  assert.deepEqual(installRequirements(deps, full), deps);
  assert.deepEqual(installRequirements(deps, { ...full, complete: false }), ["faster-whisper", "rawpy"]);
  const args = manifestArgs({ bundle: "/b", triple: "aarch64-apple-darwin", out: "/b/sidecar-manifest.json", c: { ...full, name: "macos-arm64" } });
  assert.deepEqual(args.slice(-5), ["--constraints", ARM64_CONSTRAINTS, "--pins-complete", "--out", "/b/sidecar-manifest.json"]);
  assert.ok(args.includes("--pin-set") && args[args.indexOf("--pin-set") + 1] === "macos-arm64");
  const partial = manifestArgs({ bundle: "/b", triple: "x", out: "/o", c: { file: "/i.txt", map: new Map(), name: "macos-x86_64", complete: false } });
  assert.ok(!partial.includes("--pins-complete") && partial.includes("/i.txt"));
  assert.ok(!manifestArgs({ bundle: "/b", triple: "x", out: "/o", c: { file: undefined, map: new Map(), name: "default", complete: false } }).includes("--constraints"));
});

test("Apple Silicon's constraints file pins every direct dependency at pyproject.toml's own version", () => {
  const pins = parseConstraints(readFileSync(ARM64_CONSTRAINTS, "utf8"));
  const pyproject = readFileSync(new URL("../services/media-worker/pyproject.toml", import.meta.url), "utf8");
  const block = /^dependencies = \[([\s\S]*?)^\]/m.exec(pyproject)[1];
  const direct = [...block.matchAll(/^\s*"([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(direct.length >= 9);
  const canon = (n) => n.toLowerCase().replace(/[-_.]+/g, "-");
  for (const d of direct) {
    const [name, version] = d.split("==");
    const pin = pins.get(canon(name));
    assert.ok(pin, `${name} is not in the constraints file`);
    assert.equal(pin.split("==")[1].trim(), version, `${name}: pyproject.toml pins ${version}, the constraints file ${pin}`);
  }
  // Build 10's bundle held 56 packages; every one is named.
  assert.ok(pins.size >= 56);
});

test("constraints files: names and pins, comments and blank lines ignored", () => {
  const c = parseConstraints("# comment\n\nonnxruntime==1.23.2\nPikePDF == 10.13.0.post1  # why\nrawpy==0.25.1\n");
  assert.deepEqual([...c.keys()], ["onnxruntime", "pikepdf", "rawpy"]);
  assert.equal(c.get("pikepdf"), "PikePDF == 10.13.0.post1");
  assert.throws(() => parseConstraints("rawpy>=0.25\n"), /exact pin/);
});

test("a constraints file that names one package twice is refused, naming it (R506 M3)", () => {
  // PEP 503: PyYAML and pyyaml are one package; pip refuses such a file too.
  assert.throws(() => parseConstraints("PyYAML==6.0.4\nrawpy==0.28.0\npyyaml==6.0.3\n"), /the constraints file names pyyaml twice \(PyYAML==6\.0\.4, pyyaml==6\.0\.3\)/);
  assert.throws(() => parseConstraints("pydantic_core==2.50.5\nPydantic.Core==2.50.5\n"), /names pydantic-core twice/);
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
