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
// And the licence texts that must travel with them (Task 37j, ADR 0015), one readable file per part,
// each text once with every copyright line of its copies (licence-texts.mjs):
//  - shell-crates-LICENCES.txt: each crate's own LICENSE*/COPYING*/NOTICE*/COPYRIGHT* files from its
//    source in the cargo registry (and its Cargo.toml license-file);
//  - interface-npm-LICENCES.txt: each production npm package's own licence files;
//  - node-LICENCES.txt: the LICENSE of the Node.js release shipped beside the service (ADR 0013),
//    which also carries the licences of what Node bundles (V8, OpenSSL, ICU, libuv, ...). It is the
//    release of the Node that runs this script, unless --node <program> names another: the service
//    folder must run with the Node that built it.
// A package that ships no text gets the standard text of its identifier (licences/standard) and is
// named in its file's "no licence text shipped by the package" section; one with neither fails the build.
//
//   node apps/desktop/scripts/notices.mjs <out-dir> [--node <node program>]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectLicenceTexts, licenceFilesIn, licenceIds, loadStandardTexts, readLicenceFiles, renderLicenceTexts } from "./licence-texts.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TAURI = join(REPO, "apps", "desktop", "src-tauri");

// ---------- pure helpers (tested in notices.test.mjs) ----------

const isProcMacro = (p) => (p?.targets ?? []).some((t) => (t.kind ?? []).includes("proc-macro"));

/**
 * The crates the shell's binary is built from: normal dependencies reachable from the root, not the
 * root. A proc-macro crate runs inside the compiler and is not linked into the program, so it is
 * left out, and so is what is reached only through one (N3).
 */
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
      if (normal && !seen.has(d.pkg) && !isProcMacro(byId.get(d.pkg))) {
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
      if (/\bMPL-2\.0\b/.test(licence)) entry.source = crateSource(c);
      return entry;
    })
    .sort(byName);
}

const crateSource = (c) => `${c.repository ?? "(no repository stated)"} (version ${c.version}; also https://crates.io/crates/${c.name}/${c.version})`;

/** One entry per production npm package of `pnpm list --json` output; workspace packages are left out. */
export function npmNotices(list, readPackage) {
  return npmPackages(list, readPackage).map(({ name, version, licence }) => ({ name, version, licence }));
}

const fail = (part, problems) => {
  throw new Error(`licence texts of ${part}:\n  ${problems.join("\n  ")}`);
};

/** The licence texts of the shell's crates (from each crate's own source folder), as one file. Throws on a problem. */
export function crateLicenceTexts(crates, standard = loadStandardTexts()) {
  const packages = [...crates].sort(byName).map((c) => {
    const dir = dirname(c.manifest_path);
    const names = licenceFilesIn(dir);
    if (c.license_file && !names.includes(c.license_file)) names.push(c.license_file);
    return {
      name: c.name,
      version: c.version,
      licence: c.license ?? "",
      ...(c.license_file ? { licenceFile: c.license_file } : {}),
      files: readLicenceFiles(dir, names),
      ...(licenceIds(c.license).includes("MPL-2.0") ? { source: crateSource(c) } : {}),
    };
  });
  const result = collectLicenceTexts(packages, standard);
  if (result.problems.length) fail("the shell's Rust crates", result.problems);
  return renderLicenceTexts({
    title: "The app's Rust crates: licence texts",
    intro: "The Rust crates compiled into the app's program, and the licence and notice files each crate ships in its source. Crates under the Mozilla Public License 2.0 name where their source is.",
    packages,
    result,
  });
}

/** The licence texts of the interface's npm packages (from each package's folder), as one file. Throws on a problem. */
export function npmLicenceTexts(list, readPackage, standard = loadStandardTexts()) {
  const packages = npmPackages(list, readPackage).map(({ name, version, licence, path, pkg }) => {
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    return {
      name,
      version,
      licence,
      files: readLicenceFiles(path),
      ...(licenceIds(licence).includes("MPL-2.0") ? { source: `${repo ?? "(no repository stated)"} (version ${version}; also https://www.npmjs.com/package/${name}/v/${version})` } : {}),
    };
  });
  const result = collectLicenceTexts(packages, standard);
  if (result.problems.length) fail("the interface's npm packages", result.problems);
  return renderLicenceTexts({
    title: "The interface's npm packages: licence texts",
    intro: "The production npm packages the app's interface is built from, and the licence and notice files each package ships.",
    packages,
    result,
  });
}

/**
 * The LICENSE file of the Node.js release `exe` belongs to, unchanged, after a heading. The official
 * archives have it at the top: <release>/LICENSE beside <release>/bin/node (macOS, Linux) or beside
 * node.exe (Windows). It covers Node.js and the libraries it bundles. Throws if it is not there.
 */
export function nodeLicenceText(exe, version) {
  const candidates = [join(dirname(exe), "LICENSE"), join(dirname(dirname(exe)), "LICENSE")];
  const file = candidates.find((f) => existsSync(f) && /^Node\.js is licensed/.test(readFileSync(f, "utf8")));
  if (!file) throw new Error(`there is no LICENSE file of Node.js beside ${exe} (looked for ${candidates.join(" and ")}); ship the release folder's LICENSE with the program`);
  return `Node.js ${version}\n\nThe app runs its library service with this Node.js release, shipped beside it. What follows is the\nrelease's own LICENSE file, unchanged: the licence of Node.js and of the libraries it bundles\n(V8, OpenSSL, ICU, libuv and others).\n\n${readFileSync(file, "utf8")}`;
}

/** The production npm packages of `pnpm list --json` output, once each: { name, version, licence, path, pkg }. */
function npmPackages(list, readPackage) {
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
          found.set(key, { name, version: d.version, licence, path: d.path, pkg });
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

export function writeNotices(outDir, nodeExe = process.execPath) {
  mkdirSync(outDir, { recursive: true });
  const standard = loadStandardTexts();
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", hostTriple()], { cwd: TAURI, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
  const shipped = shippedCrates(metadata);
  const crates = crateNotices(shipped);
  writeFileSync(join(outDir, "shell-crates.json"), JSON.stringify(crates, null, 1) + "\n");
  writeFileSync(join(outDir, "shell-crates-LICENCES.txt"), crateLicenceTexts(shipped, standard));
  const list = JSON.parse(execFileSync("pnpm", ["--filter", "@ao/ui", "list", "--prod", "--depth", "Infinity", "--json"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const readPackage = (p) => JSON.parse(readFileSync(join(p, "package.json"), "utf8"));
  const npm = npmNotices(list, readPackage);
  writeFileSync(join(outDir, "interface-npm.json"), JSON.stringify(npm, null, 1) + "\n");
  writeFileSync(join(outDir, "interface-npm-LICENCES.txt"), npmLicenceTexts(list, readPackage, standard));
  const nodeVersion = execFileSync(nodeExe, ["--version"], { encoding: "utf8" }).trim();
  writeFileSync(join(outDir, "node-LICENCES.txt"), nodeLicenceText(nodeExe, nodeVersion));
  return { crates: crates.length, mpl: crates.filter((c) => c.source).length, npm: npm.length, node: nodeVersion };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const argv = process.argv.slice(2);
    const at = argv.indexOf("--node");
    const nodeExe = at >= 0 ? argv.splice(at, 2)[1] : process.execPath;
    if (!nodeExe) throw new Error("--node needs the Node.js program the app ships");
    const r = writeNotices(resolve(argv[0] ?? join(REPO, "apps", "desktop", "generated", "notices")), resolve(nodeExe));
    process.stdout.write(`notices: ${r.crates} Rust crates (${r.mpl} under MPL-2.0), ${r.npm} npm packages of the interface, Node.js ${r.node}; with their licence texts\n`);
  } catch (err) {
    process.stderr.write(`notices: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
