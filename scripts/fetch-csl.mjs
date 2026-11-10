#!/usr/bin/env node
// Builds the CSL bundle that @ao/core's citation engine reads (spec 8.1, Task 28, R86):
//
//   packages/core/csl/styles.zip   every style of citation-style-language/styles (independent styles
//                                  under styles/, dependent ones under dependent/), plus index.json
//                                  ({ id, title, file, parent? } per style), renamed-styles.json and
//                                  the licence and notice files
//   packages/core/csl/locales/     every locales-*.xml of citation-style-language/locales, plus
//                                  locales.json
//   packages/core/csl/bundle.json  the commits and hashes the bundle was built from
//
// All three are generated (gitignored; about 20 MB) and rebuilt by `pnpm fetch-csl` in setup and CI.
// The licence and notice (packages/core/csl/LICENSE-CC-BY-SA-3.0.txt, NOTICE.md) are committed.
//
// Pinning: each repository is pinned by commit and by the sha256 of its tar archive (the
// uncompressed tar, which is what `git archive` produces deterministically for a commit; the gzip
// framing of GitHub's tarballs is not guaranteed to stay byte-identical, the tar inside is). The
// tarball is downloaded from codeload.github.com; if that host cannot be reached, the same tar is
// made with `git fetch --depth 1 <repo> <commit>` + `git archive`, and checked against the same
// sha256. Any mismatch fails closed: nothing is written, exit 1. Any other failure exits 1 too (the
// citation tests then skip locally, and fail in CI). A bundle already built from the pinned
// hashes is kept.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "packages", "core", "csl");

export const PINS = {
  styles: {
    repo: "citation-style-language/styles",
    commit: "af0aea3fffd44fe798cce9285598d0d5cf62ef23", // 2026-11-06
    tarSha256: "7a07923cad670f26b3127541731e46d79b943c5cdfb5f1febf84c9af239955b9",
  },
  locales: {
    repo: "citation-style-language/locales",
    commit: "8bef426f89f38c0789223c50e53ec2197bc50bb3", // 2026-10-20
    tarSha256: "56ef73f52d895bc851e5fb58af7bcd5a0a2cd7c478b02d321d3754627a7e7c92",
  },
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const prefixOf = (pin) => `${pin.repo.split("/")[1]}-${pin.commit}/`;

class MismatchError extends Error {}

async function fromCodeload(pin) {
  const url = `https://codeload.github.com/${pin.repo}/tar.gz/${pin.commit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from codeload.github.com`);
  return gunzipSync(Buffer.from(await res.arrayBuffer()));
}

function fromGit(pin) {
  const dir = mkdtempSync(join(tmpdir(), "ao-csl-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    git("fetch", "-q", "--depth", "1", `https://github.com/${pin.repo}`, pin.commit);
    return git("archive", "--format=tar", `--prefix=${prefixOf(pin)}`, pin.commit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function tarOf(name, pin) {
  let tar;
  try {
    tar = await fromCodeload(pin);
    console.log(`${name}: downloaded from codeload.github.com`);
  } catch (err) {
    console.log(`${name}: codeload.github.com unavailable (${err?.cause?.code ?? err?.message ?? err}); using git fetch of the pinned commit`);
    tar = fromGit(pin);
  }
  const got = sha256(tar);
  if (got !== pin.tarSha256) throw new MismatchError(`${name}: sha256 mismatch for ${pin.repo}@${pin.commit} (got ${got}, pinned ${pin.tarSha256}); nothing written`);
  return tar;
}

/** Regular files of a ustar/pax tar (as git archive writes it): Map<path, Buffer>. */
function untar(tar) {
  const files = new Map();
  let off = 0;
  let paxPath;
  const str = (b) => b.toString("utf8").replace(/\0.*$/s, "");
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h.subarray(345, 500));
    const name = (prefix ? `${prefix}/` : "") + str(h.subarray(0, 100));
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      for (const rec of body.toString("utf8").split("\n")) {
        const m = /^\d+ path=(.*)$/s.exec(rec);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (type === "g") continue;
    if (type === "0" || type === "\0") files.set(paxPath ?? name, Buffer.from(body));
    paxPath = undefined;
  }
  return files;
}

const xmlText = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

function styleInfo(xml) {
  const info = /<info>([\s\S]*?)<\/info>/.exec(xml)?.[1] ?? "";
  const title = /<title>([\s\S]*?)<\/title>/.exec(info)?.[1];
  const parent = /<link\s+href="([^"]+)"\s+rel="independent-parent"/.exec(info)?.[1] ?? /<link\s+rel="independent-parent"\s+href="([^"]+)"/.exec(info)?.[1];
  return { title: title ? xmlText(title.trim()) : undefined, parent: parent ? parent.replace(/^.*\//, "") : undefined };
}

async function main() {
  const licence = join(outDir, "LICENSE-CC-BY-SA-3.0.txt");
  const notice = join(outDir, "NOTICE.md");
  for (const f of [licence, notice]) if (!existsSync(f)) throw new Error(`missing ${f} (committed with the bundle script)`);
  const meta = { styles: PINS.styles, locales: PINS.locales };
  const metaPath = join(outDir, "bundle.json");
  if (existsSync(metaPath) && existsSync(join(outDir, "styles.zip")) && existsSync(join(outDir, "locales", "locales-en-US.xml"))) {
    try {
      const cur = JSON.parse(readFileSync(metaPath, "utf8"));
      if (JSON.stringify({ styles: cur.styles, locales: cur.locales }) === JSON.stringify(meta)) {
        console.log("ok (cached) CSL bundle at the pinned commits");
        return;
      }
    } catch {
      // rebuild
    }
  }

  const stylesTar = untar(await tarOf("styles", PINS.styles));
  const localesTar = untar(await tarOf("locales", PINS.locales));

  // fflate is a dependency of @ao/core (it reads the zip there too).
  const req = createRequire(join(root, "packages", "core", "package.json"));
  const { zipSync, strToU8 } = await import(pathToFileURL(req.resolve("fflate")).href);

  const sp = prefixOf(PINS.styles);
  const zip = {};
  const index = [];
  for (const [path, buf] of [...stylesTar].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!path.startsWith(sp)) continue;
    const rel = path.slice(sp.length);
    const m = /^(dependent\/)?([a-z0-9][a-z0-9-]*)\.csl$/.exec(rel);
    if (!m) continue;
    const { title, parent } = styleInfo(buf.toString("utf8"));
    if (!title) throw new Error(`style without a title: ${rel}`);
    index.push({ id: m[2], title, file: rel, ...(m[1] ? { parent: parent ?? null } : {}) });
    zip[rel] = buf;
  }
  const renamed = stylesTar.get(`${sp}renamed-styles.json`);
  if (renamed) zip["renamed-styles.json"] = renamed;
  zip["index.json"] = strToU8(JSON.stringify(index));
  zip["LICENSE-CC-BY-SA-3.0.txt"] = readFileSync(licence);
  zip["NOTICE.md"] = readFileSync(notice);
  const zipped = zipSync(zip, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") });

  const lp = prefixOf(PINS.locales);
  const locales = [];
  for (const [path, buf] of localesTar) {
    const rel = path.startsWith(lp) ? path.slice(lp.length) : "";
    if (/^locales-[A-Za-z0-9-]+\.xml$/.test(rel) || rel === "locales.json") locales.push([rel, buf]);
  }
  if (!locales.some(([n]) => n === "locales-en-US.xml")) throw new Error("locales: locales-en-US.xml missing");

  // Write: locales into a fresh folder swapped in, then the zip, then bundle.json last (the marker).
  mkdirSync(outDir, { recursive: true });
  rmSync(metaPath, { force: true });
  const locTmp = join(outDir, "locales.tmp");
  rmSync(locTmp, { recursive: true, force: true });
  mkdirSync(locTmp);
  for (const [n, buf] of locales) writeFileSync(join(locTmp, n), buf);
  rmSync(join(outDir, "locales"), { recursive: true, force: true });
  renameSync(locTmp, join(outDir, "locales"));
  writeFileSync(join(outDir, "styles.zip.part"), zipped);
  renameSync(join(outDir, "styles.zip.part"), join(outDir, "styles.zip"));
  writeFileSync(metaPath, `${JSON.stringify({ ...meta, styleCount: index.length, localeCount: locales.length - 1 }, null, 2)}\n`);
  console.log(`ok CSL bundle: ${index.length} styles (${(zipped.length / 1e6).toFixed(1)} MB zip), ${locales.length - 1} locales`);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof MismatchError ? `FAIL ${err.message}` : `FAIL CSL bundle not built: ${err?.message ?? err}`);
  process.exit(1);
}
