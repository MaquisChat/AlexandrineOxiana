/**
 * The disk a library is on (whole channels, Task 4): its free space, for the estimate and the 10 GB
 * floor of a download run, and its name, for the estimate's sentence ("380 GB are free on …").
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { statfsFree } from "../import/sqlite-copy.js";

/** The bytes free for this folder's disk; null when they cannot be read. */
export async function freeBytes(dir: string): Promise<number | null> {
  const free = await statfsFree(dir);
  return Number.isFinite(free) ? free : null;
}

/** How long diskutil may take before the name is left out. */
const DISKUTIL_TIMEOUT_MS = 2000;
const DISKUTIL = "/usr/sbin/diskutil";

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, e: string) =>
    e.startsWith("#x") || e.startsWith("#X") ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : (XML_ENTITIES[e.toLowerCase()] ?? ""),
  );

/**
 * The name of the disk this folder is on: from `/Volumes/<name>/…`, else (on macOS) diskutil's
 * `VolumeName` (2 s at most), else null.
 */
export async function diskName(dir: string, deps: { platform?: NodeJS.Platform; execFile?: typeof execFile } = {}): Promise<string | null> {
  const platform = deps.platform ?? process.platform;
  const path = platform === "win32" ? dir : resolve(dir);
  const volume = /^\/Volumes\/([^/]+)/.exec(path)?.[1];
  if (volume) return volume;
  if (platform !== "darwin") return null;
  const run = deps.execFile ?? execFile;
  const out = await new Promise<string | null>((done) => {
    try {
      run(DISKUTIL, ["info", "-plist", path], { timeout: DISKUTIL_TIMEOUT_MS, encoding: "utf8" }, (err, stdout) => done(err ? null : String(stdout)));
    } catch {
      done(null);
    }
  });
  if (out === null) return null;
  const m = /<key>VolumeName<\/key>\s*<string>([^<]*)<\/string>/.exec(out);
  const name = m ? unescapeXml(m[1]!).trim() : "";
  return name || null;
}
