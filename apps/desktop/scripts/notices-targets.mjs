#!/usr/bin/env node
// The licence lists and texts of the shell's Rust crates for other targets than this machine's
// (Task 37f, R167): the Mac builds link crates a Linux build never does (the objc2 family,
// core-foundation, block2, ...), and notices.mjs fails closed on a crate without a licence or text.
// This runs the same collection (crateNotices and crateLicenceTexts) for each target, on any system,
// so a Mac build cannot be the first to find such a crate.
//
//   node apps/desktop/scripts/notices-targets.mjs [--fetch] [<triple> ...]
//
// Default targets: aarch64-apple-darwin and x86_64-apple-darwin. `--fetch` first runs
// `cargo fetch --locked --target <triple>` for each (needs crates.io once; the crates then stay in
// the cargo registry). Exits non-zero, naming the crates, when a target's collection fails.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadStandardTexts } from "../../../scripts/notices/licence-texts.mjs";
import { crateLicenceTexts, crateNotices, shippedCratesFor } from "./notices.mjs";
import { TAURI } from "./build-common.mjs";

export const MAC_TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin"];

/** Collects the crate lists and texts for one target; returns a summary or throws. */
export function checkTarget(target, standard = loadStandardTexts()) {
  const crates = shippedCratesFor(target);
  const list = crateNotices(crates);
  const { text } = crateLicenceTexts(crates, standard);
  const standardTexts = Number(/No licence text shipped by the package \((\d+)\)/.exec(text)?.[1] ?? 0);
  return { target, crates: list.length, mpl: list.filter((c) => c.source).length, distinct: Number(/\((\d+) distinct\)/.exec(text)?.[1] ?? 0), standardTexts };
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const fetch = args.includes("--fetch");
  const targets = args.filter((a) => !a.startsWith("--"));
  const standard = loadStandardTexts();
  let failed = 0;
  for (const target of targets.length ? targets : MAC_TARGETS) {
    try {
      if (fetch) execFileSync("cargo", ["fetch", "--locked", "--target", target], { cwd: TAURI, stdio: "inherit" });
      const r = checkTarget(target, standard);
      process.stdout.write(`notices-targets: ok   ${target}: ${r.crates} crates (${r.mpl} under MPL-2.0), ${r.distinct} distinct licence files, ${r.standardTexts} without a text of their own (given the standard text, listed)\n`);
    } catch (e) {
      failed++;
      process.stdout.write(`notices-targets: FAIL ${target}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(join(process.argv[1])).href) main();
