// Runs the tests that skip themselves when run as root (FR-421, ledger line 874), as a user that is not root.
//
//   pnpm test:nonroot
//
// Some tests check what happens when a file cannot be read (EACCES): root reads every file whatever its permissions,
// so they are skipped as root (`it.skipIf(asRoot)`, where `asRoot` is `process.getuid() === 0`). The project's
// verification runs as root, so without this step they never run. This script finds those test files by that pattern,
// and:
//   - as root: runs exactly those files as the system user `nobody` (uid and gid 65534), through `setpriv` (util-linux),
//     or `runuser` where setpriv is missing. `nobody` owns nothing, so a file it may not read is really unreadable to it;
//     setpriv switches the user with no login session, no PAM and no shell (nobody's shell is nologin, so `su` cannot
//     run a command as it), and clears the supplementary groups. Nothing in the repository is changed: the checkout must
//     already be readable by others (it is when cloned with the usual umask); Vitest is told to load its configuration
//     without writing a bundled copy of it next to the package (`--configLoader runner`), and HOME and the report are
//     in a fresh private folder owned by nobody under the system's temporary folder, removed afterwards;
//   - not as root: says so, and runs them directly as the current user.
// It fails if any of those tests is skipped, fails, or did not run.
import { spawnSync } from "node:child_process";
import { chownSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

export const NOBODY = { name: "nobody", uid: 65534, gid: 65534 };
/** Where the project's unit tests live: each package's and app's `src` (not the end-to-end suites). */
const SOURCE_ROOTS = ["packages", "apps"];
const TEST_FILE = /\.test\.(?:ts|tsx|mts|mjs)$/u;

/**
 * Whether a test file skips tests when run as root: a name bound to an expression that compares `getuid()` with 0, used
 * as `skipIf(name)` or `runIf(!name)`; or such a comparison written inside `skipIf(...)` itself.
 */
export function isRootSkipped(text) {
  const names = [];
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/gu)) {
    if (/getuid\b/u.test(m[2]) && /===\s*0\b/u.test(m[2])) names.push(m[1]);
  }
  for (const n of names) {
    if (new RegExp(`\\.skipIf\\(\\s*${n.replace(/\$/gu, "\\$")}\\s*\\)`, "u").test(text)) return true;
    if (new RegExp(`\\.runIf\\(\\s*!\\s*${n.replace(/\$/gu, "\\$")}\\s*\\)`, "u").test(text)) return true;
  }
  return /\.skipIf\(\s*[^;\n]*getuid\b[^;\n]*===\s*0\b/u.test(text);
}

/** The test files (relative to `root`, with "/") under each package's and app's `src` that skip tests as root. */
export function rootSkippedFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (TEST_FILE.test(e.name) && isRootSkipped(readFileSync(p, "utf8"))) out.push(relative(root, p).split(sep).join("/"));
    }
  };
  for (const top of SOURCE_ROOTS) {
    if (!existsSync(join(root, top))) continue;
    for (const pkg of readdirSync(join(root, top), { withFileTypes: true })) {
      const src = join(root, top, pkg.name, "src");
      if (pkg.isDirectory() && existsSync(src)) walk(src);
    }
  }
  return out.sort();
}

/** The files grouped by the package they belong to (`packages/x`, `apps/y`), each path relative to that package. */
export function byPackage(files) {
  const out = new Map();
  for (const f of files) {
    const [top, name, ...rest] = f.split("/");
    const pkg = `${top}/${name}`;
    if (!out.has(pkg)) out.set(pkg, []);
    out.get(pkg).push(rest.join("/"));
  }
  return out;
}

/**
 * The command that runs `files` (relative to the package `cwd`) with Vitest, writing its JSON report to `report`: as
 * `nobody` through setpriv (or runuser) when `asRoot`, directly otherwise.
 */
export function command({ asRoot, launcher, node, vitest, files, report }) {
  const run = [node, vitest, "run", ...files, "--configLoader", "runner", "--reporter=default", "--reporter=json", `--outputFile.json=${report}`];
  return asRoot ? [...asNobody(launcher), ...run] : run;
}

/** What a command is prefixed with to run as `nobody`. */
export function asNobody(launcher) {
  if (launcher === "setpriv") return ["setpriv", `--reuid=${NOBODY.uid}`, `--regid=${NOBODY.gid}`, "--clear-groups", "--"];
  if (launcher === "runuser") return ["runuser", "-u", NOBODY.name, "--"];
  throw new Error("Neither setpriv nor runuser is available to run the tests as another user.");
}

/** What is wrong with a run, from Vitest's JSON report: a file that did not run, and every test that did not pass. */
export function problems(report, packageDir, files) {
  if (!report) return ["Vitest wrote no report."];
  const out = [];
  const seen = new Map((report.testResults ?? []).map((r) => [relative(packageDir, r.name).split(sep).join("/"), r]));
  for (const f of files) {
    const r = seen.get(f);
    if (!r) {
      out.push(`${f}: did not run.`);
      continue;
    }
    if (!r.assertionResults?.length) out.push(`${f}: no test ran (${r.message || r.status}).`);
    for (const a of r.assertionResults ?? []) if (a.status !== "passed") out.push(`${f}: "${a.fullName}" ${a.status}.`);
    if (r.status !== "passed" && !r.assertionResults?.some((a) => a.status !== "passed")) out.push(`${f}: ${r.status}${r.message ? ` (${r.message})` : ""}.`);
  }
  return out;
}

const has = (tool) => spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;

function main() {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
  const asRoot = process.getuid?.() === 0;
  const files = rootSkippedFiles(root);
  if (!files.length) {
    console.log("No test skips itself when run as root: nothing to run.");
    return 0;
  }
  const launcher = asRoot ? (has("setpriv") ? "setpriv" : has("runuser") ? "runuser" : undefined) : undefined;
  if (asRoot && !launcher) {
    console.error("Running as root, and neither setpriv nor runuser is available to run these tests as another user.");
    return 1;
  }
  console.log(
    asRoot
      ? `Running as root: the ${files.length} test files that skip tests as root run as the user ${NOBODY.name} (uid ${NOBODY.uid}), through ${launcher}.`
      : `Not running as root (uid ${process.getuid?.() ?? "unknown"}): the ${files.length} test files that skip tests as root run directly, as this user.`,
  );
  for (const f of files) console.log(`  ${f}`);
  const work = mkdtempSync(join(tmpdir(), "ao-test-nonroot-"));
  try {
    if (asRoot) chownSync(work, NOBODY.uid, NOBODY.gid);
    const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
    let failed = 0;
    for (const [pkg, pkgFiles] of byPackage(files)) {
      const cwd = join(root, pkg);
      const report = join(work, `${pkg.replace(/\//gu, "-")}.json`);
      const [exe, ...args] = command({ asRoot, launcher, node: process.execPath, vitest, files: pkgFiles, report });
      if (asRoot) {
        // The user must be able to read the checkout as it is: nothing here changes its permissions.
        const [user, ...userArgs] = asNobody(launcher);
        const probe = spawnSync(user, [...userArgs, process.execPath, "-e", `require("fs").accessSync(${JSON.stringify(join(cwd, pkgFiles[0]))}, require("fs").constants.R_OK)`]);
        if (probe.status !== 0) {
          console.error(`${pkg}: the user ${NOBODY.name} cannot read the checkout here; make it readable by others (or clone it with umask 022), then run this again.`);
          failed++;
          continue;
        }
      }
      console.log(`\n${pkg}:`);
      const r = spawnSync(exe, args, { cwd, stdio: "inherit", env: { ...process.env, HOME: work, NODE_ENV: "test" } });
      const json = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : undefined;
      const wrong = problems(json, cwd, pkgFiles);
      if (r.status !== 0 && !wrong.length) wrong.push(`Vitest ended with status ${r.status ?? r.signal}.`);
      for (const w of wrong) console.error(`  ${pkg}/${w}`);
      if (wrong.length) failed++;
      else console.log(`  ${pkg}: ${pkgFiles.length} file(s), every test passed (none skipped).`);
    }
    console.log(failed ? `\ntest:nonroot: FAILED in ${failed} package(s).` : `\ntest:nonroot: every test that skips itself as root ran${asRoot ? ` as ${NOBODY.name}` : ""} and passed.`);
    return failed ? 1 : 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) process.exitCode = main();
