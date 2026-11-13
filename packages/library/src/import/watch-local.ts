/**
 * Cloud-drive watched folders: "is this file's content on this Mac?" and the rules for file names.
 *
 * The one rule: nothing here ever opens a file. Reading a file that is not downloaded makes the cloud
 * service download it, so the check is made from file metadata only:
 *   - `lstat` (never `stat`, which follows a symbolic link), and
 *   - on macOS, for the few files whose block count looks wrong, the SF_DATALESS flag, read by the
 *     system tool `/usr/bin/stat` (Node cannot read `st_flags`, ADR 0010). The tool is started with an
 *     absolute path, an argument array (no shell) and `--` before the paths, with a time limit and a
 *     bound on its output; its answers are matched to paths by inode, never by names in its output.
 *
 * Every failure answers "unknown" for the paths concerned, which callers treat as not downloaded.
 *
 * A symbolic link yields "unknown": it is never followed, so nothing is known about its target, and the
 * watcher skips links. A folder, a path that vanished, or a name holding a NUL are "unknown" too.
 */
import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import fsp from "node:fs/promises";
import { classifyLocation, type LocationEnv } from "../location.js";
import { ignoredName } from "./watch.js";

/** Where the file's content is: on this machine, not, or it cannot be told (handled as not downloaded). */
export type ContentPresence = "local" | "not-downloaded" | "unknown";

/** `st_flags` bit of a file whose content is online only (macOS). */
export const SF_DATALESS = 0x40000000;
/** Paths per `/usr/bin/stat` call. */
export const WATCH_LOCAL_BATCH = 200;
/**
 * Bytes of arguments per `/usr/bin/stat` call (each path plus its terminating NUL). macOS allows about 1 MiB of
 * arguments and environment together; 128 KiB leaves a wide margin, and 200 paths of 1,024 bytes still fit in two calls.
 */
export const WATCH_LOCAL_ARG_BYTES = 128 * 1024;
/** How long one `/usr/bin/stat` call may take. */
export const WATCH_LOCAL_TOOL_TIMEOUT_MS = 15_000;
/** The most output read from one call (200 lines of about 30 bytes are 6 KB). */
export const WATCH_LOCAL_TOOL_MAX_OUTPUT = 1024 * 1024;

const STAT_TOOL = "/usr/bin/stat";
const STAT_FORMAT = "%i %Xf";

/** The result of running the tool: what it printed, and whether it ended by itself (any exit code) rather than by timeout, signal, output limit or failure to start. */
export interface StatRun {
  stdout: string;
  completed: boolean;
}
/** Starts the tool. The real one is the default of `datalessFlagsDarwin`; tests give recorded outputs. */
export type StatRunner = (args: string[], opts: { timeout: number; maxBuffer: number }, file: string) => Promise<StatRun>;

export interface DatalessOptions {
  run?: StatRunner;
  /** The inode of a path (from `lstat`, as a bigint); throws when it cannot be read. */
  lstatIno?: (path: string) => Promise<bigint>;
  timeoutMs?: number;
}

const realRunner: StatRunner = (args, opts, file) =>
  new Promise<StatRun>((resolve) => {
    // The one place a process is started: absolute path, argument array, no shell. A non-zero exit still has a
    // usable stdout (the tool prints an error for each path it cannot read and goes on with the others).
    execFile(file, args, { timeout: opts.timeout, maxBuffer: opts.maxBuffer, encoding: "utf8", windowsHide: true, env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } }, (err, stdout) => {
      if (!err) return resolve({ stdout: String(stdout), completed: true });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      const exitedByItself = typeof e.code === "number" && !e.killed && !e.signal;
      resolve(exitedByItself ? { stdout: String(stdout), completed: true } : { stdout: "", completed: false });
    });
  });

async function inodeOf(path: string): Promise<bigint> {
  const st = await fsp.lstat(path, { bigint: true });
  if (!st.isFile()) throw new Error("not a regular file");
  return st.ino;
}

/** Runs `fn` over `items` with at most `n` in flight. */
async function mapLimit<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** Groups paths into calls of at most `maxCount` paths and `maxBytes` of arguments. A path that cannot fit alone is returned in `tooLong`. */
function batches(paths: string[], maxCount: number, maxBytes: number): { groups: string[][]; tooLong: string[] } {
  const groups: string[][] = [];
  const tooLong: string[] = [];
  let cur: string[] = [];
  let bytes = 0;
  // The fixed arguments ("-f", the format, "--") count too.
  const fixed = [ "-f", STAT_FORMAT, "--" ].reduce((n, s) => n + Buffer.byteLength(s) + 1, 0);
  for (const p of paths) {
    const b = Buffer.byteLength(p) + 1;
    if (fixed + b > maxBytes) {
      tooLong.push(p);
      continue;
    }
    if (cur.length >= maxCount || fixed + bytes + b > maxBytes) {
      groups.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(p);
    bytes += b;
  }
  if (cur.length > 0) groups.push(cur);
  return { groups, tooLong };
}

/** `"<inode> <flags in hexadecimal>"`, as printed for the format `%i %Xf`; null for any other line. */
function parseLine(line: string): { ino: bigint; flags: number } | null {
  const m = /^(\d{1,20}) (?:0[xX])?([0-9a-fA-F]{1,8})$/.exec(line);
  if (!m) return null;
  return { ino: BigInt(m[1]!), flags: parseInt(m[2]!, 16) };
}

/**
 * Whether each file has the SF_DATALESS flag, from `/usr/bin/stat -f "%i %Xf" -- <paths>` (macOS), in batches of at most
 * `WATCH_LOCAL_BATCH` paths and `WATCH_LOCAL_ARG_BYTES` bytes of arguments. `true`: dataless (online only);
 * `false`: not; `null`: unknown. Answers are matched to paths by inode (read here with `lstat`), never by parsing
 * names out of the tool's output, so a name with a newline or a quote cannot confuse it. `null` for: a path with a
 * NUL, empty or too long; one that is not a regular file or cannot be read; an inode shared by two paths in the
 * batch or printed twice; a path the tool printed nothing usable for (it vanished: the tool reports it on stderr
 * and the other paths are still answered); and every path of a call that timed out, could not start or printed too much.
 * Never opens a file.
 */
export async function datalessFlagsDarwin(paths: string[], opts: DatalessOptions = {}): Promise<Map<string, boolean | null>> {
  const run = opts.run ?? realRunner;
  const inode = opts.lstatIno ?? inodeOf;
  const result = new Map<string, boolean | null>();
  const unique = [...new Set(paths)];
  for (const p of unique) result.set(p, null);

  const askable = unique.filter((p) => p !== "" && !p.includes("\0"));
  const inodes = await mapLimit(askable, 32, async (p) => {
    try {
      return await inode(p);
    } catch {
      return null;
    }
  });
  // An inode shared by two paths (hard links, or two volumes) cannot be told apart in the output: unknown for all of them.
  const owners = new Map<bigint, string[]>();
  askable.forEach((p, i) => {
    const ino = inodes[i];
    if (ino !== null && ino !== undefined) owners.set(ino, [...(owners.get(ino) ?? []), p]);
  });
  const byInode = new Map<bigint, string>();
  for (const [ino, ps] of owners) if (ps.length === 1) byInode.set(ino, ps[0]!);

  const { groups } = batches([...byInode.values()], WATCH_LOCAL_BATCH, WATCH_LOCAL_ARG_BYTES);
  const pathIno = new Map<string, bigint>();
  for (const [ino, p] of byInode) pathIno.set(p, ino);
  const timeout = opts.timeoutMs ?? WATCH_LOCAL_TOOL_TIMEOUT_MS;

  for (const group of groups) {
    let out: StatRun;
    try {
      out = await run(["-f", STAT_FORMAT, "--", ...group], { timeout, maxBuffer: WATCH_LOCAL_TOOL_MAX_OUTPUT }, STAT_TOOL);
    } catch {
      continue; // could not start: unknown for the group
    }
    if (!out.completed) continue;
    const asked = new Set(group.map((p) => pathIno.get(p)!));
    const seen = new Map<bigint, number[]>();
    for (const line of out.stdout.split("\n")) {
      const parsed = parseLine(line);
      if (!parsed || !asked.has(parsed.ino)) continue; // an error line, or an inode we did not ask about
      seen.set(parsed.ino, [...(seen.get(parsed.ino) ?? []), parsed.flags]);
    }
    for (const p of group) {
      const flags = seen.get(pathIno.get(p)!);
      if (flags?.length === 1) result.set(p, (flags[0]! & SF_DATALESS) !== 0);
    }
  }
  return result;
}

export interface PresenceOptions {
  platform?: NodeJS.Platform;
  lstat?: (p: string) => Promise<Pick<Stats, "size" | "blocks" | "ino" | "isFile">>;
  datalessFlags?: (paths: string[]) => Promise<Map<string, boolean | null>>;
  /** Test seams for the default `datalessFlags` (darwin): the process runner and the inode reader. */
  statTool?: StatRunner;
  lstatIno?: (path: string) => Promise<bigint>;
}

/**
 * Whether each file's content is on this machine, without opening any file.
 *  - not a regular file (a link is not followed, a folder), vanished, unreadable, a NUL in the name: "unknown";
 *  - `size === 0`, or `blocks * 512 >= size`: "local", and no process is started;
 *  - otherwise (fewer blocks than the size: online only, sparse or compressed) on macOS the SF_DATALESS flag decides:
 *    set "not-downloaded", clear "local" (an APFS-compressed file), unknown "unknown";
 *  - on Linux `blocks === 0` with `size > 0` is "not-downloaded", anything else "local";
 *  - on Windows "local" (cloud folders are refused there until a native check exists).
 */
export async function contentPresence(paths: string[], opts: PresenceOptions = {}): Promise<Map<string, ContentPresence>> {
  const platform = opts.platform ?? process.platform;
  const lstat = opts.lstat ?? ((p: string) => fsp.lstat(p));
  const out = new Map<string, ContentPresence>();
  const unique = [...new Set(paths)];
  const suspects: string[] = [];

  const stats = await mapLimit(unique, 32, async (p) => {
    if (p === "" || p.includes("\0")) return null;
    try {
      return await lstat(p);
    } catch {
      return null;
    }
  });
  unique.forEach((p, i) => {
    const st = stats[i];
    if (!st || !st.isFile()) return void out.set(p, "unknown");
    if (st.size === 0 || platform === "win32") return void out.set(p, "local");
    if (st.blocks * 512 >= st.size) return void out.set(p, "local");
    if (platform === "darwin") {
      suspects.push(p);
      return;
    }
    out.set(p, st.blocks === 0 ? "not-downloaded" : "local");
  });

  if (suspects.length > 0) {
    let flags: Map<string, boolean | null> | null = null;
    try {
      flags = await (opts.datalessFlags ?? ((ps) => datalessFlagsDarwin(ps, { run: opts.statTool, lstatIno: opts.lstatIno })))(suspects);
    } catch {
      flags = null;
    }
    for (const p of suspects) {
      const f = flags?.get(p);
      out.set(p, f === true ? "not-downloaded" : f === false ? "local" : "unknown");
    }
  }
  return out;
}

// ---- file names ----------------------------------------------------------------------------------------------

/** Google's pointer files: they hold a link to an online document, not its content. */
export const POINTER_EXTENSIONS: readonly string[] = [".gdoc", ".gsheet", ".gslides", ".gdraw", ".gform", ".gmap", ".gsite", ".gjam", ".gtable"];
export const POINTER_REASON = "This is a Google Docs, Sheets or Slides file. It lives only online, so there is nothing here to bring in.";

export type NameRule = { skip: "silent" } | { skip: "report"; kind: "online-only-document"; reason: string } | null;

const SAFE_SAVE = /\.sb-[0-9a-f]{8}-[A-Za-z0-9]{6}$/;

/**
 * What to do with a file name (the name alone, not a path): skipped in silence (everything `ignoredName` skips, `Icon\r`,
 * `.partial`, macOS safe-save names), skipped and reported (Google pointer files, in any letter case), or an ordinary
 * file (null). A name is never interpreted further: "Report (1).pdf" and conflict copies are ordinary files.
 */
export function nameRule(name: string): NameRule {
  if (ignoredName(name) || name === "Icon\r" || name.toLowerCase().endsWith(".partial") || SAFE_SAVE.test(name)) return { skip: "silent" };
  const lower = name.toLowerCase();
  if (POINTER_EXTENSIONS.some((ext) => lower.endsWith(ext))) return { skip: "report", kind: "online-only-document", reason: POINTER_REASON };
  return null;
}

// ---- which cloud service ------------------------------------------------------------------------------------

export type CloudProvider = "google-drive" | "onedrive" | "dropbox" | "icloud-drive" | "other-cloud";

export const PROVIDER_NAMES: Record<CloudProvider, string> = {
  "google-drive": "Google Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
  "icloud-drive": "iCloud Drive",
  "other-cloud": "the cloud drive",
};

/** The cloud service a (real) folder path belongs to, as `classifyLocation` sees it, or null for a plain folder. */
export function cloudProviderOf(realPath: string, env: LocationEnv): CloudProvider | null {
  const loc = classifyLocation(realPath, env);
  if (loc.kind !== "cloud_folder") return null;
  const id = loc.cloudFolderId ?? "";
  if (id === "googledrive" || id.startsWith("googledrive:")) return "google-drive";
  if (id === "onedrive" || id.startsWith("onedrive:")) return "onedrive";
  if (id === "dropbox") return "dropbox";
  if (id === "icloud") return "icloud-drive";
  return "other-cloud";
}

/** The register key of a relative name: NFC, because cloud services often create NFD names and macOS compares them without regard to normalisation. */
export function fileKey(rel: string): string {
  return rel.normalize("NFC");
}
