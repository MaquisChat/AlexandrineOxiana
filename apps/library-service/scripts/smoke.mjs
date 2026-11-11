#!/usr/bin/env node
// Smoke run of the built library service outside the repository (Task 37a):
//
//   node apps/library-service/scripts/smoke.mjs [--no-build] [--keep]
//
// 1. builds the folder (scripts/build.mjs), unless --no-build;
// 2. copies it to an empty folder under os.tmpdir(), outside the repository, and checks no file
//    in the copy names the repository's path;
// 3. starts it with plain `node` and the documented flags (--max-old-space-size=512), plus a guard
//    preloaded with --import (in the service and every worker thread; written outside the
//    repository) that makes the repository unreachable: any module resolved or loaded from it and
//    any fs call on a path inside it is refused and reported (`AO_GUARD_DENIED`), which fails the
//    run even if the service swallowed the error. (Node's permission model would be stricter but
//    disables fchmod, which the library's atomic writes use.) The child's environment names no
//    path in the repository (PATH entries inside it are dropped);
// 4. over HTTP: creates a library and a project, attaches a PDF, renders a citation with a bundled
//    style and with an imported one (the sandbox worker and citeproc from the folder), cleans an
//    HTML snapshot (the cleaner's worker), and searches for a word of the PDF's text;
// 5. checks (Linux) that every native module mapped into the process is in the copied folder;
// 6. stops it with SIGTERM and checks it exited cleanly and left no process behind.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = resolve(HERE, "..");
const REPO = realpathSync(resolve(SERVICE, "../.."));
const DIST = join(SERVICE, "dist", "library-service");
const argv = new Set(process.argv.slice(2));

/** The guard preloaded into the service (see 3. above); `repo` is the path made unreachable. */
function guardSource(repo) {
  return `// Test-only guard of the Task 37a smoke run: the repository is unreachable.
import fs from "node:fs";
import Module, { register } from "node:module";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

const REPO = ${JSON.stringify(repo)};
const SEP = ${JSON.stringify(sep)};
const inRepo = (p) => {
  let s;
  try {
    s = typeof p === "string" ? p : p instanceof URL ? fileURLToPath(p) : Buffer.isBuffer(p) ? p.toString() : undefined;
  } catch {
    return false;
  }
  return !!s && (s === REPO || s.startsWith(REPO + SEP));
};
const deny = (what, p) => {
  process.stderr.write("AO_GUARD_DENIED " + what + " " + String(p) + "\\n");
  const e = new Error("the repository is unreachable in this smoke run");
  e.code = "EACCES";
  return e;
};
for (const name of Object.keys(fs)) {
  const f = fs[name];
  if (typeof f !== "function" || /^[A-Z]/.test(name) || name === "watch" || name === "unwatchFile") continue;
  fs[name] = Object.assign(function (...args) {
    for (const a of args.slice(0, 2)) if (inRepo(a)) {
      const e = deny("fs." + name, a);
      if (name === "existsSync") return false;
      throw e;
    }
    return f.apply(this, args);
  }, f);
}
for (const name of Object.keys(fs.promises)) {
  const f = fs.promises[name];
  if (typeof f !== "function") continue;
  fs.promises[name] = async function (...args) {
    for (const a of args.slice(0, 2)) if (inRepo(a)) throw deny("fs.promises." + name, a);
    return f.apply(this, args);
  };
}
Module.syncBuiltinESMExports();
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (...args) {
  const r = resolveFilename.apply(this, args);
  if (inRepo(r)) throw deny("require", r);
  return r;
};
register("data:text/javascript," + encodeURIComponent(\`
const REPO = \${JSON.stringify(REPO)};
const inRepo = (u) => u.startsWith("file://") && decodeURIComponent(new URL(u).pathname).startsWith(REPO + ${JSON.stringify(sep)});
export async function resolve(s, c, next) {
  const r = await next(s, c);
  if (inRepo(r.url)) { process.stderr.write("AO_GUARD_DENIED import " + r.url + "\\\\n"); throw new Error("the repository is unreachable in this smoke run"); }
  return r;
}
\`));
if (isMainThread) process.stderr.write("AO_GUARD_ACTIVE\\n");
`;
}

const WORD = "quillwortsmoke"; // in the PDF's title, read by the extractor (pdfjs) and found by the search
const TITLE = `Notes on the ${WORD} survey`;

function step(msg) {
  process.stdout.write(`smoke: ${msg}\n`);
}
function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * How the token reaches the service: today AO_SERVICE_TOKEN in its environment. When the service
 * reads it from standard input (Task 37b, R98), change this one helper.
 */
function passToken(env, token) {
  return { env: { ...env, AO_SERVICE_TOKEN: token }, stdin: null };
}

/** A one-page PDF whose Info title and author are set and whose page text contains `text`. */
function makePdf(text) {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Title (${TITLE}) /Author (Ada Quillfeather) >>`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** A 1×1 JPEG (JFIF), no metadata. */
const TINY_JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

const CUSTOM_STYLE =`<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">
  <info>
    <title>Smoke Test Style</title>
    <id>http://example.org/styles/smoke-test-style</id>
    <updated>2026-11-11T00:00:00+00:00</updated>
  </info>
  <citation>
    <layout prefix="[[" suffix="]]"><names variable="author"><name form="short"/></names></layout>
  </citation>
  <bibliography>
    <layout><text variable="title"/></layout>
  </bibliography>
</style>
`;

/** Every text file under `dir` that contains `needle` (relative paths). */
function filesNaming(dir, needle) {
  const hits = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|cjs|js|json|txt|md|sql|xml|pl|pm)$/i.test(e.name) && statSync(p).size < 64 * 1024 * 1024 && readFileSync(p, "latin1").includes(needle)) hits.push(p.slice(dir.length + 1));
    }
  };
  walk(dir);
  return hits;
}

/** PIDs (Linux, /proc) of processes whose command line mentions `needle`. */
function processesNaming(needle) {
  if (process.platform !== "linux") return [];
  const out = [];
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle)) out.push(Number(pid));
    } catch {
      /* gone */
    }
  }
  return out;
}

async function main() {
  if (!argv.has("--no-build")) {
    step("building");
    execFileSync(process.execPath, [join(HERE, "build.mjs"), "--out", DIST], { stdio: "inherit" });
  }
  check(existsSync(join(DIST, "service.mjs")), "no built folder (run the build first)");

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ao-service-smoke-")));
  check(!tmp.startsWith(REPO + sep), "the temporary folder is inside the repository");
  const app = join(tmp, "app");
  let child;
  let ok = false;
  try {
    cpSync(DIST, app, { recursive: true, dereference: true });
    const naming = filesNaming(app, REPO);
    check(naming.length === 0, `files in the built folder name the repository's path: ${naming.slice(0, 10).join(", ")}`);
    step(`copied to ${app}`);

    for (const d of ["home", "config", "tmp", "in"]) mkdirSync(join(tmp, d));
    const pdfPath = join(tmp, "in", "smoke.pdf");
    writeFileSync(pdfPath, makePdf("A page of the smoke test PDF"));

    const token = randomBytes(32).toString("hex");
    // Nothing in the child's environment names a path in the repository (`pnpm run` puts
    // <repo>/node_modules/.bin on PATH).
    const path = (process.env.PATH ?? "/usr/bin:/bin")
      .split(":")
      .filter((d) => d && !(resolve(d) === REPO || resolve(d).startsWith(REPO + sep)))
      .join(":");
    const baseEnv = {
      PATH: path,
      HOME: join(tmp, "home"),
      TMPDIR: join(tmp, "tmp"),
      LANG: "C.UTF-8",
      AO_CONFIG_DIR: join(tmp, "config"),
      AO_SERVICE_PORT: "0",
      AO_NO_WORKER: "1",
    };
    const { env, stdin } = passToken(baseEnv, token);
    const guard = join(tmp, "guard", "guard.mjs");
    mkdirSync(dirname(guard));
    writeFileSync(guard, guardSource(REPO));
    const flags = ["--max-old-space-size=512"]; // the documented start (START.txt, ADR 0013)
    step(`starting: node ${flags.join(" ")} service.mjs (with the guard: the repository unreachable)`);
    const started = Date.now();
    child = spawn(process.execPath, [...(argv.has("--no-guard") ? [] : ["--import", pathToFileURL(guard).href]), ...flags, "service.mjs"], { cwd: app, env, stdio: ["pipe", "pipe", "pipe"] });
    if (stdin !== null) child.stdin.write(stdin);
    let logs = "";
    const denied = [];
    let guardActive = false;
    const onOutput = (d) => {
      logs += d;
      for (const m of String(d).matchAll(/^AO_GUARD_DENIED .*$/gm)) denied.push(m[0]);
      if (/AO_GUARD_ACTIVE/.test(String(d))) guardActive = true;
      if (logs.length > 200_000) logs = logs.slice(-100_000);
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
    const port = await new Promise((resolveP, rejectP) => {
      let buf = "";
      const timer = setTimeout(() => rejectP(new Error(`the service did not report ready in 60 s\n${logs.slice(-4000)}`)), 60_000);
      child.stdout.on("data", (d) => {
        buf += d;
        const m = /AO_SERVICE_READY port=(\d+)/.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolveP(Number(m[1]));
        }
      });
      exited.then(({ code, signal }) => {
        clearTimeout(timer);
        rejectP(new Error(`the service exited before it was ready (${code ?? signal})\n${logs.slice(-4000)}`));
      });
    });
    step(`ready on port ${port} after ${Date.now() - started} ms`);

    const call = async (method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 1000)}\n${logs.slice(-4000)}`);
      return text ? JSON.parse(text) : {};
    };

    await call("POST", "/libraries", { path: join(tmp, "library"), name: "Smoke library" });
    step("library created");
    const governanceYaml = [
      "identifiability:",
      "  containsIdentifiable: false",
      "encryption:",
      "  atRest: optional",
      "consent:",
      "  requireLegalBasis: false",
      "processing:",
      "  metadata_lookup: []",
      "captureMethods: [manual_upload, browser_capture]",
      "",
    ].join("\n");
    const { project } = await call("POST", "/projects", { name: "Smoke project", governanceYaml, encryption: { enabled: false } });
    check(project?.id, "no project id");
    step("project created");

    const attached = await call("POST", `/projects/${project.id}/attach`, { paths: [pdfPath] });
    const sourceId = attached.items?.[0]?.sourceId;
    check(sourceId, `the PDF was not attached: ${JSON.stringify(attached).slice(0, 500)}`);
    step("PDF attached");

    // A photo: its metadata is read by ExifTool, run with Perl from the folder's exiftool-vendored.pl.
    const jpgPath = join(tmp, "in", "photo.jpg");
    writeFileSync(jpgPath, Buffer.from(TINY_JPEG, "base64"));
    const photo = await call("POST", `/projects/${project.id}/attach`, { paths: [jpgPath] });
    check(photo.items?.[0]?.sourceId, `the photo was not attached: ${JSON.stringify(photo).slice(0, 500)}`);
    if (process.platform === "linux") {
      check(processesNaming(join(app, "node_modules", "exiftool-vendored.pl")).length > 0, "ExifTool is not running from the built folder");
    }
    step("photo attached (ExifTool from the folder)");

    const apa = await call("POST", "/cite", { projectId: project.id, refs: [{ sourceId }], style: "apa", format: "text" });
    check(/Quillfeather/.test(apa.text ?? ""), `the APA citation does not name the author: ${JSON.stringify(apa)}`);
    step(`citation (bundled style): ${apa.text}`);
    const { id: styleId } = await call("POST", "/styles", { projectId: project.id, xml: CUSTOM_STYLE });
    const custom = await call("POST", "/cite", { projectId: project.id, refs: [{ sourceId }], style: styleId, format: "text" });
    check(/^\[\[.*Quillfeather.*\]\]$/.test(custom.text ?? ""), `the imported style did not render: ${JSON.stringify(custom)}`);
    step(`citation (imported style, sandboxed): ${custom.text}`);

    const page = `<!doctype html><html><head><title>Smoke page</title><script>alert(1)</script></head><body><p onclick="alert(2)">Snapshotword</p><img src="https://example.org/x.png" onerror="alert(3)"></body></html>`;
    const captured = await call("POST", "/capture/browser", { projectId: project.id, url: "https://example.org/smoke-page", html: page });
    check(captured.sourceId, `the page was not captured: ${JSON.stringify(captured).slice(0, 500)}`);
    const snapshots = [];
    const findHtml = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) findHtml(p);
        else if (/\.html?$/i.test(e.name)) snapshots.push(readFileSync(p, "utf8"));
      }
    };
    findHtml(join(tmp, "library"));
    const snap = snapshots.find((s) => s.includes("Snapshotword"));
    check(snap, "the cleaned HTML snapshot was not stored");
    check(!/<script/i.test(snap) && !/onclick|onerror|alert\(/i.test(snap), `the stored snapshot was not cleaned: ${snap.slice(0, 500)}`);
    step("HTML snapshot cleaned and stored");

    let found;
    for (let i = 0; i < 50 && !found; i++) {
      const r = await call("GET", `/projects/${project.id}/sources?text=${WORD}`);
      found = r.items?.find((it) => it.id === sourceId);
      if (!found) await new Promise((r2) => setTimeout(r2, 200));
    }
    check(found, `searching for a word of the PDF's title did not find it`);
    step(`search found the PDF ("${found.title}")`);

    check(guardActive, "the guard did not start in the service");
    if (process.platform === "linux") {
      const mapped = [...new Set(readFileSync(`/proc/${child.pid}/maps`, "utf8").split("\n").map((l) => l.split(/\s+/).slice(5).join(" ")).filter((f) => f.endsWith(".node")))];
      check(mapped.length > 0, "no native module is loaded (better-sqlite3 should be)");
      const outside = mapped.filter((f) => !f.startsWith(app + sep));
      check(outside.length === 0, `native modules loaded from outside the built folder: ${outside.join(", ")}`);
      step(`native modules loaded from the folder: ${mapped.map((f) => f.slice(app.length + 1)).join(", ")}`);
    }

    child.kill("SIGTERM");
    const exit = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ timeout: true }), 100_000))]);
    check(!exit.timeout, "the service did not stop within 100 s of SIGTERM");
    check(exit.code === 0, `the service exited with ${exit.code ?? exit.signal}\n${logs.slice(-4000)}`);
    child = undefined;
    // Helpers (exiftool) are stopped with the service; give the kernel a moment to reap them.
    let left = processesNaming(app);
    for (let i = 0; i < 20 && left.length; i++) {
      await new Promise((r) => setTimeout(r, 250));
      left = processesNaming(app);
    }
    check(left.length === 0, `processes left running from the built folder: ${left.join(", ")}`);
    step("stopped cleanly; no process left");
    check(denied.length === 0, `the service reached into the repository:\n${denied.slice(0, 20).join("\n")}`);
    step("nothing was looked up in the repository");
    ok = true;
  } finally {
    if (child) child.kill("SIGKILL");
    if (argv.has("--keep") || !ok) step(`kept ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }
  step("passed");
}

main().catch((err) => {
  process.stderr.write(`smoke: FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
