#!/usr/bin/env node
// Builds the library service as a self-contained folder (Task 37a, ADR 0013): everything it needs
// to run with a plain `node` (Node 22, the same major version that built it: the native modules are
// built for that Node's ABI), on this machine's platform and architecture, outside the repository.
//
//   node apps/library-service/scripts/build.mjs [--out <folder>]
//   (default: apps/library-service/dist/library-service)
//
// Start the folder with (see START.txt in it, and ADR 0013):
//   node --max-old-space-size=512 service.mjs
//
// The folder:
//   service.mjs                    the entry point (scripts/launcher.mjs): refuses a redirecting
//                                  environment or a mismatched Node/platform, then loads main.mjs
//   main.mjs                       the service, bundled by esbuild (our code and every pure-JS dependency)
//   workers/                       worker-thread scripts: the citation style sandbox, the web page cleaner
//   migrations/                    the index's SQL migrations
//   csl/                           the citation styles and locales, with their CC BY-SA 3.0 licence and
//                                  NOTICE (R86), and the CPAL-1.0 text for citeproc-js (R124, R129)
//   node_modules/                  the packages kept outside the bundle (NATIVE and KEPT below) and what
//                                  they need, copied unmodified, for this platform and architecture only
//   licences/                      THIRD-PARTY-NOTICES.md (every bundled or copied npm package, its
//                                  version and licence), each package's licence files, the typefaces'
//                                  OFL texts (R100), the citeproc-js notice and the CPAL text
//   package.json, build-info.json  the folder's identity; the platform, architecture and Node ABI it was built for
//   START.txt                      the documented way to start it
//
// Every non-code file the service reads is found through packages/library/src/resources.ts, which
// the bundle sees as the "bundle" layout (the `__AO_BUNDLE__` define): inside this folder only.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = resolve(HERE, "..");
const REPO = resolve(SERVICE, "../..");
const LIBRARY = join(REPO, "packages", "library");
const CORE = join(REPO, "packages", "core");
const FONTS = join(REPO, "packages", "ui", "public", "fonts");
const CSL = join(CORE, "csl");

// Must match BUNDLE_LAYOUT in packages/library/src/resources.ts.
const LAYOUT = {
  sandboxWorker: "workers/citation-sandbox-worker.mjs",
  htmlStripWorker: "workers/html-strip-worker.mjs",
  migrations: "migrations",
  csl: "csl",
};

/**
 * Packages with native code, kept outside the bundle and copied with their runtime dependencies.
 * How each is found at run time is Node's own resolution from service.mjs, in <folder>/node_modules:
 *   better-sqlite3    `bindings` loads node_modules/better-sqlite3/build/Release/better_sqlite3.node
 *   @napi-rs/keyring  its index.js requires @napi-rs/keyring-<platform>-<arch>[-<libc>] (an optional
 *                     dependency; only the one for this machine is copied)
 *   @napi-rs/canvas   optional dependency of pdfjs-dist (its DOMMatrix/Path2D for Node), the same way
 */
const NATIVE = ["better-sqlite3", "@napi-rs/keyring"];
/**
 * Pure-JS packages also kept outside the bundle, copied unmodified:
 *   pdfjs-dist         loads its own worker module (pdf.worker.mjs) by a path next to pdf.mjs, and its
 *                      optional @napi-rs/canvas
 *   exiftool-vendored  finds the bundled ExifTool (exiftool-vendored.pl here; .exe on Windows) by
 *                      package resolution and runs it with Perl
 *   citeproc           CPAL-1.0 (R124): shipped as the unmodified package, with its LICENSE; the
 *                      citation sandbox worker loads it with require("citeproc") from the folder
 *   file-type          imports strtok3 at run time through a computed specifier (a bundler cannot see it)
 * The build fails if a bundle still contains an import() or require() of a computed specifier.
 */
const KEPT = ["pdfjs-dist", "exiftool-vendored", "citeproc", "file-type"];
const EXTERNAL = [...NATIVE, ...KEPT];
/** Where each kept package is a dependency (its version is that workspace package's). */
const KEPT_FROM = { "better-sqlite3": LIBRARY, "@napi-rs/keyring": LIBRARY, "pdfjs-dist": LIBRARY, "exiftool-vendored": LIBRARY, "file-type": LIBRARY, citeproc: CORE };
/** Dependencies only needed to install a package, never at run time. */
const INSTALL_ONLY = { "better-sqlite3": ["prebuild-install"] };
/** What of a package to copy (default: everything but source maps and tests). */
const KEEP_ONLY = {
  "better-sqlite3": ["package.json", "LICENSE", "lib", "build/Release/better_sqlite3.node"],
  "pdfjs-dist": ["package.json", "LICENSE", "legacy/build"],
};

function args() {
  const a = process.argv.slice(2);
  const i = a.indexOf("--out");
  return { out: resolve(i >= 0 && a[i + 1] ? a[i + 1] : join(SERVICE, "dist", "library-service")) };
}

function fail(msg) {
  process.stderr.write(`build: ${msg}\n`);
  process.exit(1);
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** The C library on Linux ("glibc" or "musl"), else undefined. */
function libc() {
  if (process.platform !== "linux") return undefined;
  const header = process.report?.getReport?.().header;
  return header?.glibcVersionRuntime ? "glibc" : "musl";
}

/** Whether a package (by its package.json os/cpu/libc) runs on this machine. */
function forThisMachine(pkg) {
  const ok = (list, v) => !Array.isArray(list) || list.length === 0 || (list.some((x) => !x.startsWith("!")) ? list.includes(v) : !list.includes(`!${v}`));
  if (!ok(pkg.os, process.platform) || !ok(pkg.cpu, process.arch)) return false;
  const lc = libc();
  return !lc || ok(pkg.libc, lc);
}

/** The real folder of package `name` as Node would find it from `fromDir`, or undefined. */
function packageDir(name, fromDir) {
  const paths = createRequire(join(fromDir, "package.json")).resolve.paths(name) ?? [];
  for (const p of paths) {
    const dir = join(p, name);
    if (existsSync(join(dir, "package.json"))) return realpathSync(dir);
  }
  return undefined;
}

/** The nearest folder above `file` whose package.json has a name and version (a package root). */
function packageRootOf(file) {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      const pkg = readJson(pj);
      if (pkg.name && pkg.version) return realpathSync(dir);
    }
  }
  return undefined;
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice|authors)(\b|[-_.])/i;

/** Every npm package that ends up in the folder: name@version → { dir, pkg, how }. */
const packages = new Map();
function record(dir, how) {
  const pkg = readJson(join(dir, "package.json"));
  if (pkg.name?.startsWith("@ao/")) return;
  const key = `${pkg.name}@${pkg.version}`;
  if (!packages.has(key)) packages.set(key, { dir, pkg, how });
}

function copyPackage(name, fromDir, out, copied) {
  const dir = packageDir(name, fromDir);
  if (!dir) return false;
  const pkg = readJson(join(dir, "package.json"));
  if (!forThisMachine(pkg)) return false;
  const prior = copied.get(name);
  if (prior) {
    if (prior !== pkg.version) fail(`${name} is needed in two versions (${prior} and ${pkg.version}); the flat node_modules cannot hold both.`);
    return true;
  }
  copied.set(name, pkg.version);
  const dest = join(out, "node_modules", name);
  const keep = KEEP_ONLY[name];
  const wanted = (src) => {
    const rel = relative(dir, src).split(sep).join("/");
    if (rel === "") return true;
    const parts = rel.split("/");
    if (parts.includes("node_modules")) return false;
    const base = parts[parts.length - 1];
    if (parts.length === 1 && LICENCE_FILE.test(base)) return true;
    // Source maps, type declarations and TypeScript sources, and documentation: not needed to run.
    if (/\.(map|ts|mts|cts|md|markdown)$/i.test(base)) return false;
    // Test folders are never loaded at run time.
    if (parts.some((p) => /^(test|tests|__tests__)$/.test(p))) return false;
    if (!keep) return true;
    return keep.some((k) => rel === k || rel.startsWith(`${k}/`) || k.startsWith(`${rel}/`));
  };
  cpSync(dir, dest, { recursive: true, dereference: true, filter: wanted });
  record(dir, "copied");
  const skip = new Set(INSTALL_ONLY[name] ?? []);
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (skip.has(dep) || dep.startsWith("@types/")) continue; // type declarations never run
    if (!copyPackage(dep, dir, out, copied)) fail(`${name} needs ${dep}, which is not installed.`);
  }
  // Optional dependencies: those installed and made for this machine (platform-specific binaries).
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) copyPackage(dep, dir, out, copied);
  return true;
}

async function main() {
  const { out } = args();
  if (out === REPO || REPO.startsWith(out + sep)) fail("the output folder must not contain the repository.");
  for (const f of ["styles.zip", join("locales", "locales-en-US.xml"), "NOTICE.md", "LICENSE-CC-BY-SA-3.0.txt", "LICENSE-CPAL-1.0.txt"]) {
    if (!existsSync(join(CSL, f))) fail(`the citation style bundle is incomplete (packages/core/csl/${f}); run \`pnpm fetch-csl\` first.`);
  }
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    fail("esbuild is not installed; run `pnpm install`.");
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const libraryVersion = readJson(join(LIBRARY, "package.json")).version;
  const servicePkg = readJson(join(SERVICE, "package.json"));
  // CommonJS dependencies inside an ES module bundle call require(); give them Node's.
  const banner = 'import { createRequire as __aoCreateRequire } from "node:module";\nconst require = __aoCreateRequire(import.meta.url);';
  const common = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: EXTERNAL,
    banner: { js: banner },
    absWorkingDir: REPO,
    metafile: true,
    logLevel: "warning",
    legalComments: "eof",
  };
  const results = [
    await esbuild.build({
      ...common,
      entryPoints: [join(SERVICE, "src", "main.ts")],
      outfile: join(out, "main.mjs"),
      define: { __AO_BUNDLE__: JSON.stringify({ libraryVersion }) },
    }),
    await esbuild.build({ ...common, entryPoints: [join(LIBRARY, "src", "citation", "sandbox-worker.mjs")], outfile: join(out, LAYOUT.sandboxWorker) }),
    await esbuild.build({ ...common, entryPoints: [join(LIBRARY, "src", "capture", "html-strip-worker.mjs")], outfile: join(out, LAYOUT.htmlStripWorker) }),
  ];
  // A module loaded through a computed specifier cannot be bundled and would be looked for at run
  // time beside the bundle: refuse it here (keep that package outside the bundle instead).
  for (const r of results) {
    for (const file of Object.keys(r.metafile.outputs)) {
      const code = readFileSync(resolve(REPO, file), "utf8");
      const hidden = [...code.matchAll(/[^.\w$](?:import|require|__require)\(\s*(?:\/\*[\s\S]*?\*\/\s*)*([^"'`\s)][^)]{0,60})/g)].map((m) => m[1].trim());
      if (hidden.length) fail(`${relative(out, resolve(REPO, file))} loads a module by a computed name (${hidden.slice(0, 5).join("; ")}); keep that package outside the bundle.`);
    }
  }
  for (const r of results) {
    for (const input of Object.keys(r.metafile.inputs)) {
      const abs = resolve(REPO, input);
      if (!abs.includes(`${sep}node_modules${sep}`)) continue;
      const root = packageRootOf(abs);
      if (root) record(root, "bundled");
    }
  }

  // Migrations.
  mkdirSync(join(out, LAYOUT.migrations));
  for (const f of readdirSync(join(LIBRARY, "src", "index", "migrations"))) {
    if (/^\d{4}\.sql$/.test(f)) cpSync(join(LIBRARY, "src", "index", "migrations", f), join(out, LAYOUT.migrations, f));
  }

  // The citation style bundle, with its licence and notice beside it (R86).
  mkdirSync(join(out, LAYOUT.csl));
  for (const f of ["styles.zip", "locales", "bundle.json", "NOTICE.md", "LICENSE-CC-BY-SA-3.0.txt", "LICENSE-CPAL-1.0.txt"]) {
    if (existsSync(join(CSL, f))) cpSync(join(CSL, f), join(out, LAYOUT.csl, f), { recursive: true });
  }

  // Packages kept outside the bundle, and what they need.
  const copied = new Map();
  for (const name of EXTERNAL) {
    if (!copyPackage(name, KEPT_FROM[name], out, copied)) fail(`${name} is not installed for this platform (${process.platform}-${process.arch}).`);
  }
  const { stubs } = closeTheFolder(out, copied, results);
  // The entry point: checks the environment and the build, then loads main.mjs (R153, M4).
  cpSync(join(HERE, "launcher.mjs"), join(out, "service.mjs"));

  // Load each native module from the folder once, so a build that would not start fails here.
  for (const name of NATIVE) {
    try {
      execFileSync(process.execPath, ["-e", `require(${JSON.stringify(name)})`], { cwd: out, stdio: "pipe" });
    } catch (err) {
      fail(`${name} does not load from the built folder: ${String(err.stderr ?? err).slice(0, 500)}`);
    }
  }

  writeLicences(out);

  writeFileSync(join(out, "package.json"), `${JSON.stringify({ name: "ao-library-service", version: servicePkg.version, private: true, type: "module", main: "service.mjs" }, null, 2)}\n`);
  const nativeFiles = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".node")) nativeFiles.push(relative(out, p).split(sep).join("/"));
    }
  };
  walk(join(out, "node_modules"));
  writeFileSync(
    join(out, "build-info.json"),
    `${JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        ...(libc() ? { libc: libc() } : {}),
        node: process.version,
        nodeAbi: process.versions.modules,
        libraryVersion,
        nativeModules: nativeFiles.sort(),
        packages: [...copied].map(([n, v]) => `${n}@${v}`).sort(),
        // R153: the only packages left outside the bundle (with their dependencies, in packages).
        external: EXTERNAL,
        // Names some shipped file may load that are not part of this build: each is a stub in
        // node_modules/ that fails like a missing module, so Node never looks outside the folder.
        stubs: stubs.sort(),
        // Names that appear in the bundle only inside generated-code text, never loaded (BUNDLE_TEXT_ONLY).
        neverLoaded: Object.keys(BUNDLE_TEXT_ONLY).sort(),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(out, "START.txt"), START);

  let bytes = 0;
  const size = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) size(p);
      else bytes += statSync(p).size;
    }
  };
  size(out);
  process.stdout.write(`build: ${relative(process.cwd(), out) || "."} (${(bytes / 1048576).toFixed(1)} MB; ${packages.size} npm packages; native: ${nativeFiles.join(", ")})\n`);
}

// ------------------------------------------------------------------------------------------
// R153: the folder loads code only from itself. A require() or import of a package name that is
// not in <folder>/node_modules would make Node go on looking in parent folders, the global
// folders and NODE_PATH. So every package name any shipped file can load must be in the folder:
// a copied package, a builtin, or an explicit stub (STUBS) that fails the way a missing module
// does. Loading by a computed name is allowed only where COMPUTED says why.

/**
 * Package names a shipped file may load that this build does not contain, and why that is fine:
 * each gets a stub package in node_modules/ that throws MODULE_NOT_FOUND (what a missing module
 * does), so the caller behaves as it would without it and Node never searches outside the folder.
 */
const STUBS = [
  { test: (n) => /^@napi-rs\/(canvas|keyring)-/.test(n), why: "the native binary of another platform or architecture (the napi-rs loader names every one)" },
  { test: (n) => n === "supports-color", why: "optional colour support of `debug` (it carries on without it)" },
];
/**
 * Names that appear in the bundle only inside the text of code that Ajv and fast-json-stringify
 * generate for their "standalone" mode, which Fastify does not use: never loaded. The smoke run
 * plants modules under these names outside the folder to prove it.
 */
const BUNDLE_TEXT_ONLY = {
  ajv: "Ajv's standalone code text (require(\"ajv/dist/runtime/…\"))",
  "ajv-formats": "Ajv's standalone code text",
  "fast-json-stringify": "fast-json-stringify's standalone code text",
};
/** Files that load a module by a computed name, and why each stays inside the folder. */
const COMPUTED = {
  "@napi-rs/canvas/js-binding.js": "require(process.env.NAPI_RS_NATIVE_LIBRARY_PATH) only when that variable is set; service.mjs refuses to start if it is",
  "@napi-rs/keyring/index.js": "the same NAPI_RS_NATIVE_LIBRARY_PATH override; refused by service.mjs",
  "bindings/bindings.js": "requireFunc(n) of better_sqlite3.node under the calling package's own folder (build/Release)",
  "better-sqlite3/lib/database.js": "requireFunc(nativeBinding) only when a caller passes the nativeBinding option, which the library never does",
  "exiftool-vendored/dist/ExiftoolPath.js": 'import("exiftool-vendored.pl") (".exe" on Windows), which is in the folder',
  "file-type/source/index.js": 'importAtRuntime("strtok3"), which is in the folder',
  "pdfjs-dist/legacy/build/pdf.mjs": "import(workerSrc): pdf.worker.mjs next to it in the folder",
  "pdfjs-dist/legacy/build/pdf.min.mjs": "the minified copy of pdf.mjs (not loaded)",
  "pdfjs-dist/legacy/build/pdf.worker.mjs": "the OpenJPEG wasm decoder, off (useWasm: false in extract/pdf.ts)",
  "pdfjs-dist/legacy/build/pdf.worker.min.mjs": "the minified copy of pdf.worker.mjs (not loaded)",
  "pdfjs-dist/legacy/build/pdf.sandbox.mjs": "the PDF scripting sandbox, never loaded (no scripting, extract/pdf.ts)",
  "pdfjs-dist/legacy/build/pdf.sandbox.min.mjs": "the minified scripting sandbox, never loaded",
};

const SPECIFIER_PATTERNS = [
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /\brequire\.resolve\s*\(\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)*(['"])([^'"\n]+)\1\s*\)/g,
  /^\s*import\s+(['"])([^'"\n]+)\1/gm,
  /^\s*(?:import|export)\b[^'"\n;]*?\bfrom\s*(['"])([^'"\n]+)\1/gm,
];
// require/import and the aliases of require seen in the copied packages (bindings' requireFunc).
// A static scan cannot see every alias: the smoke run's planted modules and its guard are the
// run-time proof.
const COMPUTED_PATTERN = /[^.\w$](?:import|require|__require|requireFunc)\(\s*(?:\/\*[\s\S]*?\*\/\s*)*([^"'`\s)][^)]{0,80})/g;

/** The package name of a bare specifier (undefined for relative, absolute, builtin and template ones). */
function packageNameOf(spec) {
  if (spec.includes("${") || /\s/.test(spec)) return undefined;
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || isBuiltin(spec) || /^[a-z]+:/i.test(spec)) return undefined;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function specifiersIn(code) {
  const found = new Set();
  for (const re of SPECIFIER_PATTERNS) for (const m of code.matchAll(re)) found.add(m[2]);
  return found;
}

function jsFilesUnder(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c|m)?js$/.test(e.name)) files.push(p);
    }
  };
  walk(dir);
  return files;
}

/**
 * Makes sure no require() or import of a shipped file can miss in the folder (R153): every bare
 * name loaded by a copied package is a copied package, a builtin or a stub (written here); every
 * bare name in the bundles is a builtin, a kept package or text only; every computed load is
 * accounted for in COMPUTED. Anything else fails the build. Returns the stub names.
 */
function closeTheFolder(out, copied, results) {
  const nm = join(out, "node_modules");
  const misses = new Map(); // name -> files that load it
  const problems = [];
  for (const file of jsFilesUnder(nm)) {
    const code = readFileSync(file, "utf8");
    const rel = relative(nm, file).split(sep).join("/");
    const own = rel.startsWith("@") ? rel.split("/").slice(0, 2).join("/") : rel.split("/")[0];
    for (const spec of specifiersIn(code)) {
      const name = packageNameOf(spec);
      if (!name || name === own || copied.has(name)) continue;
      if (!misses.has(name)) misses.set(name, new Set());
      misses.get(name).add(rel);
    }
    const computed = [...code.matchAll(COMPUTED_PATTERN)].map((m) => m[1].trim().slice(0, 60));
    if (computed.length && !COMPUTED[rel]) problems.push(`${rel} loads a module by a computed name (${computed.slice(0, 3).join("; ")})`);
  }
  for (const r of results) {
    for (const file of Object.keys(r.metafile.outputs)) {
      const rel = relative(out, resolve(REPO, file));
      for (const spec of specifiersIn(readFileSync(resolve(REPO, file), "utf8"))) {
        const name = packageNameOf(spec);
        if (name && !EXTERNAL.includes(name) && !BUNDLE_TEXT_ONLY[name]) problems.push(`${rel} loads ${name}, which is neither bundled nor in the folder`);
      }
    }
  }
  const stubs = [];
  for (const [name, files] of misses) {
    const rule = STUBS.find((s) => s.test(name));
    if (!rule) {
      problems.push(`${[...files].slice(0, 3).join(", ")} load${files.size === 1 ? "s" : ""} ${name}, which is not in the folder (copy it, or add a stub with a reason)`);
      continue;
    }
    const dir = join(nm, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, version: "0.0.0-not-included", private: true, main: "index.js", description: `Not part of this build: ${rule.why}.` }, null, 2)}\n`);
    writeFileSync(
      join(dir, "index.js"),
      `// Not part of the Alexandrine Oxiana library service build: ${rule.why}.\n// Fails the way a missing module does, without Node searching outside the folder (R153).\nconst e = new Error(${JSON.stringify(`Cannot find module '${name}' (not part of this build)`)});\ne.code = "MODULE_NOT_FOUND";\nthrow e;\n`,
    );
    stubs.push(name);
  }
  if (problems.length) fail(`the folder would load code from outside itself (R153):\n  ${problems.join("\n  ")}`);
  return { stubs };
}

function writeLicences(out) {
  const dir = join(out, "licences");
  mkdirSync(join(dir, "npm"), { recursive: true });
  // Typefaces (R100): the bundled fonts ship with the interface; their licences travel with the app.
  mkdirSync(join(dir, "fonts"));
  for (const f of readdirSync(FONTS)) if (/^OFL.*\.txt$/.test(f)) cpSync(join(FONTS, f), join(dir, "fonts", f));
  // citeproc-js (R124, R129) and the CSL styles (R86): the notice and both licence texts.
  mkdirSync(join(dir, "csl"));
  for (const f of ["NOTICE.md", "LICENSE-CC-BY-SA-3.0.txt", "LICENSE-CPAL-1.0.txt"]) cpSync(join(CSL, f), join(dir, "csl", f));

  const rows = [...packages.values()].sort((a, b) => a.pkg.name.localeCompare(b.pkg.name) || a.pkg.version.localeCompare(b.pkg.version));
  const lines = [
    "# Third-party notices",
    "",
    "The library service folder contains the following npm packages: bundled into `service.mjs` or",
    "`workers/` (\"bundled\"), or copied unmodified into `node_modules/` (\"copied\"). Each package's own",
    "licence files are in `licences/npm/<name>@<version>/`.",
    "",
    "Also here:",
    "- `licences/csl/`: the Citation Style Language styles and locales (CC BY-SA 3.0, `csl/` in this",
    "  folder) and citeproc-js (used under the CPAL-1.0): `NOTICE.md`, `LICENSE-CC-BY-SA-3.0.txt`,",
    "  `LICENSE-CPAL-1.0.txt` (the same files are next to the styles in `csl/`).",
    "- `licences/fonts/`: the SIL Open Font License texts of the typefaces the app bundles.",
    "",
    "| Package | Version | Licence | How | Licence files |",
    "| --- | --- | --- | --- | --- |",
  ];
  const problems = [];
  for (const { dir: pdir, pkg, how } of rows) {
    const id = `${pkg.name}@${pkg.version}`;
    const dest = join(dir, "npm", id);
    const files = readdirSync(pdir).filter((f) => LICENCE_FILE.test(f) && statSync(join(pdir, f)).isFile());
    let note = files.join(", ");
    mkdirSync(dest, { recursive: true });
    if (files.length) {
      for (const f of files) cpSync(join(pdir, f), join(dest, f));
    } else {
      // A package whose npm tarball has no licence file: its text from LICENCE_TEXT_FROM, or the build fails.
      const text = LICENCE_TEXT_FROM.find((x) => x.test(pkg.name))?.text(pkg, rows);
      if (!text) problems.push(`${id} has no licence file (add its text to LICENCE_TEXT_FROM)`);
      else {
        writeFileSync(join(dest, "LICENSE"), text.body);
        note = `LICENSE (${text.source})`;
      }
    }
    const licence = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(" OR ") : undefined));
    if (!licence || /^(UNKNOWN|UNLICENSED|SEE LICENSE)/i.test(licence)) problems.push(`${id} declares no usable licence (${licence ?? "none"})`);
    const used = USED_UNDER[pkg.name] ? ` (used under ${USED_UNDER[pkg.name]})` : "";
    lines.push(`| ${pkg.name} | ${pkg.version} | ${licence}${used} | ${how} | ${note} |`);
  }
  if (problems.length) fail(`licences:\n  ${problems.join("\n  ")}`);
  lines.push("");
  writeFileSync(join(dir, "THIRD-PARTY-NOTICES.md"), lines.join("\n"));
}

/** Where a dual-licensed package's licence is chosen. */
const USED_UNDER = { citeproc: "CPAL-1.0, R124; see licences/csl/NOTICE.md" };

/**
 * Licence texts for packages whose npm tarball has none (review M1). Each names its source; a
 * package without a licence file and missing from here fails the build.
 */
const LICENCE_TEXT_FROM = [
  {
    // The platform binaries of @napi-rs/canvas and @napi-rs/keyring are built from the same
    // repository as the package itself, under the same licence: that package's LICENSE file.
    test: (n) => /^@napi-rs\/(canvas|keyring)-/.test(n),
    text: (pkg, rows) => {
      const parentName = pkg.name.replace(/^(@napi-rs\/(?:canvas|keyring))-.*$/, "$1");
      const parent = rows.find((r) => r.pkg.name === parentName);
      const f = parent && readdirSync(parent.dir).find((x) => /^licen[cs]e/i.test(x));
      return f ? { body: readFileSync(join(parent.dir, f), "utf8"), source: `from ${parentName}, the same repository` } : undefined;
    },
  },
  ...[
    ["@tokenizer/token", "tokenizer-token.txt"],
    ["abstract-logging", "abstract-logging.txt"],
  ].map(([name, file]) => ({
    test: (n) => n === name,
    text: () => ({ body: readFileSync(join(HERE, "licence-texts", file), "utf8"), source: `from scripts/licence-texts/${file}` }),
  })),
];

const START = `Alexandrine Oxiana library service (built folder)

Start it with the Node.js 22 that matches build-info.json (same platform, architecture and ABI):

  node --max-old-space-size=512 service.mjs

--max-old-space-size=512 is required: it caps the JavaScript heap at 512 MB (R64, R96), which the
program cannot set for itself once started.

The access token: one line on standard input (R98), for example
  printf '%s\\n' "$TOKEN" | node --max-old-space-size=512 service.mjs
It is never read from the environment or the command line: the service refuses to start if
AO_SERVICE_TOKEN is set or if it is given any argument.

Give it an allow-listed environment (R153), never the launcher's own. It uses only:
  PATH, HOME, TMPDIR (TEMP/TMP on Windows), LANG and LC_*, TZ
  AO_SERVICE_PORT   port on 127.0.0.1 (default 0: any free port)
  AO_CONFIG_DIR     the app settings folder
  AO_LIBRARY        a library folder to open at start (optional)
  AO_WORKER_BIN     the packaged media worker (required for capture, transcription, proxies and OCR;
                    this folder does not contain it), or AO_NO_WORKER=1 to run without it
  and, passed on to the media worker it starts: AO_MODELS_DIR, AO_TOOLS_DIR, TESSDATA_PREFIX,
  XDG_*, HTTP_PROXY/HTTPS_PROXY/NO_PROXY, SSL_CERT_FILE/SSL_CERT_DIR, when they are needed.
Must NOT be set: NODE_OPTIONS, NODE_PATH, NAPI_RS_NATIVE_LIBRARY_PATH (each can make Node load code
from outside this folder; NODE_OPTIONS even acts before the service can check), and
AO_SERVICE_TOKEN. service.mjs refuses to start if any of them is set, and if this folder was built
for another platform, architecture or Node ABI (build-info.json).

It prints "AO_SERVICE_READY port=<n>" when it is listening, and stops cleanly on SIGTERM.
Licences: licences/THIRD-PARTY-NOTICES.md.
`;

await main();
