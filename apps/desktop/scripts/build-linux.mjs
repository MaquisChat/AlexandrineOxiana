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
// The steps it shares with the Mac build (build-macos.mjs) are in build-common.mjs.
import { join } from "node:path";
import { buildInterface, buildServiceFolder, copyHelperNotices, stepper, TAURI, writeShellNotices } from "./build-common.mjs";

const release = process.argv.includes("--release");
const step = stepper("build:linux");

if (process.platform !== "linux") {
  process.stderr.write("build:linux builds on Linux; on a Mac use build:macos.\n");
  process.exit(1);
}
buildServiceFolder(step);

// The notices for the About screen, as the helpers' builds made them.
copyHelperNotices("build:linux");

// The shell's own Rust crates and the interface's npm packages (R159 c); fails on one without a licence.
writeShellNotices(step);

buildInterface(step);
step(`the shell (${release ? "release" : "debug"})`, "cargo", ["build", "--locked", ...(release ? ["--release"] : [])], { cwd: TAURI });
process.stdout.write(`build:linux: done: ${join(TAURI, "target", release ? "release" : "debug", "alexandrine-oxiana")}\n`);
