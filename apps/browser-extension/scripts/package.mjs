// Builds the extension (scripts/build.mjs) and packs dist/ into the download (Task 65):
//   dist-zip/alexandrine-oxiana-browser-extension-<version>.zip   manifest.json at the top level
//   dist-zip/alexandrine-oxiana-browser-extension-<version>.zip.sha256   "<sha256>  <name>", as sha256sum writes it
// <version> is the one in manifest.json. The Mac build's workflow (.github/workflows/desktop-macos.yml)
// runs this on Linux and uploads both files beside the Mac download.
//
// Reproducible: the same built files always give the same bytes, and so the same SHA-256. The ZIP is
// written here (no zip tool, no dependency): entries sorted by their names' bytes; every entry stored
// (no compression, so the result does not depend on the zlib inside a given Node release; GitHub
// compresses the artifact when it uploads it); the same date for every entry (1980-01-01 00:00, the
// earliest a ZIP can hold), the same mode (a plain file, 0644), no extra fields, no comments, no
// directory entries. The folder's own timestamps, modes and listing order are never read.
//
//   pnpm --filter @ao/browser-extension run package
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32 } from "node:zlib";

export const ARCHIVE_BASENAME = "alexandrine-oxiana-browser-extension";

/** The archive's file name for an extension version (a browser's version: 1 to 4 whole numbers separated by dots). */
export function archiveName(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d{0,8})(\.(0|[1-9]\d{0,8})){0,3}$/.test(version)) {
    throw new Error(`the extension's version must be one to four whole numbers separated by dots (manifest.json), not ${JSON.stringify(version)}`);
  }
  return `${ARCHIVE_BASENAME}-${version}.zip`;
}

/** One line of a .sha256 file, as `sha256sum` writes and reads it. */
export function sha256Line(hex, name) {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a SHA-256: ${hex}`);
  return `${hex}  ${name}\n`;
}

/** The entry names in archive order (sorted by their UTF-8 bytes); refuses unsafe or repeated names and a missing top-level manifest.json. */
export function entryOrder(names) {
  const seen = new Set();
  for (const n of names) {
    if (typeof n !== "string" || n === "" || n.startsWith("/") || n.includes("\\") || n.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`not a safe archive entry name: ${JSON.stringify(n)}`);
    }
    if (seen.has(n)) throw new Error(`a repeated archive entry: ${n}`);
    seen.add(n);
  }
  if (!seen.has("manifest.json")) throw new Error("the archive must hold manifest.json at its top level");
  return [...names].sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
}

/** Every file below `dir`, as relative paths with forward slashes. Refuses symbolic links and anything that is not a file or folder. */
export function listFiles(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(join(dir, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = lstatSync(join(dir, rel));
    if (st.isSymbolicLink()) throw new Error(`the built folder holds a symbolic link, which the archive does not take: ${rel}`);
    if (st.isDirectory()) out.push(...listFiles(dir, rel));
    else if (st.isFile()) out.push(rel);
    else throw new Error(`the built folder holds something that is not a file: ${rel}`);
  }
  return out;
}

// DOS date and time of 1980-01-01 00:00:00 (year 0 = 1980, month 1, day 1).
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const VERSION_NEEDED = 10; // 1.0: stored entries, nothing else
const MADE_BY = (3 << 8) | 20; // Unix, spec 2.0: the external attributes below are a Unix mode
const FLAGS = 0x0800; // names are UTF-8
const FILE_MODE = 0o100644;

/** A ZIP archive of `entries` ({name, data}), byte for byte the same for the same entries in any order. */
export function zipStored(entries) {
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  if (byName.size !== entries.length) throw new Error("a repeated archive entry");
  const names = entryOrder([...byName.keys()]);
  if (names.length > 0xffff) throw new Error("too many files for a ZIP without ZIP64");
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const data = Buffer.from(byName.get(name));
    const nameBytes = Buffer.from(name, "utf8");
    if (data.length >= 0xffffffff) throw new Error(`${name} is too large for a ZIP without ZIP64`);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAGS, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra length, comment length, disk number, internal attributes: 0
    central.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
    if (offset >= 0xffffffff) throw new Error("the archive is too large for a ZIP without ZIP64");
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/**
 * Packs the built folder `dist` into `out` (emptied first, so no older download is left beside the new
 * one). `version` is the source manifest's; the built manifest must say the same.
 */
export function packageDist({ dist, out, version }) {
  const built = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")).version;
  if (built !== version) throw new Error(`the built manifest.json says version ${built}, the source manifest.json ${version}: build again`);
  const name = archiveName(version);
  const zip = zipStored(listFiles(dist).map((rel) => ({ name: rel, data: readFileSync(join(dist, rel)) })));
  const sha256 = createHash("sha256").update(zip).digest("hex");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, name), zip);
  writeFileSync(join(out, `${name}.sha256`), sha256Line(sha256, name));
  return { name, sha256, size: zip.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { cwd: root, stdio: "inherit" });
    const { version } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    const r = packageDist({ dist: join(root, "dist"), out: join(root, "dist-zip"), version });
    process.stdout.write(`package: dist-zip/${r.name} (${r.size} bytes) sha256 ${r.sha256}\n`);
  } catch (e) {
    process.stderr.write(`package: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
