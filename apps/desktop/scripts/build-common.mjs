// What the Linux and the Mac builds of the desktop app share (build-linux.mjs, build-macos.mjs):
// running a step, building the library service folder and the interface, and gathering the notices
// the About screen shows from the helpers' own builds and from notices.mjs.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DESKTOP = join(REPO, "apps", "desktop");
export const TAURI = join(DESKTOP, "src-tauri");
export const SERVICE_DIR = join(REPO, "apps", "library-service", "dist", "library-service");
export const SIDECARS = join(DESKTOP, "sidecars");
export const NOTICES = join(DESKTOP, "generated", "notices");

/** A step runner that prints `<prefix>: <what>` and stops the build (with the step's exit status) when a step fails. */
export function stepper(prefix) {
  return function step(what, cmd, args, { cwd = REPO, env } = {}) {
    process.stdout.write(`${prefix}: ${what}\n`);
    const r = spawnSync(cmd, args, { cwd, stdio: "inherit", ...(env ? { env } : {}) });
    if (r.status !== 0) {
      process.stderr.write(`${prefix}: ${what} failed${r.error ? ` (${r.error.message})` : ""}\n`);
      process.exit(r.status ?? 1);
    }
  };
}

export const buildServiceFolder = (step, opts) => step("the library service folder", "pnpm", ["--filter", "@ao/library-service", "run", "build"], opts);
export const buildInterface = (step, opts) => step("the interface", "pnpm", ["--filter", "@ao/ui", "run", "build"], opts);

/** The packaged worker's manifest: in `bundleDir` when given, else the first one in sidecars/ (Linux). */
export function findWorkerManifest(bundleDir) {
  if (bundleDir) {
    const f = join(bundleDir, "sidecar-manifest.json");
    return existsSync(f) ? f : undefined;
  }
  return existsSync(SIDECARS) ? readdirSync(SIDECARS).map((d) => join(SIDECARS, d, "sidecar-manifest.json")).find((f) => existsSync(f)) : undefined;
}

/**
 * The notices for the About screen, as the helpers' builds made them, copied into a fresh `NOTICES`
 * folder: the service build's notices and licence texts, and the packaged worker's manifest and
 * licence texts when there is one. Returns whether a worker's were included; exits when a packaged
 * worker has no licence texts.
 */
export function copyHelperNotices(prefix, { workerBundle } = {}) {
  rmSync(NOTICES, { recursive: true, force: true });
  mkdirSync(NOTICES, { recursive: true });
  const serviceLicences = join(SERVICE_DIR, "licences");
  copyFileSync(join(serviceLicences, "THIRD-PARTY-NOTICES.md"), join(NOTICES, "library-service-THIRD-PARTY-NOTICES.md"));
  // The licence texts themselves (Task 37j): the interface loads each only when asked (About screen).
  copyFileSync(join(serviceLicences, "THIRD-PARTY-LICENCES.txt"), join(NOTICES, "library-service-LICENCES.txt"));
  const worker = findWorkerManifest(workerBundle);
  if (worker) {
    copyFileSync(worker, join(NOTICES, "worker-sidecar-manifest.json"));
    const texts = join(dirname(worker), "licenses", "THIRD-PARTY-LICENCES.txt");
    if (!existsSync(texts)) {
      process.stderr.write(`${prefix}: the packaged worker has no licenses/THIRD-PARTY-LICENCES.txt; rebuild it (build:sidecars)\n`);
      process.exit(1);
    }
    copyFileSync(texts, join(NOTICES, "worker-LICENCES.txt"));
  }
  process.stdout.write(`${prefix}: notices: the service's npm packages${worker ? " and the packaged worker's manifest" : " (no packaged worker yet: its manifest is not included)"}\n`);
  return Boolean(worker);
}

/** The shell's own Rust crates, the interface's npm packages and Node.js (R159 c, ADR 0015); fails on one without a licence. */
export function writeShellNotices(step, { nodeExe } = {}) {
  step("the licence lists of the shell's crates and the interface's packages", process.execPath, [join(DESKTOP, "scripts", "notices.mjs"), NOTICES, ...(nodeExe ? ["--node", nodeExe] : [])]);
}
