#!/usr/bin/env node
// Builds the desktop app on Linux (Task 37c): the interface (packages/ui/dist, embedded in the shell),
// the library service folder (apps/library-service/dist/library-service) and the Tauri shell
// (apps/desktop/src-tauri/target/<profile>/alexandrine-oxiana). Debug profile by default (what the
// launch check runs); `--release` builds the release profile too (no developer tools, no test mode).
//
//   pnpm --filter @ao/desktop run build:linux [-- --release]
//
// Needs the web view's development libraries (README: "Building on Linux") and Rust 1.97 with cargo.
// It does not package (no .deb or AppImage) and does not build the media worker (build:sidecars).
import { spawnSync } from "node:child_process";
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
step("the interface", "pnpm", ["--filter", "@ao/ui", "run", "build"]);
step("the library service folder", "pnpm", ["--filter", "@ao/library-service", "run", "build"]);
step(`the shell (${release ? "release" : "debug"})`, "cargo", ["build", "--locked", ...(release ? ["--release"] : [])], TAURI);
process.stdout.write(`build:linux: done: ${join(TAURI, "target", release ? "release" : "debug", "alexandrine-oxiana")}\n`);
