/**
 * Cloud-drive watched folders: "is this file's content on this Mac?" and the rules for file names.
 *
 * The one rule: nothing here ever opens a file. Reading a file that is not downloaded makes the cloud
 * service download it, so the check is made from file metadata only:
 *   - `lstat` (never `stat`, which follows a symbolic link), at most `WATCH_LOCAL_LSTAT_CONCURRENCY` at a
 *     time and one per path, and
 *   - on macOS, the file's flags (SF_DATALESS, UF_COMPRESSED), read by the system tool `/usr/bin/stat`
 *     (Node cannot read `st_flags`, ADR 0010). The tool is started with an absolute path, an argument array
 *     (no shell) and `--` before the paths, with a time limit and a bound on its output; its answers are
 *     matched to paths by inode, never by names in its output.
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
/** `st_flags` bit of a file stored compressed by APFS (its blocks are fewer than its size, and it is local). */
export const UF_COMPRESSED = 0x20;
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
/**
 * `lstat` calls in flight at once. A call into a stalled cloud folder can block in the kernel and holds one of
 * Node's few file-system threads while it does; two keeps the rest of the service answering.
 */
export const WATCH_LOCAL_LSTAT_CONCURRENCY = 2;

const STAT_TOOL = "/usr/bin/stat";
const STAT_FORMAT = "%i %Xf";

/** The result of running the tool: what it printed, and whether it ended by itself (any exit code) rather than by timeout, signal, abort, output limit or failure to start. */
export interface StatRun {
  stdout: string;
  completed: boolean;
}
/** Starts the tool; the signal, when given, kills it. The real one is the default; tests give recorded outputs. */
export type StatRunner = (args: string[], opts: { timeout: number; maxBuffer: number; signal?: AbortSignal }, file: string) => Promise<StatRun>;

export interface DatalessOptions {
  run?: StatRunner;
  /** The inode of a path (from `lstat`, as a bigint); throws when it cannot be read. */
  lstatIno?: (path: string) => Promise<bigint>;
  timeoutMs?: number;
  /** Once aborted: no further `lstat`, no further process, a running process is killed, and the rest are unknown. */
  signal?: AbortSignal;
}

const realRunner: StatRunner = (args, opts, file) =>
  new Promise<StatRun>((resolve) => {
    // The one place a process is started: absolute path, argument array, no shell. A non-zero exit still has a
    // usable stdout (the tool prints an error for each path it cannot read and goes on with the others).
    execFile(
      file,
      args,
      { timeout: opts.timeout, maxBuffer: opts.maxBuffer, encoding: "utf8", windowsHide: true, signal: opts.signal, env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } },
      (err, stdout) => {
        if (!err) return resolve({ stdout: String(stdout), completed: true });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        const exitedByItself = typeof e.code === "number" && !e.killed && !e.signal;
        resolve(exitedByItself ? { stdout: String(stdout), completed: true } : { stdout: "", completed: false });
      },
    );
  });

/** Runs `fn` over `items` with at most `n` in flight. Stops starting items once `signal` is aborted, and stops waiting for a call that never answers (its result stays `undefined`). */
async function mapLimit<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<Array<R | undefined>> {
  const out: Array<R | undefined> = new Array(items.length).fill(undefined);
  let aborted: Promise<undefined> | null = null;
  if (signal) {
    aborted = new Promise<undefined>((resolve) => {
      if (signal.aborted) resolve(undefined);
      else signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
  }
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      const i = next++;
      out[i] = aborted ? await Promise.race([fn(items[i]!), aborted]) : await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** Groups paths into calls of at most `maxCount` paths and `maxBytes` of arguments. A path that cannot fit alone is returned in `tooLong`. */
function batches<T extends { path: string }>(items: T[], maxCount: number, maxBytes: number): { groups: T[][]; tooLong: T[] } {
  const groups: T[][] = [];
  const tooLong: T[] = [];
  let cur: T[] = [];
  let bytes = 0;
  // The fixed arguments ("-f", the format, "--") count too.
  const fixed = ["-f", STAT_FORMAT, "--"].reduce((n, s) => n + Buffer.byteLength(s) + 1, 0);
  for (const it of items) {
    const b = Buffer.byteLength(it.path) + 1;
    if (fixed + b > maxBytes) {
      tooLong.push(it);
      continue;
    }
    if (cur.length >= maxCount || fixed + bytes + b > maxBytes) {
      groups.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
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
 * The `st_flags` of each file, from `/usr/bin/stat -f "%i %Xf" -- <paths>`, for files whose inode is already known
 * (one process per `WATCH_LOCAL_BATCH` paths and `WATCH_LOCAL_ARG_BYTES` bytes of arguments). `null`: unknown, for a path
 * with a NUL, empty or too long; an inode shared by two paths of the call or printed twice; a path the tool printed
 * nothing usable for (it vanished: the tool reports it on stderr and the other paths are still answered); and every
 * path of a call that timed out, was aborted, could not start or printed too much.
 */
async function flagsByInode(items: Array<{ path: string; ino: bigint }>, run: StatRunner, timeoutMs: number, signal?: AbortSignal): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  for (const it of items) result.set(it.path, null);

  const askable = items.filter((it) => it.path !== "" && !it.path.includes("\0"));
  // An inode shared by two paths (hard links, or two volumes) cannot be told apart in the output: unknown for all of them.
  const owners = new Map<bigint, Array<{ path: string; ino: bigint }>>();
  for (const it of askable) owners.set(it.ino, [...(owners.get(it.ino) ?? []), it]);
  const unique = [...owners.values()].filter((v) => v.length === 1).map((v) => v[0]!);

  const { groups } = batches(unique, WATCH_LOCAL_BATCH, WATCH_LOCAL_ARG_BYTES);
  for (const group of groups) {
    if (signal?.aborted) break;
    let out: StatRun;
    try {
      out = await run(["-f", STAT_FORMAT, "--", ...group.map((g) => g.path)], { timeout: timeoutMs, maxBuffer: WATCH_LOCAL_TOOL_MAX_OUTPUT, signal }, STAT_TOOL);
    } catch {
      continue; // could not start: unknown for the group
    }
    if (!out.completed || signal?.aborted) continue;
    const asked = new Set(group.map((g) => g.ino));
    const seen = new Map<bigint, number[]>();
    for (const line of out.stdout.split("\n")) {
      const parsed = parseLine(line);
      if (!parsed || !asked.has(parsed.ino)) continue; // an error line, or an inode we did not ask about
      seen.set(parsed.ino, [...(seen.get(parsed.ino) ?? []), parsed.flags]);
    }
    for (const g of group) {
      const flags = seen.get(g.ino);
      if (flags?.length === 1) result.set(g.path, flags[0]!);
    }
  }
  return result;
}

async function inodeOf(path: string): Promise<bigint> {
  const st = await fsp.lstat(path, { bigint: true });
  if (!st.isFile()) throw new Error("not a regular file");
  return st.ino;
}

/**
 * Whether each file has the SF_DATALESS flag (macOS, stand-alone use: one `lstat` per path to get the inode, then
 * `flagsByInode`). `true`: dataless (online only); `false`: not; `null`: unknown (for every reason `flagsByInode` lists,
 * and for a path that is not a regular file or cannot be read). Never opens a file.
 */
export async function datalessFlagsDarwin(paths: string[], opts: DatalessOptions = {}): Promise<Map<string, boolean | null>> {
  const inode = opts.lstatIno ?? inodeOf;
  const unique = [...new Set(paths)];
  const result = new Map<string, boolean | null>();
  for (const p of unique) result.set(p, null);
  const askable = unique.filter((p) => p !== "" && !p.includes("\0"));
  const inodes = await mapLimit(
    askable,
    WATCH_LOCAL_LSTAT_CONCURRENCY,
    async (p) => {
      try {
        return await inode(p);
      } catch {
        return null;
      }
    },
    opts.signal,
  );
  const items: Array<{ path: string; ino: bigint }> = [];
  askable.forEach((p, i) => {
    const ino = inodes[i];
    if (ino !== null && ino !== undefined) items.push({ path: p, ino });
  });
  const flags = await flagsByInode(items, opts.run ?? realRunner, opts.timeoutMs ?? WATCH_LOCAL_TOOL_TIMEOUT_MS, opts.signal);
  for (const [p, f] of flags) result.set(p, f === null ? null : (f & SF_DATALESS) !== 0);
  return result;
}

export interface PresenceOptions {
  platform?: NodeJS.Platform;
  lstat?: (p: string) => Promise<{ size: number; blocks: number; ino: number | bigint; mtimeMs?: number; isFile: Stats["isFile"] }>;
  /** Replaces the tool: whether each file has SF_DATALESS (a compression flag is then taken as clear). */
  datalessFlags?: (paths: string[]) => Promise<Map<string, boolean | null>>;
  /** Test seam for the default tool call (darwin): the process runner. */
  statTool?: StatRunner;
  /** Once aborted: no further `lstat`, no further process (a running one is killed), and every path not yet answered is "unknown". */
  signal?: AbortSignal;
}

/** What `contentState` judged for one path: the answer and the file's state at that moment. */
export type ContentState = { presence: ContentPresence; ino: bigint; size: number; blocks: number; mtimeMs: number } | { presence: "unknown" };

/**
 * Whether each file's content is on this machine, and the state it was judged in, without opening any file.
 *  - not a regular file (a link is not followed, a folder), vanished, unreadable, aborted, a NUL in the name: "unknown";
 *  - macOS: EVERY regular file (size 0 included) is asked through the tool; "local" rests only on its flags, never on
 *    the size or block count alone (the block count includes other parts of a file and is made up from the size where a
 *    file system keeps none): SF_DATALESS set is "not-downloaded"; clear and `blocks*512 >= size` is "local"; clear, fewer
 *    blocks than the size and UF_COMPRESSED set is "local"; clear, fewer blocks, not compressed is "unknown" (a
 *    placeholder made another way cannot be told from a sparse file); no answer for the inode is "unknown";
 *  - Linux: `blocks === 0` with `size > 0` is "not-downloaded", anything else "local". Windows: "local". On Linux and on
 *    Windows "local" means "not checked": no cloud check exists there (a FUSE cloud mount reports made-up blocks).
 * The caller compares the returned `ino`, `size`, `blocks` and `mtimeMs` with its own `lstat` just before it opens a file.
 */
export async function contentState(paths: string[], opts: PresenceOptions = {}): Promise<Map<string, ContentState>> {
  const platform = opts.platform ?? process.platform;
  const lstat =
    opts.lstat ??
    (async (p: string) => {
      const s = await fsp.lstat(p, { bigint: true });
      return { size: Number(s.size), blocks: Number(s.blocks), ino: s.ino, mtimeMs: Number(s.mtimeMs), isFile: () => s.isFile() };
    });
  const out = new Map<string, ContentState>();
  const unique = [...new Set(paths)];
  for (const p of unique) out.set(p, { presence: "unknown" });

  const stats = await mapLimit(
    unique,
    WATCH_LOCAL_LSTAT_CONCURRENCY,
    async (p) => {
      if (p === "" || p.includes("\0")) return null;
      try {
        return await lstat(p);
      } catch {
        return null;
      }
    },
    opts.signal,
  );

  const regular: Array<{ path: string; ino: bigint; size: number; blocks: number; mtimeMs: number }> = [];
  unique.forEach((p, i) => {
    const st = stats[i];
    if (!st || !st.isFile()) return;
    const f = { path: p, ino: BigInt(st.ino), size: st.size, blocks: st.blocks, mtimeMs: st.mtimeMs ?? 0 };
    const set = (presence: ContentPresence) => out.set(p, presence === "unknown" ? { presence } : { presence, ino: f.ino, size: f.size, blocks: f.blocks, mtimeMs: f.mtimeMs });
    if (platform === "win32") return set("local");
    if (platform !== "darwin") return set(f.size > 0 && f.blocks === 0 ? "not-downloaded" : "local");
    regular.push(f);
  });
  if (regular.length === 0 || opts.signal?.aborted) return out;

  let flags: Map<string, number | null> | null = null;
  try {
    if (opts.datalessFlags) {
      const d = await opts.datalessFlags(regular.map((r) => r.path));
      flags = new Map([...d].map(([p, v]) => [p, v === null ? null : v ? SF_DATALESS : 0]));
    } else {
      flags = await flagsByInode(regular, opts.statTool ?? realRunner, WATCH_LOCAL_TOOL_TIMEOUT_MS, opts.signal);
    }
  } catch {
    flags = null;
  }
  for (const f of regular) {
    const fl = flags?.get(f.path);
    let presence: ContentPresence;
    if (fl === null || fl === undefined) presence = "unknown";
    else if ((fl & SF_DATALESS) !== 0) presence = "not-downloaded";
    else if (f.blocks * 512 >= f.size) presence = "local";
    else if ((fl & UF_COMPRESSED) !== 0) presence = "local";
    else presence = "unknown";
    out.set(f.path, presence === "unknown" ? { presence } : { presence, ino: f.ino, size: f.size, blocks: f.blocks, mtimeMs: f.mtimeMs });
  }
  return out;
}

/** `contentState` reduced to the presence. */
export async function contentPresence(paths: string[], opts: PresenceOptions = {}): Promise<Map<string, ContentPresence>> {
  const states = await contentState(paths, opts);
  return new Map([...states].map(([p, s]) => [p, s.presence]));
}

// ---- file names ----------------------------------------------------------------------------------------------

/** Google's pointer files: they hold a link to an online document, not its content. */
export const POINTER_EXTENSIONS: readonly string[] = [".gdoc", ".gsheet", ".gslides", ".gdraw", ".gform", ".gmap", ".gsite", ".gjam", ".gtable"];
export const POINTER_REASON = "This is a Google Docs, Sheets or Slides file. It lives only online, so there is nothing here to bring in.";

export type NameRule = { skip: "silent" } | { skip: "report"; kind: "online-only-document"; reason: string } | null;

const SAFE_SAVE = /\.sb-[0-9a-f]{8}-[A-Za-z0-9]{6}$/;

/**
 * What to do with a file name (the name alone, not a path): skipped in silence (everything `ignoredName` skips, `Icon\r`,
 * `.partial`, macOS safe-save names), skipped and reported (Google pointer files, in any letter case, with trailing spaces
 * and dots ignored), or an ordinary file (null). A name is never interpreted further: "Report (1).pdf" and conflict copies
 * are ordinary files.
 */
export function nameRule(name: string): NameRule {
  if (ignoredName(name) || name === "Icon\r" || name.toLowerCase().endsWith(".partial") || SAFE_SAVE.test(name)) return { skip: "silent" };
  const lower = name.toLowerCase().replace(/[ .]+$/, "");
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
