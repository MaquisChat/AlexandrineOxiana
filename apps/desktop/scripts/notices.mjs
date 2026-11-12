#!/usr/bin/env node
// The licence lists of what the desktop shell itself ships (R159 c), made at build time for the
// About screen, beside the helpers' own notices (build-linux.mjs):
//
//  - shell-crates.json: every Rust crate compiled into the shell for this platform: the normal
//    dependency closure of `ao-desktop` in `cargo metadata --locked --filter-platform <host>` (build
//    and dev dependencies are not shipped), each with its licence as its Cargo.toml states it, and
//    for MPL-2.0 crates where their source is (section 3.2).
//  - interface-npm.json: every production npm package of the interface (`pnpm list --prod`), which
//    is what the interface bundle can contain, with the licence its package.json states. The
//    workspace's own packages are left out.
//
// Either list fails the build when a shipped crate or package states no licence.
//
//   node apps/desktop/scripts/notices.mjs <out-dir>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TAURI = join(REPO, "apps", "desktop", "src-tauri");

// ---------- pure helpers (tested in notices.test.mjs) ----------

/** The crates the shell's binary is built from: normal dependencies reachable from the root, not the root. */
export function shippedCrates(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const byId = new Map(metadata.packages.map((p) => [p.id, p]));
  const root = metadata.resolve.root;
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const node = nodes.get(queue.shift());
    for (const d of node?.deps ?? []) {
      const normal = (d.dep_kinds ?? []).some((k) => k.kind === null);
      if (normal && !seen.has(d.pkg)) {
        seen.add(d.pkg);
        queue.push(d.pkg);
      }
    }
  }
  seen.delete(root);
  return [...seen].map((id) => byId.get(id)).filter(Boolean);
}

const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);

/** One entry per crate; MPL-2.0 ones say where their source is. Throws on a crate without a licence. */
export function crateNotices(crates) {
  const missing = crates.filter((c) => !c.license && !c.license_file);
  if (missing.length) throw new Error(`${missing.map((c) => `${c.name} ${c.version}`).join(", ")} has no licence entry in its Cargo.toml`);
  return crates
    .map((c) => {
      const licence = c.license || `see its ${c.license_file}`;
      const entry = { name: c.name, version: c.version, licence };
      if (/\bMPL-2\.0\b/.test(licence)) entry.source = `${c.repository ?? "(no repository stated)"} (version ${c.version}; also https://crates.io/crates/${c.name}/${c.version})`;
      return entry;
    })
    .sort(byName);
}

/** One entry per production npm package of `pnpm list --json` output; workspace packages are left out. */
export function npmNotices(list, readPackage) {
  const found = new Map();
  const walk = (deps) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      const workspace = String(d.version).startsWith("link:");
      if (!workspace) {
        const key = `${name}@${d.version}`;
        if (!found.has(key)) {
          const pkg = readPackage(d.path) ?? {};
          const licence =
            typeof pkg.license === "string" ? pkg.license : typeof pkg.license?.type === "string" ? pkg.license.type : Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l?.type).filter(Boolean).join(" OR ") : "";
          if (!licence) throw new Error(`${name} ${d.version} has no licence entry in its package.json`);
          found.set(key, { name, version: d.version, licence });
        }
      }
      walk(d.dependencies);
    }
  };
  for (const root of list) walk(root.dependencies);
  return [...found.values()].sort(byName);
}

// ---------- the build step ----------

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const m = /^host: (\S+)$/m.exec(out);
  if (!m) throw new Error("rustc did not report its host");
  return m[1];
}

export function writeNotices(outDir) {
  mkdirSync(outDir, { recursive: true });
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", hostTriple()], { cwd: TAURI, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
  const crates = crateNotices(shippedCrates(metadata));
  writeFileSync(join(outDir, "shell-crates.json"), JSON.stringify(crates, null, 1) + "\n");
  const list = JSON.parse(execFileSync("pnpm", ["--filter", "@ao/ui", "list", "--prod", "--depth", "Infinity", "--json"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const npm = npmNotices(list, (p) => JSON.parse(readFileSync(join(p, "package.json"), "utf8")));
  writeFileSync(join(outDir, "interface-npm.json"), JSON.stringify(npm, null, 1) + "\n");
  return { crates: crates.length, mpl: crates.filter((c) => c.source).length, npm: npm.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const r = writeNotices(resolve(process.argv[2] ?? join(REPO, "apps", "desktop", "generated", "notices")));
    process.stdout.write(`notices: ${r.crates} Rust crates (${r.mpl} under MPL-2.0), ${r.npm} npm packages of the interface\n`);
  } catch (err) {
    process.stderr.write(`notices: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
