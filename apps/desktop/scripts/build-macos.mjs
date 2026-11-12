#!/usr/bin/env node
// Builds the Mac app for the Mac it runs on (Task 37f; R133: Apple Silicon on macos-15, Intel on
// macos-15-intel, two downloads, no combined app; minimum macOS 15.0). In order:
//
//   node        the pinned Node.js release for this architecture (macos/pins.json), downloaded once
//               into .build/node/, checked against its pinned SHA-256 before anything is extracted
//   service     the library service folder, built with that Node first on PATH, so its native modules
//               are darwin ones for this architecture and Node ABI
//   build-info  the folder's build-info.json must name darwin, this architecture and the pinned Node
//   worker      the packaged media worker (build-sidecars.mjs; the Intel build on its own pin set,
//               packaging/constraints-macos-x86_64.txt, ADR 0014)
//   notices     the helpers' notices and licence texts, and notices.mjs with --node <the pinned
//               release's bin/node> (whose LICENSE ships, ADR 0015)
//   interface   packages/ui/dist (it embeds the notices)
//   stage       .build/macos-resources/{node/node, library-service/, ao-worker/}: what
//               src-tauri/tauri.macos.conf.json copies into Contents/Resources, where the shell looks
//               (src-tauri/src/paths.rs); symbolic links in the worker are kept
//   tauri       `cargo tauri build --bundles app --no-sign` (tauri-cli at the version in pins.json),
//               MACOSX_DEPLOYMENT_TARGET=15.0; with --debug-app also the debug build as an .app, for
//               the launch check (only a debug build reports what the check reads, R47)
//   sign        macos/signing.json: today ad hoc (R151), inside out, then `codesign --verify`
//   min-os      every Mach-O file in the app must run on macOS 15.0 (LC_BUILD_VERSION, read here)
//   dmg         dist-macos/Alexandrine-Oxiana-<version>-<apple-silicon|intel>.dmg (hdiutil) and its
//               .sha256 file
//
//   node apps/desktop/scripts/build-macos.mjs [--debug-app]
//   node apps/desktop/scripts/build-macos.mjs --dry-run [--arch arm64|x64] [--debug-app]   (any system: prints the plan)
//
// Needs (the workflow .github/workflows/desktop-macos.yml installs them): macOS 15, the pinned Node
// on PATH for pnpm, pnpm, Python 3.13 ($PYTHON), Rust 1.97, tauri-cli (`cargo tauri`), Xcode's
// command-line tools (codesign, hdiutil, ditto, xattr). The pure parts are tested in build-macos.test.mjs.
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildInterface, buildServiceFolder, copyHelperNotices, DESKTOP, NOTICES, REPO, SERVICE_DIR, SIDECARS, stepper, TAURI, writeShellNotices } from "./build-common.mjs";
import { ensureNodeRelease, nodePin, PINS } from "./node-release.mjs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
export const BASE_CONF = read(join(TAURI, "tauri.conf.json"));
export const MACOS_CONF = read(join(TAURI, "tauri.macos.conf.json"));
export const SIGNING = read(join(DESKTOP, "macos", "signing.json"));
const BUILD = join(DESKTOP, ".build");
const STAGE = join(BUILD, "macos-resources");
/** The staging folder as tauri.macos.conf.json names it (relative to src-tauri). */
export const STAGE_FROM_TAURI = relative(TAURI, STAGE);
const OUT = join(DESKTOP, "dist-macos");
const INTEL_CONSTRAINTS = join(REPO, "services", "media-worker", "packaging", "constraints-macos-x86_64.txt");
const PRODUCT = BASE_CONF.productName;
const BINARY = BASE_CONF.mainBinaryName;

/** Where the shell finds each helper, relative to Contents/Resources (src-tauri/src/paths.rs). */
export const RESOURCE_LAYOUT = { node: "node/node", serviceEntry: "library-service/service.mjs", worker: "ao-worker/ao-worker" };

// ---------- pure helpers (tested in build-macos.test.mjs) ----------

export function parseArgs(argv) {
  const out = { dryRun: false, debugApp: false, arch: undefined };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    if (flag === "--") continue;
    else if (flag === "--dry-run") out.dryRun = true;
    else if (flag === "--debug-app") out.debugApp = true;
    else if (flag === "--arch") {
      out.arch = inline ?? argv[++i];
      if (!["arm64", "x64"].includes(out.arch)) throw new Error("--arch takes arm64 or x64");
    } else throw new Error(`unknown option ${argv[i]}`);
  }
  if (out.arch && !out.dryRun) throw new Error("--arch is for --dry-run only: a real build is for the Mac it runs on");
  return out;
}

/** What differs between the two downloads. */
export function macosTarget(arch) {
  const t = { arm64: { triple: "aarch64-apple-darwin", label: "apple-silicon" }, x64: { triple: "x86_64-apple-darwin", label: "intel" } }[arch];
  if (!t) throw new Error(`a Mac build is for arm64 or x64, not ${arch}`);
  return {
    arch,
    ...t,
    node: nodePin("darwin", arch),
    workerArgs: ["--constraints", arch === "x64" ? INTEL_CONSTRAINTS : "none"],
    workerBundle: join(SIDECARS, `ao-worker-${t.triple}`),
    dmgName: (version) => `${PRODUCT.replaceAll(" ", "-")}-${version}-${t.label}.dmg`,
  };
}

/** Copies the three helpers into `stageDir` in the layout the app's resources need. */
export function stageResources({ nodeExe, serviceDir, workerBundle, stageDir }) {
  if (!existsSync(join(serviceDir, "service.mjs"))) throw new Error(`the service folder ${serviceDir} has no service.mjs; build it first`);
  if (!existsSync(join(workerBundle, "ao-worker"))) throw new Error(`there is no packaged worker at ${workerBundle} (build-sidecars.mjs)`);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(join(stageDir, "node"), { recursive: true });
  copyFileSync(nodeExe, join(stageDir, RESOURCE_LAYOUT.node));
  chmodSync(join(stageDir, RESOURCE_LAYOUT.node), 0o755);
  cpSync(serviceDir, join(stageDir, "library-service"), { recursive: true, verbatimSymlinks: true });
  // PyInstaller links shared libraries into _internal/ with relative symbolic links: kept as links.
  cpSync(workerBundle, join(stageDir, "ao-worker"), { recursive: true, verbatimSymlinks: true });
}

/** Problems with the service folder's build-info.json for this Mac and the pinned Node (empty when right). */
export function checkBuildInfo(info, { arch, nodeVersion }) {
  const out = [];
  if (info?.platform !== "darwin") out.push(`the service folder was built for ${info?.platform}, not darwin`);
  if (info?.arch !== arch) out.push(`the service folder was built for ${info?.arch}, not ${arch}`);
  if (info?.node !== nodeVersion) out.push(`the service folder was built by Node ${info?.node}, not the pinned ${nodeVersion} it ships with`);
  return out;
}

const CPU = { 0x0100000c: "arm64", 0x01000007: "x86_64", 7: "i386", 12: "arm" };
const LC_BUILD_VERSION = 0x32;
const LC_VERSION_MIN_MACOSX = 0x24;
const version = (v) => `${v >>> 16}.${(v >>> 8) & 0xff}${v & 0xff ? `.${v & 0xff}` : ""}`;

/**
 * The minimum macOS of each slice of a Mach-O file ([{cpu, minos}], minos null when the file states
 * none), or null when it is not a Mach-O file. `src` is a Buffer or a function (offset, length) → Buffer.
 */
export function machoMinOs(src) {
  const at = typeof src === "function" ? src : (o, n) => src.subarray(o, o + n);
  const head = at(0, 8);
  if (head.length < 8) return null;
  const be = head.readUInt32BE(0);
  if (be === 0xcafebabe || be === 0xcafebabf) {
    // Universal file. Java class files share the magic; their "count" is a version number (45 and up).
    const n = head.readUInt32BE(4);
    if (n === 0 || n > 20) return null;
    const wide = be === 0xcafebabf;
    const size = wide ? 32 : 20;
    const table = at(8, n * size);
    if (table.length < n * size) return null;
    const out = [];
    for (let i = 0; i < n; i++) {
      const offset = wide ? Number(table.readBigUInt64BE(i * size + 8)) : table.readUInt32BE(i * size + 8);
      const slice = thinMinOs((o, len) => at(offset + o, len));
      if (!slice) return null;
      out.push(slice);
    }
    return out;
  }
  const one = thinMinOs(at);
  return one ? [one] : null;
}

function thinMinOs(at) {
  const h = at(0, 32);
  if (h.length < 28) return null;
  const magic = h.readUInt32LE(0);
  if (magic !== 0xfeedfacf && magic !== 0xfeedface) return null;
  const header = magic === 0xfeedfacf ? 32 : 28;
  const cpu = CPU[h.readUInt32LE(4)] ?? `cpu ${h.readUInt32LE(4)}`;
  const ncmds = h.readUInt32LE(16);
  const sizeofcmds = h.readUInt32LE(20);
  const cmds = at(header, sizeofcmds);
  let minos = null;
  for (let i = 0, p = 0; i < ncmds && p + 8 <= cmds.length; i++) {
    const cmd = cmds.readUInt32LE(p);
    const size = cmds.readUInt32LE(p + 4);
    if (cmd === LC_BUILD_VERSION && p + 16 <= cmds.length) minos = version(cmds.readUInt32LE(p + 12));
    else if (cmd === LC_VERSION_MIN_MACOSX && p + 12 <= cmds.length) minos = version(cmds.readUInt32LE(p + 8));
    if (size < 8) break;
    p += size;
  }
  return { cpu, minos };
}

const newer = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/** Each file that needs a newer macOS than `minimum` (files: [{path, slices}]). */
export function minOsProblems(files, minimum) {
  return files.flatMap((f) => f.slices.filter((s) => s.minos && newer(s.minos, minimum)).map((s) => `${f.path} (${s.cpu}) needs macOS ${s.minos}, newer than the minimum ${minimum}`));
}

/**
 * The codesign calls, in order: the Mach-O files inside the app deepest first, then the shell's
 * program, then the app. Ad hoc ("-"), only files without a valid signature are signed (PyInstaller
 * and the Node.js release sign their own); with an identity, every file, with a secure timestamp, the
 * hardened runtime when configured and the entitlements of its part (app, node, worker).
 */
export function signingPlan({ app, machO, signing }) {
  const adhoc = signing.identity === "-";
  const main = join(app, "Contents", "MacOS", BINARY);
  const part = (p) => (p === main ? "app" : p.endsWith(`/Resources/${RESOURCE_LAYOUT.node}`) ? "node" : p.endsWith(`/Resources/${RESOURCE_LAYOUT.worker}`) ? "worker" : null);
  const args = (path, role) => {
    const ent = role ? signing.entitlements?.[role] : null;
    return ["--force", "--sign", signing.identity, adhoc ? "--timestamp=none" : "--timestamp", ...(signing.hardenedRuntime ? ["--options", "runtime"] : []), ...(ent ? ["--entitlements", resolve(DESKTOP, ent)] : []), path];
  };
  const inner = machO
    .filter((f) => f.path !== main && (!adhoc || !f.signed))
    .sort((a, b) => b.path.split("/").length - a.path.split("/").length || a.path.localeCompare(b.path));
  return [...inner.map((f) => ({ path: f.path, args: args(f.path, part(f.path)) })), { path: main, args: args(main, "app") }, { path: app, args: args(app, "app") }];
}

export function tauriArgs({ debug }) {
  return ["tauri", "build", "--ci", ...(debug ? ["--debug"] : []), "--bundles", "app", "--no-sign", "--", "--locked"];
}

export function dmgArgs({ srcFolder, out }) {
  return ["create", "-volname", PRODUCT, "-srcfolder", srcFolder, "-fs", "HFS+", "-format", "UDZO", "-ov", out];
}

// ---------- the build on a Mac ----------

const step = stepper("build:macos");
const appPath = (profile) => join(TAURI, "target", profile, "bundle", "macos", `${PRODUCT}.app`);

function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Every regular Mach-O file under `dir` (symbolic links are not followed). */
function machOFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) machOFiles(p, out);
    else if (st.isFile() && st.size >= 32) {
      const fd = openSync(p, "r");
      try {
        const reader = (o, n) => {
          const b = Buffer.alloc(Math.max(0, Math.min(n, st.size - o)));
          readSync(fd, b, 0, b.length, o);
          return b;
        };
        const slices = machoMinOs(reader);
        if (slices) out.push({ path: p, slices });
      } finally {
        closeSync(fd);
      }
    }
  }
  return out;
}

function sign(app) {
  const identity = process.env.APPLE_SIGNING_IDENTITY || SIGNING.identity;
  const signing = { ...SIGNING, identity };
  step(`clear extended attributes of ${PRODUCT}.app (they make codesign fail)`, "xattr", ["-cr", app]);
  const files = machOFiles(app).map((f) => ({ path: f.path, signed: capture("codesign", ["--verify", "--strict", f.path]).ok }));
  const calls = signingPlan({ app, machO: files, signing });
  process.stdout.write(`build:macos: signing ${identity === "-" ? "ad hoc" : `as ${identity}`}: ${files.length} Mach-O files in the app, ${files.filter((f) => f.signed).length} already signed; ${calls.length} codesign calls\n`);
  for (const c of calls) {
    const r = capture("codesign", c.args);
    if (!r.ok) {
      process.stderr.write(`build:macos: codesign failed for ${relative(app, c.path) || `${PRODUCT}.app`}:\n${r.out}\n`);
      process.exit(1);
    }
  }
  step("check the app's signature", "codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  process.stdout.write(`${capture("codesign", ["--display", "--verbose=2", app]).out}\n`);
}

function checkMinOs(app) {
  const files = machOFiles(app);
  const problems = minOsProblems(files.map((f) => ({ path: relative(app, f.path), slices: f.slices })), PINS.minimumSystemVersion);
  const stated = files.filter((f) => f.slices.every((s) => s.minos === null));
  process.stdout.write(`build:macos: ${files.length} Mach-O files; the newest minimum macOS among them: ${files.flatMap((f) => f.slices.map((s) => s.minos).filter(Boolean)).reduce((a, b) => (newer(b, a) ? b : a), "0.0")}${stated.length ? `; ${stated.length} state none` : ""}\n`);
  if (problems.length) {
    process.stderr.write(`build:macos: files that would not run on macOS ${PINS.minimumSystemVersion}:\n  ${problems.join("\n  ")}\n`);
    process.exit(1);
  }
}

function makeDmg(app, target) {
  const work = join(BUILD, `dmg-${target.label}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  step("copy the app for the disk image", "ditto", [app, join(work, `${PRODUCT}.app`)]);
  symlinkSync("/Applications", join(work, "Applications"));
  mkdirSync(OUT, { recursive: true });
  const dmg = join(OUT, target.dmgName(BASE_CONF.version));
  step(`the disk image ${relative(REPO, dmg)}`, "hdiutil", dmgArgs({ srcFolder: work, out: dmg }));
  const hash = createHash("sha256").update(readFileSync(dmg)).digest("hex");
  writeFileSync(`${dmg}.sha256`, `${hash}  ${target.dmgName(BASE_CONF.version)}\n`);
  process.stdout.write(`build:macos: ${relative(REPO, dmg)} sha256 ${hash}\n`);
}

/** The build's steps, in order; `describe` is what --dry-run prints. */
export function plan(target, { debugApp }) {
  const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: PINS.minimumSystemVersion };
  const state = {};
  const withNode = () => ({ ...env, PATH: `${dirname(state.node.node)}:${env.PATH ?? ""}` });
  const steps = [
    { id: "node", describe: `Node.js ${target.node.version}: ${target.node.url} into .build/node/, checked against sha256 ${target.node.sha256} before extracting`, run: async () => { state.node = await ensureNodeRelease({ cacheDir: join(BUILD, "node"), pin: target.node, log: (m) => process.stdout.write(`build:macos: ${m}\n`) }); } },
    { id: "service", describe: "pnpm --filter @ao/library-service run build (with that Node first on PATH)", run: () => buildServiceFolder(step, { env: withNode() }) },
    { id: "build-info", describe: `apps/library-service/dist/library-service/build-info.json names darwin, ${target.arch} and Node ${target.node.version}`, run: () => {
      const p = checkBuildInfo(read(join(SERVICE_DIR, "build-info.json")), { arch: target.arch, nodeVersion: target.node.version });
      if (p.length) throw new Error(p.join("; "));
    } },
    { id: "worker", describe: `node apps/desktop/scripts/build-sidecars.mjs ${target.workerArgs.map((a) => (a.startsWith(REPO) ? relative(REPO, a) : a)).join(" ")} -> ${relative(REPO, target.workerBundle)}`, run: () => step("the packaged media worker", process.execPath, [join(DESKTOP, "scripts", "build-sidecars.mjs"), ...target.workerArgs], { env }) },
    { id: "notices", describe: `the helpers' notices into ${relative(REPO, NOTICES)}; node apps/desktop/scripts/notices.mjs ${relative(REPO, NOTICES)} --node .build/node/${target.node.dir}/bin/node`, run: () => {
      if (!copyHelperNotices("build:macos", { workerBundle: target.workerBundle })) throw new Error("the packaged worker's manifest is missing");
      writeShellNotices(step, { nodeExe: state.node.node });
    } },
    { id: "interface", describe: "pnpm --filter @ao/ui run build", run: () => buildInterface(step, { env: withNode() }) },
    { id: "stage", describe: `stage node/node, library-service/ and ao-worker/ in ${relative(REPO, STAGE)} (tauri.macos.conf.json copies them into Contents/Resources)`, run: () => stageResources({ nodeExe: state.node.node, serviceDir: SERVICE_DIR, workerBundle: target.workerBundle, stageDir: STAGE }) },
    { id: "tauri", describe: `MACOSX_DEPLOYMENT_TARGET=${PINS.minimumSystemVersion} cargo ${tauriArgs({ debug: false }).join(" ")} (tauri-cli ${PINS.tauriCli})`, run: () => {
      const v = capture("cargo", ["tauri", "--version"]);
      if (!v.ok || !v.out.includes(PINS.tauriCli)) throw new Error(`tauri-cli ${PINS.tauriCli} is needed (cargo install tauri-cli --version =${PINS.tauriCli} --locked); found: ${v.out || "none"}`);
      step("the release app (Tauri bundler)", "cargo", tauriArgs({ debug: false }), { cwd: TAURI, env });
    } },
    ...(debugApp ? [{ id: "tauri-debug", describe: `MACOSX_DEPLOYMENT_TARGET=${PINS.minimumSystemVersion} cargo ${tauriArgs({ debug: true }).join(" ")} (for the launch check)`, run: () => step("the debug app, for the launch check", "cargo", tauriArgs({ debug: true }), { cwd: TAURI, env }) }] : []),
    { id: "sign", describe: `sign ${PRODUCT}.app per macos/signing.json (identity "${SIGNING.identity}")`, run: () => sign(appPath("release")) },
    ...(debugApp ? [{ id: "sign-debug", describe: `sign the debug ${PRODUCT}.app the same way`, run: () => sign(appPath("debug")) }] : []),
    { id: "min-os", describe: `every Mach-O file in the app runs on macOS ${PINS.minimumSystemVersion} (LC_BUILD_VERSION)`, run: () => checkMinOs(appPath("release")) },
    { id: "dmg", describe: `hdiutil ${dmgArgs({ srcFolder: `.build/dmg-${target.label}`, out: `dist-macos/${target.dmgName(BASE_CONF.version)}` }).join(" ")}; and its .sha256`, run: () => makeDmg(appPath("release"), target) },
  ];
  return steps;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const arch = opts.arch ?? process.arch;
  const target = macosTarget(arch);
  const steps = plan(target, opts);
  if (opts.dryRun) {
    process.stdout.write(`build:macos (dry run) for ${target.label} (${target.triple}):\n`);
    steps.forEach((s, i) => process.stdout.write(`  ${String(i + 1).padStart(2)}. ${s.id}: ${s.describe}\n`));
    return;
  }
  if (process.platform !== "darwin") throw new Error("this builds on a Mac only (on another system, --dry-run prints the plan)");
  for (const s of steps) {
    process.stdout.write(`build:macos: == ${s.id}\n`);
    await s.run();
  }
  process.stdout.write(`build:macos: done: ${relative(REPO, appPath("release"))}${opts.debugApp ? ` and ${relative(REPO, appPath("debug"))}` : ""}; the disk image is in ${relative(REPO, OUT)}/\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    process.stderr.write(`build:macos: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
