// Tests for scripts/ci-apt-install.sh, run against stub programs (sudo, apt-get, timeout, getent) on the PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "ci-apt-install.sh");
const hasBash = spawnSync("bash", ["--version"]).status === 0;
const skip = hasBash ? false : "bash is not on the PATH";

const MIRRORS = [
  "http://us-east-2.ec2.archive.ubuntu.com/ubuntu/",
  "http://azure.archive.ubuntu.com/ubuntu/",
  "http://archive.ubuntu.com/ubuntu",
  "http://security.ubuntu.com/ubuntu/",
  "https://packages.microsoft.com/ubuntu/24.04/prod",
].join("\n") + "\n";

/** opts: downloads = list of outcomes for the download-only calls ("ok" | "fail" | "timeout"); resolves = false makes getent fail. */
function run(args, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-apt-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "log");
  writeFileSync(log, "");
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("sudo", `echo "sudo $*" >> "${log}"\nexec "$@"`);
  stub("getent", `echo "getent $*" >> "${log}"\n${opts.resolves === false ? "exit 2" : "exit 0"}`);
  // timeout: the n-th call gets the n-th outcome; "ok" runs the wrapped command.
  const outcomes = (opts.downloads ?? ["ok", "ok"]).join(" ");
  stub(
    "timeout",
    `n=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/n"
echo "timeout $*" >> "${log}"
outs=(${outcomes})
o="\${outs[$((n-1))]:-ok}"
shift
if [ "$o" = timeout ]; then exit 124; fi
if [ "$o" = fail ]; then exit 100; fi
exec "$@"`,
  );
  stub("apt-get", `echo "apt-get $*" >> "${log}"`);
  const mirrors = join(dir, "apt-mirrors.txt");
  const sources = join(dir, "ubuntu.sources");
  writeFileSync(mirrors, MIRRORS);
  writeFileSync(sources, MIRRORS);
  const r = spawnSync("bash", [script, ...args], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      CI_APT_SOURCE_FILES: `${mirrors} ${join(dir, "missing.list")} ${sources}`,
    },
    encoding: "utf8",
  });
  const calls = readFileSync(log, "utf8").split("\n").filter((l) => l && !l.startsWith("sudo ") && !l.startsWith("getent "));
  return { r, calls, mirrors: readFileSync(mirrors, "utf8"), sources: readFileSync(sources, "utf8"), log: readFileSync(log, "utf8") };
}

const O = "-o Acquire::Retries=3 -o Acquire::http::Timeout=20";
const UPDATE = `apt-get update ${O}`;
const rewritten = MIRRORS.split("\n")
  .map((l) => (l.includes("packages.microsoft.com") ? l : l.replace(/^.*$/, l ? "https://mirrors.edge.kernel.org/ubuntu/" : "")))
  .join("\n");

test("a healthy mirror: update, bounded download, install; nothing rewritten", { skip }, () => {
  const t = run(["tesseract-ocr", "ffmpeg"]);
  assert.equal(t.r.status, 0, t.r.stderr);
  // the timeout stub logs its own call, then runs the wrapped apt-get, which logs too
  assert.deepEqual(t.calls, [
    UPDATE,
    `timeout 120 apt-get install -y --download-only ${O} tesseract-ocr ffmpeg`,
    `apt-get install -y --download-only ${O} tesseract-ocr ffmpeg`,
    `apt-get install -y ${O} tesseract-ocr ffmpeg`,
  ]);
  assert.equal(t.mirrors, MIRRORS);
  assert.equal(t.sources, MIRRORS);
  assert.doesNotMatch(t.r.stdout, /::warning::/);
});

for (const [name, outcome] of [["fails", "fail"], ["runs out of time", "timeout"]]) {
  test(`the first download ${name}: other mirror, update again, second download, install`, { skip }, () => {
    const t = run(["pkg"], { downloads: [outcome, "ok"] });
    assert.equal(t.r.status, 0, t.r.stderr);
    assert.match(t.r.stdout, /::warning::The runner's package mirror failed or was too slow; using mirrors\.edge\.kernel\.org for this run\./);
    assert.equal(t.mirrors, rewritten);
    assert.equal(t.sources, rewritten);
    assert.ok(t.mirrors.includes("https://packages.microsoft.com/ubuntu/24.04/prod"));
    const kinds = t.calls.map((c) => (c.startsWith("apt-get update") ? "update" : c.startsWith("timeout 120") ? "try1" : c.startsWith("timeout 300") ? "try2" : c.includes("--download-only") ? "dl" : c.startsWith("apt-get install") ? "install" : c));
    // the stub timeout runs the wrapped apt-get for a good first try; on failure it does not
    assert.deepEqual(kinds.filter((k) => k !== "dl"), ["update", "try1", "update", "try2", "install"]);
  });
}

const primary = MIRRORS.split("\n")
  .map((l) => (l.includes("packages.microsoft.com") ? l : l.replace(/^.*$/, l ? "http://archive.ubuntu.com/ubuntu/" : "")))
  .join("\n");

for (const [name, second] of [["fails", "fail"], ["runs out of time", "timeout"]]) {
  test(`the first download fails and the second ${name}: Ubuntu's own archive, update again, third download, install`, { skip }, () => {
    const t = run(["pkg"], { downloads: ["fail", second, "ok"] });
    assert.equal(t.r.status, 0, t.r.stderr);
    assert.match(t.r.stdout, /::warning::The runner's package mirror failed or was too slow; using mirrors\.edge\.kernel\.org for this run\./);
    assert.match(t.r.stdout, /::warning::.*mirrors\.edge\.kernel\.org.*archive\.ubuntu\.com/);
    assert.equal(t.mirrors, primary);
    assert.equal(t.sources, primary);
    assert.ok(t.mirrors.includes("https://packages.microsoft.com/ubuntu/24.04/prod"));
    const kinds = t.calls.map((c) => (c.startsWith("apt-get update") ? "update" : c.startsWith("timeout 120") ? "try1" : c.startsWith("timeout 300") ? "try2" : c.includes("--download-only") ? "dl" : c.startsWith("apt-get install") ? "install" : c));
    assert.deepEqual(kinds.filter((k) => k !== "dl"), ["update", "try1", "update", "try2", "update", "try2", "install"]);
    assert.equal(t.calls.filter((c) => c.startsWith("timeout ")).length, 3);
  });
}

test("all three downloads fail: the script fails and nothing is installed", { skip }, () => {
  const t = run(["pkg"], { downloads: ["fail", "fail", "fail"] });
  assert.notEqual(t.r.status, 0);
  assert.equal(t.calls.filter((c) => c.startsWith("timeout ")).length, 3);
  assert.ok(!t.calls.some((c) => c.startsWith("apt-get install -y") && !c.includes("--download-only")), t.calls.join("\n"));
});

test("names that do not resolve and the first two downloads fail: the third try is Ubuntu's own archive", { skip }, () => {
  const t = run(["pkg"], { resolves: false, downloads: ["fail", "fail", "ok"] });
  assert.equal(t.r.status, 0, t.r.stderr);
  assert.equal(t.mirrors, primary);
});

test("names that do not resolve: files are rewritten before the first update", { skip }, () => {
  const t = run(["pkg"], { resolves: false });
  assert.equal(t.r.status, 0, t.r.stderr);
  assert.match(t.r.stdout, /::warning::Ubuntu's package mirrors do not resolve on this runner; using mirrors\.edge\.kernel\.org for this run\./);
  assert.equal(t.mirrors, rewritten);
  // rewritten before the update: the first logged sudo call is sed
  const firstSudo = t.log.split("\n").find((l) => l.startsWith("sudo "));
  assert.match(firstSudo, /^sudo sed /);
});

test("options pass through to the download and the install", { skip }, () => {
  const t = run(["--no-install-recommends", "a", "b"]);
  assert.equal(t.r.status, 0, t.r.stderr);
  const dl = t.calls.filter((c) => c.includes("--download-only"));
  assert.ok(dl.length >= 1);
  for (const c of dl) assert.match(c, /--no-install-recommends a b$/);
  const inst = t.calls.filter((c) => c.startsWith("apt-get install -y ") && !c.includes("--download-only"));
  assert.equal(inst.length, 1);
  assert.match(inst[0], /--no-install-recommends a b$/);
});

test("a listed file that does not exist does not stop the script", { skip }, () => {
  const t = run(["pkg"], { downloads: ["fail", "ok"] });
  assert.equal(t.r.status, 0, t.r.stderr);
  assert.ok(!existsSync(join(tmpdir(), "missing.list")));
});
