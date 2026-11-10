#!/usr/bin/env node
// Fetches the bundled fonts (spec 8A.2, R100) into packages/ui/public/fonts, as pinned in
// scripts/fonts.lock.json:
//
//   Sorts Mill Goudy (regular, italic)      @fontsource/sorts-mill-goudy (npm), latin + latin-ext
//   Atkinson Hyperlegible (4 styles)        @fontsource/atkinson-hyperlegible (npm), latin + latin-ext
//   OpenDyslexic (4 styles)                 antijingoist/opendyslexic at a pinned commit, the upstream
//                                           compiled woff2 files unmodified (OpenDyslexic is a Reserved
//                                           Font Name, so the files are not subset or converted)
//
// plus each font's OFL licence text. Goudy Old Style is commercial and never bundled: the stack
// uses the user's installed copy when present.
//
// Pinning: npm packages by exact version and the sha256 of the tarball; GitHub files by commit; and
// every extracted file by its own sha256. Fails closed: any download error or hash mismatch exits 1
// and writes nothing (all files are verified in memory first, then written).
//
// The fonts are committed (about 0.6 MB in all), so this is only needed to update or restore them.
// `--check` verifies the committed files against the lock without network access.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "fonts");
const lock = JSON.parse(readFileSync(join(here, "fonts.lock.json"), "utf8"));

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

class MismatchError extends Error {}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Regular files of a ustar/pax tar: Map<path, Buffer>. */
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

function verify(label, buf, want) {
  const got = sha256(buf);
  if (got !== want) throw new MismatchError(`${label}: sha256 mismatch (got ${got}, pinned ${want}); nothing written`);
  return buf;
}

async function filesOf(source) {
  const out = [];
  if (source.kind === "npm") {
    const tgz = verify(`${source.package}@${source.version}`, await download(source.tarball), source.tarballSha256);
    const tar = untar(gunzipSync(tgz));
    for (const f of source.files) {
      const buf = tar.get(f.from);
      if (!buf) throw new Error(`${source.package}@${source.version}: ${f.from} is not in the package`);
      out.push([f.to, verify(`${source.package}/${f.from}`, buf, f.sha256)]);
    }
  } else if (source.kind === "github") {
    if (!/^[0-9a-f]{40}$/.test(source.commit)) throw new Error(`${source.repo}: not pinned to a commit`);
    for (const f of source.files) {
      const url = `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${f.from}`;
      out.push([f.to, verify(`${source.repo}@${source.commit.slice(0, 8)}/${f.from}`, await download(url), f.sha256)]);
    }
  } else {
    throw new Error(`unknown source kind ${source.kind}`);
  }
  return out;
}

function check() {
  let bad = 0;
  for (const s of lock.sources) {
    for (const f of s.files) {
      const p = join(outDir, f.to);
      if (!existsSync(p)) {
        console.error(`missing ${f.to}`);
        bad++;
      } else if (sha256(readFileSync(p)) !== f.sha256) {
        console.error(`changed ${f.to} (does not match its pinned sha256)`);
        bad++;
      }
    }
  }
  if (bad) {
    console.error(`${bad} font file(s) missing or changed; run \`pnpm --filter @ao/ui fetch-fonts\``);
    process.exit(1);
  }
  console.log("ok: bundled fonts match fonts.lock.json");
}

async function main() {
  if (process.argv.includes("--check")) return check();
  const all = [];
  for (const s of lock.sources) all.push(...(await filesOf(s)));
  // Everything verified: write each file atomically (temp file in the same folder, then rename).
  mkdirSync(outDir, { recursive: true });
  for (const [name, buf] of all) {
    const tmp = join(outDir, `.${name}.part`);
    writeFileSync(tmp, buf);
    renameSync(tmp, join(outDir, name));
  }
  console.log(`ok: ${all.length} font files verified and written to public/fonts`);
}

main().catch((err) => {
  console.error(err instanceof MismatchError ? err.message : `fetch-fonts failed: ${err?.message ?? err}`);
  process.exit(1);
});
