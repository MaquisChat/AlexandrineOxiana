// The pinned Node.js release the Mac app ships (Task 37f): the pin table, the checksum check and the
// download-verify-extract step, against local files only (no network: `fetch` is a stand-in).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ensureNodeRelease, nodePin, PINS, verifySha256 } from "./node-release.mjs";

const root = mkdtempSync(join(tmpdir(), "ao-node-release-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** A small archive shaped like the official one: <dir>/bin/node and <dir>/LICENSE. */
function fakeArchive(name, dir, { licence = true, node = true } = {}) {
  const work = mkdtempSync(join(root, "src-"));
  mkdirSync(join(work, dir, "bin"), { recursive: true });
  if (node) writeFileSync(join(work, dir, "bin", "node"), "#!/bin/sh\necho v0\n", { mode: 0o755 });
  if (licence) writeFileSync(join(work, dir, "LICENSE"), "Node.js is licensed for use as follows:\n");
  const file = join(root, name);
  const r = spawnSync("tar", ["-czf", file, "-C", work, dir]);
  assert.equal(r.status, 0, String(r.stderr));
  return { file, bytes: readFileSync(file) };
}

const noFetch = () => {
  throw new Error("the network must not be reached");
};

describe("the pin table", () => {
  it("pins one Node 22 release, with a SHA-256 for each Mac architecture", () => {
    assert.match(PINS.node.version, /^v22\.\d+\.\d+$/);
    assert.deepEqual(Object.keys(PINS.node.sha256).sort(), ["darwin-arm64", "darwin-x64"]);
    for (const h of Object.values(PINS.node.sha256)) assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(PINS.node.source, `https://nodejs.org/dist/${PINS.node.version}/SHASUMS256.txt`);
    assert.match(PINS.tauriCli, /^\d+\.\d+\.\d+$/);
  });

  it("names the official archive, its address and checksum for each architecture", () => {
    const v = PINS.node.version;
    assert.deepEqual(nodePin("darwin", "arm64"), {
      version: v,
      key: "darwin-arm64",
      dir: `node-${v}-darwin-arm64`,
      archive: `node-${v}-darwin-arm64.tar.gz`,
      url: `https://nodejs.org/dist/${v}/node-${v}-darwin-arm64.tar.gz`,
      sha256: PINS.node.sha256["darwin-arm64"],
    });
    assert.equal(nodePin("darwin", "x64").sha256, PINS.node.sha256["darwin-x64"]);
  });

  it("refuses a platform that has no pin", () => {
    assert.throws(() => nodePin("linux", "x64"), /no pinned Node\.js for linux-x64/);
    assert.throws(() => nodePin("darwin", "ia32"), /no pinned Node\.js for darwin-ia32/);
  });
});

describe("verifySha256", () => {
  it("accepts a file with the expected checksum and refuses any other", () => {
    const f = join(root, "blob");
    writeFileSync(f, "some bytes");
    assert.equal(verifySha256(f, sha("some bytes")), sha("some bytes"));
    assert.throws(() => verifySha256(f, sha("other bytes")), (e) => e.message.includes(sha("some bytes")) && e.message.includes(sha("other bytes")) && /does not match/.test(e.message));
    assert.throws(() => verifySha256(f, "not-a-hash"), /64 hexadecimal/);
  });
});

describe("ensureNodeRelease", () => {
  const pinFor = (name, dir, bytes) => ({ version: "v22.0.0", key: "darwin-arm64", dir, archive: name, url: `https://nodejs.org/dist/v22.0.0/${name}`, sha256: sha(bytes) });

  it("uses an archive already in the cache when it verifies, without the network", async () => {
    const dir = "node-v22.0.0-darwin-arm64";
    const { file, bytes } = fakeArchive("cached.tar.gz", dir);
    const cache = mkdtempSync(join(root, "cache-"));
    const pin = pinFor("node-v22.0.0-darwin-arm64.tar.gz", dir, bytes);
    writeFileSync(join(cache, pin.archive), readFileSync(file));
    const r = await ensureNodeRelease({ cacheDir: cache, pin, fetchImpl: noFetch });
    assert.equal(r.releaseDir, join(cache, dir));
    assert.equal(r.node, join(cache, dir, "bin", "node"));
    assert.equal(r.licence, join(cache, dir, "LICENSE"));
    assert.ok(existsSync(r.node));
  });

  it("downloads once when the cache is empty or holds a wrong file, and checks before extracting", async () => {
    const dir = "node-v22.0.0-darwin-arm64";
    const { bytes } = fakeArchive("good.tar.gz", dir);
    const cache = mkdtempSync(join(root, "cache-"));
    const pin = pinFor("node-v22.0.0-darwin-arm64.tar.gz", dir, bytes);
    writeFileSync(join(cache, pin.archive), "a truncated earlier download");
    const asked = [];
    const fetchImpl = async (url, opts) => {
      asked.push(url);
      // The pinned address only: a redirect to another place is an error, not followed.
      assert.equal(opts?.redirect, "error");
      return new Response(bytes);
    };
    const r = await ensureNodeRelease({ cacheDir: cache, pin, fetchImpl });
    assert.deepEqual(asked, [pin.url]);
    assert.ok(existsSync(r.node));
    assert.equal(sha(readFileSync(join(cache, pin.archive))), pin.sha256);
  });

  it("refuses a download whose checksum differs, extracts nothing and keeps nothing", async () => {
    const dir = "node-v22.0.0-darwin-arm64";
    const { bytes } = fakeArchive("good2.tar.gz", dir);
    const { bytes: evil } = fakeArchive("evil.tar.gz", dir);
    const cache = mkdtempSync(join(root, "cache-"));
    const pin = pinFor("node-v22.0.0-darwin-arm64.tar.gz", dir, bytes);
    await assert.rejects(ensureNodeRelease({ cacheDir: cache, pin, fetchImpl: async () => new Response(Buffer.concat([evil, Buffer.from("x")])) }), /does not match/);
    assert.ok(!existsSync(join(cache, dir)));
    assert.ok(!existsSync(join(cache, pin.archive)));
  });

  it("reports a failed download in plain words", async () => {
    const cache = mkdtempSync(join(root, "cache-"));
    const pin = pinFor("x.tar.gz", "x", Buffer.from("x"));
    await assert.rejects(ensureNodeRelease({ cacheDir: cache, pin, fetchImpl: async () => new Response("no", { status: 404 }) }), /could not download .*HTTP 404/);
  });

  it("refuses an archive without the program or its LICENSE (the notices need it, ADR 0015)", async () => {
    for (const [what, opts] of [["LICENSE", { licence: false }], ["bin/node", { node: false }]]) {
      const dir = "node-v22.0.0-darwin-arm64";
      const { file, bytes } = fakeArchive(`partial-${what.replace("/", "-")}.tar.gz`, dir, opts);
      const cache = mkdtempSync(join(root, "cache-"));
      const pin = pinFor("node-v22.0.0-darwin-arm64.tar.gz", dir, bytes);
      writeFileSync(join(cache, pin.archive), readFileSync(file));
      await assert.rejects(ensureNodeRelease({ cacheDir: cache, pin, fetchImpl: noFetch }), new RegExp(`has no ${what}`));
    }
  });
});
