#!/usr/bin/env node
// Builds the desktop app's helper programs ("sidecars") for the machine it runs on. Today that is
// the media worker: a one-folder PyInstaller build of services/media-worker (Task 37d, R133).
//
//   node apps/desktop/scripts/build-sidecars.mjs [--smoke] [--constraints <file>|none] [--clean]
//   node apps/desktop/scripts/build-sidecars.mjs --skip-build --smoke     # smoke-test the last build
//   node apps/desktop/scripts/build-sidecars.mjs --resolve-for macos-x86_64   # check a pin set, no build
//   node apps/desktop/scripts/build-sidecars.mjs --skip-build --list-symlinks  # symbolic links in the bundle
//
// The smoke test fails when a fixture, the speech model or a tool it needs is missing.
// `--allow-missing model,clip,dng,ffmpeg,tesseract` (any of them) reports those absences as skips;
// never use it for a run that must prove the packaged worker (CI does not).
//
// Output (git-ignored): apps/desktop/sidecars/ao-worker-<target triple>/ with the executable
// `ao-worker` (`ao-worker.exe` on Windows), its `_internal/` folder and `sidecar-manifest.json`.
// Work files: apps/desktop/.build/ (a build venv per pin set, PyInstaller's work folder).
//
// Pin sets: the default pins of services/media-worker/pyproject.toml, or those plus a constraints
// file. A package named in the constraints file is pinned by it even where pyproject.toml pins it
// directly. On an Intel Mac, packaging/constraints-macos-x86_64.txt is used unless
// `--constraints none` is given. Every dependency must come as a wheel (--only-binary=:all:).
//
// Needs Python 3.12+ ($PYTHON, else python3.13 / python3.12 / python3) and network access to PyPI.
// `--smoke` runs services/media-worker/packaging/smoke_test.py, which needs ffmpeg, ffprobe and
// tesseract on this machine and may download the `tiny` speech model once (outside the bundle).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DESKTOP = join(REPO, "apps", "desktop");
const WORKER = join(REPO, "services", "media-worker");
const PACKAGING = join(WORKER, "packaging");
const BUILD = join(DESKTOP, ".build");
const OUT = join(DESKTOP, "sidecars");
const INTEL_CONSTRAINTS = join(PACKAGING, "constraints-macos-x86_64.txt");
// The same list as `ABSENCES` in packaging/smoke_test.py (scripts/build-sidecars.test.mjs checks). gallery-dl is
// not one: it is not inside the worker (R152), and the smoke run checks that a capture needing it names it.
export const SMOKE_ABSENCES = ["model", "clip", "dng", "ffmpeg", "tesseract"];
const RESOLVE_TARGETS = {
  "macos-x86_64": { platform: "macosx_15_0_x86_64", constraints: INTEL_CONSTRAINTS },
  "macos-arm64": { platform: "macosx_15_0_arm64", constraints: undefined },
};

// ---------- pure helpers (tested in scripts/build-sidecars.test.mjs) ----------

/** Rust target triple, as Tauri names sidecars. */
export function targetTriple(platform = process.platform, arch = process.arch) {
  const cpu = { x64: "x86_64", arm64: "aarch64" }[arch];
  const os = { darwin: "apple-darwin", linux: "unknown-linux-gnu", win32: "pc-windows-msvc" }[platform];
  if (!cpu || !os) throw new Error(`platform ${platform}/${arch} is not supported`);
  return `${cpu}-${os}`;
}

export function defaultConstraints(platform = process.platform, arch = process.arch) {
  return platform === "darwin" && arch === "x64" ? INTEL_CONSTRAINTS : undefined;
}

export function parseArgs(argv) {
  const out = { smoke: false, skipBuild: false, clean: false, constraints: undefined, resolveFor: undefined, noModelDownload: false, allowMissing: [], listSymlinks: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === "") throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--smoke") out.smoke = true;
    else if (flag === "--skip-build") out.skipBuild = true;
    else if (flag === "--clean") out.clean = true;
    else if (flag === "--no-model-download") out.noModelDownload = true;
    else if (flag === "--list-symlinks") out.listSymlinks = true;
    else if (flag === "--allow-missing") {
      out.allowMissing = value().split(",").map((x) => x.trim()).filter(Boolean);
      const bad = out.allowMissing.filter((x) => !SMOKE_ABSENCES.includes(x));
      if (bad.length) throw new Error(`--allow-missing takes ${SMOKE_ABSENCES.join(", ")}; not ${bad.join(", ")}`);
    }
    else if (flag === "--constraints") out.constraints = value();
    else if (flag === "--resolve-for") {
      out.resolveFor = value();
      if (!(out.resolveFor in RESOLVE_TARGETS)) throw new Error(`--resolve-for takes one of: ${Object.keys(RESOLVE_TARGETS).join(", ")}`);
    } else if (flag === "--") continue;
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return out;
}

const canonical = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");
const reqName = (req) => canonical(req.trim().split(/[\s<>=!~[;(]/, 1)[0]);

/** Constraint lines by canonical package name. Every line must be an exact `name==version` pin. */
export function parseConstraints(text) {
  const out = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\s*==\s*[^\s,;]+$/.test(line)) throw new Error(`constraints must be exact pins (name==version): ${line}`);
    out.set(reqName(line), line);
  }
  return out;
}

/** The requirements to install: a dependency named in `constraints` loses its own version (the constraint pins it). */
export function applyConstraints(requirements, constraints) {
  return requirements.map((r) => (constraints.has(reqName(r)) ? reqName(r) : r));
}

// ---------- running things ----------

function run(exe, args, opts = {}) {
  console.log(`> ${[relative(REPO, exe) || exe, ...args.map((a) => (a.startsWith(REPO) ? relative(REPO, a) : a))].join(" ")}`);
  const r = spawnSync(exe, args, { stdio: "inherit", cwd: REPO, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${exe} exited with ${r.status ?? r.signal}`);
  return r;
}

function capture(exe, args) {
  const r = spawnSync(exe, args, { encoding: "utf8", cwd: REPO });
  if (r.status !== 0) throw new Error(`${exe} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function findPython() {
  const win = process.platform === "win32";
  const candidates = process.env.PYTHON ? [process.env.PYTHON] : win ? ["py -3.13", "py -3.12", "python"] : ["python3.13", "python3.12", "python3"];
  for (const cmd of candidates) {
    const [exe, ...args] = cmd.split(" ");
    const r = spawnSync(exe, [...args, "-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"], { encoding: "utf8" });
    if (r.status !== 0) continue;
    const [maj, min] = r.stdout.trim().split(".").map(Number);
    if (maj === 3 && min >= 12) return { exe, args, version: `${maj}.${min}` };
  }
  throw new Error(`No Python 3.12+ found (tried: ${candidates.join(", ")}). Set PYTHON.`);
}

const venvPython = (venv) => join(venv, process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** A build venv for this pin set, recreated when pyproject.toml, the constraints or Python change. */
function ensureVenv(python, name, stampParts, clean) {
  const venv = join(BUILD, `venv-${name}`);
  const stampFile = join(venv, ".ao-stamp");
  const stamp = sha256(stampParts.join("\0"));
  if (clean || !existsSync(stampFile) || readFileSync(stampFile, "utf8") !== stamp) {
    rmSync(venv, { recursive: true, force: true });
    mkdirSync(BUILD, { recursive: true });
    run(python.exe, [...python.args, "-m", "venv", venv]);
    return { venv, py: venvPython(venv), stampFile, stamp, fresh: true };
  }
  return { venv, py: venvPython(venv), stampFile, stamp, fresh: false };
}

/** pyproject.toml's runtime dependencies and `packaging` extra, read with the venv's tomllib. */
function workerRequirements(py) {
  const code = "import json,tomllib,sys; p=tomllib.load(open(sys.argv[1],'rb'))['project']; print(json.dumps({'deps': p['dependencies'], 'packaging': p['optional-dependencies']['packaging']}))";
  return JSON.parse(capture(py, ["-I", "-c", code, join(WORKER, "pyproject.toml")]));
}

function loadConstraints(file) {
  if (!file) return { file: undefined, map: new Map(), name: "default" };
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`constraints file not found: ${file}`);
  const name = path === INTEL_CONSTRAINTS ? "macos-x86_64" : relative(PACKAGING, path).replace(/^constraints-|\.txt$/g, "").replace(/[^A-Za-z0-9_.-]/g, "_");
  return { file: path, map: parseConstraints(readFileSync(path, "utf8")), name };
}

const PIP = ["-m", "pip", "--disable-pip-version-check"];

function resolveFor(python, target) {
  const { platform, constraints } = RESOLVE_TARGETS[target];
  const c = loadConstraints(constraints);
  const { py } = ensureVenv(python, "resolve", [python.version, "resolve"], false);
  const { deps, packaging } = workerRequirements(py);
  const reqs = applyConstraints([...deps, ...packaging], c.map);
  const dir = join(BUILD, `resolve-${target}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const report = join(dir, "report.json");
  run(py, [...PIP, "install", "--dry-run", "--quiet", "--ignore-installed", "--only-binary=:all:", "--platform", platform,
    "--python-version", python.version, "--implementation", "cp", "--target", join(dir, "target"), "--report", report,
    ...(c.file ? ["-c", c.file] : []), ...reqs]);
  const installs = JSON.parse(readFileSync(report, "utf8")).install;
  console.log(`\n${target} (CPython ${python.version}, ${platform}), pin set "${c.name}": ${installs.length} wheels, no source builds`);
  for (const i of installs.sort((a, b) => canonical(a.metadata.name).localeCompare(canonical(b.metadata.name)))) {
    console.log(`  ${i.metadata.name} ${i.metadata.version}  ${i.download_info.url.split("/").pop()}`);
  }
}

// ---------- sizes ----------

function sizeOf(path) {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((n, e) => n + sizeOf(join(path, e)), 0);
}

function largestItems(bundle, n = 10) {
  const internal = join(bundle, "_internal");
  const items = [...readdirSync(bundle).filter((e) => e !== "_internal").map((e) => join(bundle, e)),
    ...readdirSync(internal).map((e) => join(internal, e))];
  return items.map((p) => ({ path: relative(bundle, p), bytes: sizeOf(p) })).sort((a, b) => b.bytes - a.bytes).slice(0, n);
}

const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;

/** Symbolic links inside the bundle (PyInstaller links shared libraries kept in `<pkg>.libs` or
 *  `.dylibs` into `_internal/`; they matter for macOS code signing and Tauri's resource copy). */
function symlinks(dir, base = dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) out.push({ path: relative(base, p), target: readlinkSync(p) });
    else if (st.isDirectory()) symlinks(p, base, out);
  }
  return out;
}

// ---------- main ----------

function build(python, opts, triple, bundle) {
  const c = loadConstraints(opts.constraints === "none" ? undefined : opts.constraints ?? defaultConstraints());
  const pyproject = readFileSync(join(WORKER, "pyproject.toml"));
  const v = ensureVenv(python, c.name, [python.version, sha256(pyproject), c.file ? sha256(readFileSync(c.file)) : "", "v1"], opts.clean);
  console.log(`pin set: ${c.name}${c.file ? ` (${relative(REPO, c.file)})` : ""}; build venv: ${relative(REPO, v.venv)}${v.fresh ? " (new)" : " (reused)"}`);
  if (v.fresh) {
    const { deps, packaging } = workerRequirements(v.py);
    run(v.py, [...PIP, "install", "--only-binary=:all:", ...(c.file ? ["-c", c.file] : []), ...applyConstraints([...deps, ...packaging], c.map)]);
  }
  // The worker itself, from this checkout, every time (its code is not part of the venv stamp).
  run(v.py, [...PIP, "install", "--quiet", "--no-deps", "--force-reinstall", WORKER]);
  writeFileSync(v.stampFile, v.stamp);

  const dist = join(BUILD, "dist");
  rmSync(dist, { recursive: true, force: true });
  const t0 = Date.now();
  run(v.py, ["-m", "PyInstaller", "--noconfirm", "--clean", "--log-level", "WARN", "--distpath", dist, "--workpath", join(BUILD, "work"),
    join(PACKAGING, "ao-worker.spec")]);
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  renameSync(join(dist, "ao-worker"), bundle);
  run(v.py, ["-I", join(PACKAGING, "manifest.py"), "--bundle", bundle, "--target", triple, "--pin-set", c.name,
    ...(c.file ? ["--constraints", c.file] : []), "--out", join(bundle, "sidecar-manifest.json")]);
  console.log(`\nbuilt ${relative(REPO, bundle)} in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${mb(sizeOf(bundle))} on disk. Largest items:`);
  for (const i of largestItems(bundle)) console.log(`  ${mb(i.bytes).padStart(9)}  ${i.path}`);
  console.log(`  ${symlinks(bundle).length} symbolic links inside (--skip-build --list-symlinks lists them)`);
  return v.py;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const python = findPython();
  if (opts.resolveFor) return resolveFor(python, opts.resolveFor);
  const triple = targetTriple();
  const bundle = join(OUT, `ao-worker-${triple}`);
  const exe = join(bundle, process.platform === "win32" ? "ao-worker.exe" : "ao-worker");
  let py;
  if (opts.skipBuild) {
    if (!existsSync(exe)) throw new Error(`no build at ${relative(REPO, bundle)}; run without --skip-build first`);
    const name = loadConstraints(opts.constraints === "none" ? undefined : opts.constraints ?? defaultConstraints()).name;
    py = venvPython(join(BUILD, `venv-${name}`));
    if (!existsSync(py)) throw new Error(`build venv ${relative(REPO, dirname(dirname(py)))} is missing; run without --skip-build`);
  } else {
    py = build(python, opts, triple, bundle);
  }
  if (opts.listSymlinks) {
    const links = symlinks(bundle);
    console.log(`${links.length} symbolic links in ${relative(REPO, bundle)}:`);
    for (const l of links) console.log(`  ${l.path} -> ${l.target}`);
  }
  if (opts.smoke) {
    // The manifest must list exactly what the bundle holds (every package and native library).
    run(py, ["-I", join(PACKAGING, "manifest.py"), "--bundle", bundle, "--out", join(bundle, "sidecar-manifest.json"), "--check"]);
    run(py, ["-I", join(PACKAGING, "smoke_test.py"), "--worker", exe, "--report", join(OUT, `ao-worker-${triple}.smoke.json`),
      ...(opts.noModelDownload ? ["--no-model-download"] : []),
      ...(opts.allowMissing.length ? ["--allow-missing", opts.allowMissing.join(",")] : [])]);
  }
  console.log(`\nworker: ${relative(REPO, exe)}  (AO_WORKER_BIN=${exe})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(`build-sidecars: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
