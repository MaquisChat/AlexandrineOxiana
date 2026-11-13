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
// every licence and notice file shipped whole, each distinct file once (R165; scripts/notices/licence-texts.mjs):
//  - shell-crates-LICENCES.txt: each crate's own licence and notice files (LICENSE*, COPYING*,
//    NOTICE*, COPYRIGHT*, third-party lists, a root licenses/ folder) from its source in the cargo
//    registry, and its Cargo.toml license-file;
//  - interface-npm-LICENCES.txt: each production npm package's own licence and notice files, and
//    the components its own SBOM lists, and the licence files of the data the interface copies out
//    of a package (pdf.js's asset folders: packages/ui/scripts/pdfjs-assets.mjs);
//  - node-LICENCES.txt: the LICENSE of the Node.js release shipped beside the service (ADR 0013),
//    which also carries the licences of what Node bundles (V8, OpenSSL, ICU, libuv, ...). It is the
//    release of the Node that runs this script, unless --node <program> names another: the service
//    folder must run with the Node that built it.
// A package that ships no text gets the standard text of its identifier (licences/standard) and is
// named in its file's "no licence text shipped by the package" section; one with neither fails the build.
// Each file is checked to contain every source file whole before it is written, and the list of
// source files is written to <out-dir>/../licence-sources/<part>.json for scripts/notices/check-verbatim.mjs.
//
//   node apps/desktop/scripts/notices.mjs <out-dir> [--node <node program>]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pdfjsLicenceFiles } from "../../../packages/ui/scripts/pdfjs-assets.mjs";
import { collectLicenceTexts, licenceFilesIn, licenceIds, loadStandardTexts, readLicenceFiles, renderLicenceTexts, sbomIn, seeLicenceIn, sourceList, verifyVerbatim } from "../../../scripts/notices/licence-texts.mjs";

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

/** Renders, checks that every source file is in the result whole (R165), and returns { text, sources }. */
function finish(part, packages, dirOf, standard, render) {
  const result = collectLicenceTexts(packages, standard);
  if (result.problems.length) fail(part, result.problems);
  const text = renderLicenceTexts({ packages, result, ...render });
  const sources = sourceList(packages, dirOf, result);
  const missing = verifyVerbatim(
    text,
    sources.map((s) => ({ label: s.label, text: s.standard ? standard.get(s.standard) : readFileSync(s.path, "utf8") })),
  );
  if (missing.length) fail(part, missing.map((m) => `${m} is not in the notices file whole`));
  return { text, sources };
}

/** The licence texts of the shell's crates (from each crate's own source folder), as one file. Throws on a problem. */
export function crateLicenceTexts(crates, standard = loadStandardTexts()) {
  const dirs = new Map();
  const packages = [...crates].sort(byName).map((c) => {
    const dir = dirname(c.manifest_path);
    const names = licenceFilesIn(dir);
    if (c.license_file && !names.includes(c.license_file)) names.push(c.license_file);
    const entry = {
      name: c.name,
      version: c.version,
      licence: c.license ?? "",
      ...(c.license_file ? { licenceFile: c.license_file } : {}),
      files: readLicenceFiles(dir, names),
      ...(licenceIds(c.license).includes("MPL-2.0") ? { source: crateSource(c) } : {}),
    };
    dirs.set(entry, dir);
    return entry;
  });
  return finish("the shell's Rust crates", packages, (p) => dirs.get(p), standard, {
    title: "The app's Rust crates: licence texts",
    intro: "The Rust crates compiled into the app's program, and the licence and notice files each crate ships in its source, each shown whole. Crates under the Mozilla Public License 2.0 name where their source is.",
  });
}

/** The licence texts of the interface's npm packages (from each package's folder), as one file. Throws on a problem. */
export function npmLicenceTexts(list, readPackage, standard = loadStandardTexts()) {
  const dirs = new Map();
  const packages = npmPackages(list, readPackage).map(({ name, version, licence, path, pkg }) => {
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    const see = seeLicenceIn(licence);
    const names = licenceFilesIn(path);
    if (see && existsSync(join(path, see)) && !names.includes(see)) names.push(see);
    // The licences of data files the interface copies out of a package beside its own code (pdf.js's
    // character maps, standard fonts, decoder fallbacks and colour profile: Task R6, R192), which lie
    // in the package's sub-folders, not at its top.
    for (const extra of bundledLicenceFiles(name, path)) if (!names.includes(extra)) names.push(extra);
    const components = sbomIn(path);
    const entry = {
      name,
      version,
      licence,
      ...(see ? { licenceFile: see } : {}),
      files: readLicenceFiles(path, names),
      ...(components ? { components } : {}),
      ...(licenceIds(licence).includes("MPL-2.0") ? { source: npmSource(name, version, repo) } : {}),
    };
    dirs.set(entry, path);
    return entry;
  });
  return finish("the interface's npm packages", packages, (p) => dirs.get(p), standard, {
    title: "The interface's npm packages: licence texts",
    intro: "The production npm packages the app's interface is built from, and the licence and notice files each package ships, each shown whole.",
  });
}

/** Licence files inside a package's sub-folders that the interface ships with files copied from those folders. */
const bundledLicenceFiles = (name, path) => (name === "pdfjs-dist" ? pdfjsLicenceFiles(path) : []);

/** Where an MPL-2.0 npm package's source is: its repository and its npm page. */
export const npmSource = (name, version, repo) => `${repo ?? "(no repository stated)"} (version ${version}; also https://www.npmjs.com/package/${name}/v/${version})`;

/** The LICENSE file of the Node.js release `exe` belongs to, or undefined. */
export function nodeLicenceFile(exe) {
  const candidates = [join(dirname(exe), "LICENSE"), join(dirname(dirname(exe)), "LICENSE")];
  return candidates.find((f) => existsSync(f) && /^Node\.js is licensed/.test(readFileSync(f, "utf8")));
}

/**
 * The LICENSE file of the Node.js release `exe` belongs to, unchanged, after a heading. The official
 * archives have it at the top: <release>/LICENSE beside <release>/bin/node (macOS, Linux) or beside
 * node.exe (Windows). It covers Node.js and the libraries it bundles. Throws if it is not there.
 */
export function nodeLicenceText(exe, version) {
  const file = nodeLicenceFile(exe);
  if (!file) throw new Error(`there is no LICENSE file of Node.js beside ${exe} (looked in ${dirname(exe)} and ${dirname(dirname(exe))}); ship the release folder's LICENSE with the program`);
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

export function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const m = /^host: (\S+)$/m.exec(out);
  if (!m) throw new Error("rustc did not report its host");
  return m[1];
}

/** The crates compiled into the shell for a target triple (cargo metadata, filtered to that platform). */
export function shippedCratesFor(target) {
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", target], { cwd: TAURI, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
  return shippedCrates(metadata);
}

export function writeNotices(outDir, nodeExe = process.execPath) {
  mkdirSync(outDir, { recursive: true });
  const standard = loadStandardTexts();
  const shipped = shippedCratesFor(hostTriple());
  const crates = crateNotices(shipped);
  writeFileSync(join(outDir, "shell-crates.json"), JSON.stringify(crates, null, 1) + "\n");
  // The source files each notices file was made from: for scripts/notices/check-verbatim.mjs, beside
  // the notices folder (not in it: the interface embeds that folder's files).
  const sourcesDir = join(dirname(outDir), "licence-sources");
  mkdirSync(sourcesDir, { recursive: true });
  const write = (part, { text, sources }) => {
    writeFileSync(join(outDir, `${part}-LICENCES.txt`), text);
    writeFileSync(join(sourcesDir, `${part}.json`), JSON.stringify(sources, null, 1) + "\n");
    return text;
  };
  const cratesText = write("shell-crates", crateLicenceTexts(shipped, standard));
  const list = JSON.parse(execFileSync("pnpm", ["--filter", "@ao/ui", "list", "--prod", "--depth", "Infinity", "--json"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const readPackage = (p) => JSON.parse(readFileSync(join(p, "package.json"), "utf8"));
  const npm = npmNotices(list, readPackage);
  writeFileSync(join(outDir, "interface-npm.json"), JSON.stringify(npm, null, 1) + "\n");
  const npmText = write("interface-npm", npmLicenceTexts(list, readPackage, standard));
  const nodeVersion = execFileSync(nodeExe, ["--version"], { encoding: "utf8" }).trim();
  write("node", { text: nodeLicenceText(nodeExe, nodeVersion), sources: [{ label: `Node.js ${nodeVersion} LICENSE`, path: nodeLicenceFile(nodeExe) }] });
  const distinct = (t) => Number(/\((\d+) distinct\)/.exec(t)?.[1] ?? 0);
  return { crates: crates.length, mpl: crates.filter((c) => c.source).length, npm: npm.length, node: nodeVersion, cratesDistinct: distinct(cratesText), npmDistinct: distinct(npmText) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const argv = process.argv.slice(2);
    const at = argv.indexOf("--node");
    const nodeExe = at >= 0 ? argv.splice(at, 2)[1] : process.execPath;
    if (!nodeExe) throw new Error("--node needs the Node.js program the app ships");
    const r = writeNotices(resolve(argv[0] ?? join(REPO, "apps", "desktop", "generated", "notices")), resolve(nodeExe));
    process.stdout.write(`notices: ${r.crates} Rust crates (${r.mpl} under MPL-2.0), ${r.npm} npm packages of the interface, Node.js ${r.node}; licence texts: ${r.cratesDistinct} distinct files for the crates, ${r.npmDistinct} for the interface\n`);
  } catch (err) {
    process.stderr.write(`notices: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
