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
//   service.mjs                    the service, bundled by esbuild (our code and every pure-JS dependency)
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
import { createRequire } from "node:module";
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
    if (!keep) return true;
    return keep.some((k) => rel === k || rel.startsWith(`${k}/`) || k.startsWith(`${rel}/`));
  };
  cpSync(dir, dest, { recursive: true, dereference: true, filter: wanted });
  record(dir, "copied");
  const skip = new Set(INSTALL_ONLY[name] ?? []);
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (skip.has(dep)) continue;
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
      outfile: join(out, "service.mjs"),
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
  const missing = [];
  for (const { dir: pdir, pkg, how } of rows) {
    const id = `${pkg.name}@${pkg.version}`;
    const dest = join(dir, "npm", id);
    const files = readdirSync(pdir).filter((f) => LICENCE_FILE.test(f) && statSync(join(pdir, f)).isFile());
    if (files.length) {
      mkdirSync(dest, { recursive: true });
      for (const f of files) cpSync(join(pdir, f), join(dest, f));
    } else missing.push(id);
    const licence = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(" OR ") : "UNKNOWN"));
    lines.push(`| ${pkg.name} | ${pkg.version} | ${licence} | ${how} | ${files.length ? files.join(", ") : "none in the package"} |`);
  }
  lines.push("");
  writeFileSync(join(dir, "THIRD-PARTY-NOTICES.md"), lines.join("\n"));
  if (missing.length) process.stdout.write(`build: no licence file in: ${missing.join(", ")} (listed with their package.json licence)\n`);
}

const START = `Alexandrine Oxiana library service (built folder)

Start it with the Node.js 22 that matches build-info.json (same platform, architecture and ABI):

  node --max-old-space-size=512 service.mjs

--max-old-space-size=512 is required: it caps the JavaScript heap at 512 MB (R64, R96), which the
program cannot set for itself once started.

Environment:
  AO_SERVICE_TOKEN  the access token (at least 32 random characters). The desktop shell passes it the
                    way the service reads it (standard input, R98, once Task 37b lands).
  AO_SERVICE_PORT   port on 127.0.0.1 (default 0: any free port)
  AO_CONFIG_DIR     the app settings folder
  AO_LIBRARY        a library folder to open at start (optional)
  AO_WORKER_BIN     the packaged media worker (required for capture, transcription, proxies and OCR;
                    this folder does not contain it), or AO_NO_WORKER=1 to run without it

It prints "AO_SERVICE_READY port=<n>" when it is listening, and stops cleanly on SIGTERM.
Licences: licences/THIRD-PARTY-NOTICES.md.
`;

await main();
