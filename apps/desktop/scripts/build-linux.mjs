#!/usr/bin/env node
// Builds the desktop app on Linux (Task 37c), in this order: the library service folder
// (apps/library-service/dist/library-service); the notices the About screen shows from the helpers'
// own builds, copied to apps/desktop/generated/notices/ (the service build's THIRD-PARTY-NOTICES.md
// and THIRD-PARTY-LICENCES.txt, and the packaged worker's sidecar-manifest.json and licence texts when
// build:sidecars has made one) and the licence lists and texts of the shell's own Rust crates, the
// interface's npm packages and Node.js (notices.mjs; Task 37j); the interface
// (packages/ui/dist, which reads those notices and is embedded in the shell); and the Tauri shell
// (apps/desktop/src-tauri/target/<profile>/alexandrine-oxiana). Debug profile by default (what the
// launch check runs); `--release` builds the release profile instead (no developer tools, no test mode).
//
//   pnpm --filter @ao/desktop run build:linux [-- --release]
//
// Needs the web view's development libraries (README: "Building on Linux") and Rust 1.97 with cargo.
// It does not package (no .deb or AppImage) and does not build the media worker (build:sidecars).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TAURI = join(REPO, "apps", "desktop", "src-tauri");
const release = process.argv.includes("--release");

function step(what, cmd, args, cwd = REPO) {
  process.stdout.write(`build:linux: ${what}\n`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    process.stderr.write(`build:linux: ${what} failed\n`);
    process.exit(r.status ?? 1);
  }
}

if (process.platform !== "linux") {
  process.stderr.write("build:linux builds on Linux; the Mac build is Task 37f.\n");
  process.exit(1);
}
step("the library service folder", "pnpm", ["--filter", "@ao/library-service", "run", "build"]);

// The notices for the About screen, as the helpers' builds made them.
const NOTICES = join(REPO, "apps", "desktop", "generated", "notices");
rmSync(NOTICES, { recursive: true, force: true });
mkdirSync(NOTICES, { recursive: true });
const serviceLicences = join(REPO, "apps", "library-service", "dist", "library-service", "licences");
copyFileSync(join(serviceLicences, "THIRD-PARTY-NOTICES.md"), join(NOTICES, "library-service-THIRD-PARTY-NOTICES.md"));
// The licence texts themselves (Task 37j): the interface loads each only when asked (About screen).
copyFileSync(join(serviceLicences, "THIRD-PARTY-LICENCES.txt"), join(NOTICES, "library-service-LICENCES.txt"));
const sidecars = join(REPO, "apps", "desktop", "sidecars");
const worker = existsSync(sidecars) ? readdirSync(sidecars).map((d) => join(sidecars, d, "sidecar-manifest.json")).find((f) => existsSync(f)) : undefined;
if (worker) {
  copyFileSync(worker, join(NOTICES, "worker-sidecar-manifest.json"));
  const texts = join(dirname(worker), "licenses", "THIRD-PARTY-LICENCES.txt");
  if (!existsSync(texts)) {
    process.stderr.write("build:linux: the packaged worker has no licenses/THIRD-PARTY-LICENCES.txt; rebuild it (build:sidecars)\n");
    process.exit(1);
  }
  copyFileSync(texts, join(NOTICES, "worker-LICENCES.txt"));
}
process.stdout.write(`build:linux: notices: the service's npm packages${worker ? " and the packaged worker's manifest" : " (no packaged worker yet: its manifest is not included)"}\n`);

// The shell's own Rust crates and the interface's npm packages (R159 c); fails on one without a licence.
step("the licence lists of the shell's crates and the interface's packages", process.execPath, [join(REPO, "apps", "desktop", "scripts", "notices.mjs"), NOTICES]);

step("the interface", "pnpm", ["--filter", "@ao/ui", "run", "build"]);
step(`the shell (${release ? "release" : "debug"})`, "cargo", ["build", "--locked", ...(release ? ["--release"] : [])], TAURI);
process.stdout.write(`build:linux: done: ${join(TAURI, "target", release ? "release" : "debug", "alexandrine-oxiana")}\n`);
