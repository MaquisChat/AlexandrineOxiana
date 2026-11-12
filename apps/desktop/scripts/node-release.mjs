// The Node.js program the Mac app ships beside the library service (ADR 0013, Task 37f): the
// official release archive for one architecture, pinned by version and SHA-256 in
// apps/desktop/macos/pins.json (the checksum copied from the release's SHASUMS256.txt). The archive
// is checked before anything is extracted from it; a cached archive that does not match is deleted
// and downloaded again; nothing unpinned is ever fetched. The extracted release folder holds
// `bin/node` (what the app ships) and `LICENSE` (what the notices ship, ADR 0015).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PINS_FILE = join(DESKTOP, "macos", "pins.json");
export const PINS = JSON.parse(readFileSync(PINS_FILE, "utf8"));

/** The pinned archive for a platform and architecture (Node's own names: darwin, arm64 / x64). */
export function nodePin(platform = process.platform, arch = process.arch, pins = PINS) {
  const key = `${platform}-${arch}`;
  const sha256 = pins.node.sha256[key];
  if (!sha256) throw new Error(`there is no pinned Node.js for ${key} (apps/desktop/macos/pins.json pins ${Object.keys(pins.node.sha256).join(", ")})`);
  const v = pins.node.version;
  const dir = `node-${v}-${key}`;
  return { version: v, key, dir, archive: `${dir}.tar.gz`, url: `https://nodejs.org/dist/${v}/${dir}.tar.gz`, sha256 };
}

/** Checks a file's SHA-256; returns it, or throws naming both values. */
export function verifySha256(file, expected) {
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`the expected checksum must be 64 hexadecimal characters, not "${expected}"`);
  const got = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (got !== expected) throw new Error(`the SHA-256 of ${file} is ${got}, which does not match the pinned ${expected}`);
  return got;
}

const verifies = (file, expected) => {
  try {
    verifySha256(file, expected);
    return true;
  } catch {
    return false;
  }
};

/**
 * The pinned release, extracted under `cacheDir`: { releaseDir, node, licence }. Uses a cached archive
 * that verifies; otherwise downloads it once (`fetchImpl`, the global fetch by default), verifies it,
 * and only then extracts it (with the system's tar) into a fresh folder.
 */
export async function ensureNodeRelease({ cacheDir, pin = nodePin(), fetchImpl = globalThis.fetch, log = () => {} }) {
  mkdirSync(cacheDir, { recursive: true });
  const archive = join(cacheDir, pin.archive);
  if (existsSync(archive) && !verifies(archive, pin.sha256)) {
    log(`node: the cached ${pin.archive} does not match its pin; downloading it again`);
    rmSync(archive, { force: true });
  }
  if (!existsSync(archive)) {
    log(`node: downloading ${pin.url}`);
    const res = await fetchImpl(pin.url);
    if (!res.ok) throw new Error(`could not download ${pin.url}: HTTP ${res.status}`);
    const part = `${archive}.part`;
    writeFileSync(part, Buffer.from(await res.arrayBuffer()));
    try {
      verifySha256(part, pin.sha256);
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    }
    renameSync(part, archive);
  }
  verifySha256(archive, pin.sha256);
  log(`node: ${pin.archive} matches its pinned SHA-256 ${pin.sha256}`);

  const releaseDir = join(cacheDir, pin.dir);
  rmSync(releaseDir, { recursive: true, force: true });
  const r = spawnSync("tar", ["-xzf", archive, "-C", cacheDir, `${pin.dir}/`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`could not extract ${pin.archive}: ${r.stderr || r.error?.message}`);
  const node = join(releaseDir, "bin", "node");
  const licence = join(releaseDir, "LICENSE");
  if (!existsSync(node)) throw new Error(`${pin.archive} has no bin/node`);
  if (!existsSync(licence)) throw new Error(`${pin.archive} has no LICENSE`);
  return { releaseDir, node, licence };
}
