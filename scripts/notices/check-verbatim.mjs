#!/usr/bin/env node
// Checks written notices files against the source files their generator says it used (R165): every
// source file must appear whole in its notices file, after normalising line endings and trailing
// whitespace only. Each generator writes the list beside its output (not into what ships):
//   apps/desktop/generated/licence-sources/<part>.json          (shell: crates, interface, Node.js)
//   apps/library-service/dist/library-service.licence-sources.json
//   apps/desktop/sidecars/ao-worker-<triple>.licence-sources.json
//
//   node scripts/notices/check-verbatim.mjs <notices.txt> <sources.json> [<notices.txt> <sources.json> ...]
import { pathToFileURL } from "node:url";
import { checkVerbatimFiles } from "./licence-texts.mjs";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (!args.length || args.length % 2) {
    process.stderr.write("usage: check-verbatim.mjs <notices.txt> <sources.json> [...]\n");
    process.exit(2);
  }
  let bad = 0;
  for (let i = 0; i < args.length; i += 2) {
    const { checked, missing } = checkVerbatimFiles(args[i], args[i + 1]);
    if (missing.length) {
      bad++;
      process.stderr.write(`check-verbatim: ${args[i]}: ${missing.length} of ${checked} source files are not in it whole:\n  ${missing.join("\n  ")}\n`);
    } else process.stdout.write(`check-verbatim: ${args[i]}: all ${checked} source files are in it whole\n`);
  }
  process.exit(bad ? 1 : 0);
}
