/**
 * Classifies a folder as a residency kind (governance `residency.allowed`)
 * from its path alone. The environment (home folder, platform, mounts) is
 * injected, so the rules are pure and can be tested for any platform;
 * `defaultLocationEnv` probes this machine, best effort.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ResidencyKind } from "@ao/core";

export interface MountInfo {
  path: string;
  removable: boolean;
  network: boolean;
}

export interface LocationEnv {
  homeDir: string;
  platform: NodeJS.Platform;
  mounts: MountInfo[];
  /** False when the mount list could not be probed; classifications that depend on it are then uncertain. Default true. */
  mountsKnown?: boolean;
  /** Environment variables that name sync folders: `OneDrive`, `OneDriveCommercial`, `OneDriveConsumer`. */
  vars?: Partial<Record<"OneDrive" | "OneDriveCommercial" | "OneDriveConsumer", string>>;
}

export interface Location {
  kind: ResidencyKind;
  cloudFolderId?: string;
  /**
   * False when the kind is a guess: the mount list is unknown, or the path is not under any
   * known mount. Callers must then treat the destination as possibly device, removable or network.
   */
  certain: boolean;
}

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);
/** macOS and Windows file systems compare names case-insensitively by default. */
const foldsCase = (platform: NodeJS.Platform) => platform === "win32" || platform === "darwin";

/**
 * The path of `child` below `parent` as segments, or null when it is not
 * inside (or equal to) it. Compares whole segments, case-insensitively on
 * macOS and Windows; the returned segments keep their original case.
 */
function below(child: string, parent: string, env: LocationEnv): string[] | null {
  const P = pathFor(env.platform);
  const c = P.normalize(child);
  const p = P.normalize(parent);
  const fold = (s: string) => (foldsCase(env.platform) ? s.toLowerCase() : s);
  const rel = P.relative(fold(p), fold(c));
  if (rel === "") return [];
  if (rel.startsWith("..") || P.isAbsolute(rel)) return null;
  // `relative` on folded strings gives folded segments; take the originals from `c` instead.
  const n = rel.split(P.sep).length;
  const parts = c.split(P.sep).filter((s) => s !== "");
  return parts.slice(parts.length - n);
}

/** `OneDrive`, `OneDrive - Contoso`, `OneDrive-Personal` → `onedrive:<suffix>` (a plain `OneDrive` is `Personal`). */
function oneDriveId(folder: string): string | null {
  const m = /^onedrive(.*)$/i.exec(folder);
  if (!m) return null;
  const suffix = m[1]!.replace(/^[\s-]+/, "").trim();
  if (m[1] !== "" && suffix === m[1]) return null; // e.g. "OneDriveOld": not a OneDrive folder
  return `onedrive:${suffix || "Personal"}`;
}

function cloudFolder(p: string, env: LocationEnv): string | null {
  const P = pathFor(env.platform);
  const home = env.homeDir;
  if (env.platform === "darwin") {
    if (below(p, P.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"), env)) return "icloud";
    const cs = below(p, P.join(home, "Library", "CloudStorage"), env);
    const top = cs?.[0];
    if (top !== undefined) {
      const od = oneDriveId(top);
      if (od && /^onedrive-/i.test(top)) return od;
      if (/^dropbox/i.test(top)) return "dropbox";
      const gd = /^googledrive-(.+)$/i.exec(top);
      if (gd) return `googledrive:${gd[1]}`;
      // Every File Provider sync folder lives here (Box, pCloud, ...): a cloud folder in any case.
      return top.toLowerCase();
    }
  }
  if (below(p, P.join(home, "Dropbox"), env)) return "dropbox";
  for (const [name, dir] of Object.entries(env.vars ?? {})) {
    if (!dir || !below(p, dir, env)) continue;
    const base = pathFor(env.platform).basename(pathFor(env.platform).normalize(dir));
    return oneDriveId(base) ?? `onedrive:${name === "OneDriveCommercial" ? "Business" : "Personal"}`;
  }
  if (env.platform === "win32") {
    const inHome = below(p, home, env);
    const top = inHome?.[0];
    if (top !== undefined) {
      const od = oneDriveId(top);
      if (od) return od;
    }
    // Google Drive for desktop mounts a virtual drive (G: by default); the account is not in the path.
    if (/^[a-z]:\\my drive(\\|$)/i.test(P.normalize(p))) return "googledrive";
  }
  return null;
}

/**
 * Cloud-synced folders first (stricter than whatever disk they sit on), then
 * the longest mount containing the path (removable / network), else device.
 */
export function classifyLocation(p: string, env: LocationEnv): Location {
  const cloud = cloudFolder(p, env);
  if (cloud) return { kind: "cloud_folder", cloudFolderId: cloud, certain: true };
  const P = pathFor(env.platform);
  // Windows UNC paths (\\server\share) are network shares whatever the mount list says.
  if (env.platform === "win32" && /^[\\/]{2}[^\\/?.]/.test(p)) return { kind: "network", certain: true };
  let best: { depth: number; m: MountInfo } | null = null;
  for (const m of env.mounts) {
    const rel = below(p, m.path, env);
    if (rel === null) continue;
    const depth = P.normalize(m.path).length;
    if (!best || depth > best.depth) best = { depth, m };
  }
  if (best?.m.network) return { kind: "network", certain: true };
  if (best?.m.removable) return { kind: "removable", certain: true };
  // Where Linux desktops mount external drives.
  if (env.platform === "linux") {
    for (const base of ["/media", "/run/media"]) if ((below(p, base, env)?.length ?? 0) > 0) return { kind: "removable", certain: true };
    if ((below(p, "/mnt", env)?.length ?? 0) > 0) return { kind: "removable", certain: true };
  }
  return { kind: "device", certain: env.mountsKnown !== false && best !== null };
}

const NETWORK_FS = new Set(["nfs", "nfs4", "cifs", "smbfs", "smb3", "afpfs", "webdav", "davfs", "fuse.sshfs", "sshfs", "9p", "ncpfs"]);
const VIRTUAL_FS = new Set(["proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "cgroup", "cgroup2", "securityfs", "debugfs", "tracefs", "pstore", "bpf", "mqueue", "hugetlbfs", "configfs", "fusectl", "autofs", "binfmt_misc", "overlay", "nsfs", "rpc_pipefs", "devfs", "squashfs"]);

/** `/proc/mounts`; `isRemovableDevice` answers for a device such as `/dev/sdb1`. Octal escapes (`\040`) are decoded. */
export function parseProcMounts(text: string, isRemovableDevice: (device: string) => boolean): MountInfo[] {
  const out: MountInfo[] = [];
  for (const line of text.split("\n")) {
    const [dev, mnt, fstype] = line.trim().split(/\s+/);
    if (!dev || !mnt || !fstype || VIRTUAL_FS.has(fstype)) continue;
    const p = mnt.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
    const network = NETWORK_FS.has(fstype) || dev.startsWith("//");
    out.push({ path: p, removable: !network && isRemovableDevice(dev), network });
  }
  return out;
}

/** macOS `mount` output: `<dev> on <path> (<fstype>, <flags...>)`. Removable: a local volume under /Volumes. */
export function parseMacMount(text: string): MountInfo[] {
  const out: MountInfo[] = [];
  for (const line of text.split("\n")) {
    const m = /^(.+?) on (.+) \(([^,)]+)(?:, ([^)]*))?\)\s*$/.exec(line.trim());
    if (!m) continue;
    const [, dev, mnt, fstype, flags = ""] = m as unknown as [string, string, string, string, string?];
    if (fstype === "devfs" || fstype === "autofs") continue;
    const network = NETWORK_FS.has(fstype) || dev.startsWith("//");
    const local = flags.split(",").map((s) => s.trim()).includes("local");
    out.push({ path: mnt, removable: !network && local && mnt.startsWith("/Volumes/"), network });
  }
  return out;
}

/** `wmic logicaldisk get DeviceID,DriveType` (or the same columns from PowerShell): 2 removable, 4 network. */
export function parseWindowsDrives(text: string): MountInfo[] {
  const out: MountInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]:)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const type = Number(m[2]);
    out.push({ path: `${m[1]!.toUpperCase()}\\`, removable: type === 2, network: type === 4 });
  }
  return out;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

async function linuxRemovable(dev: string): Promise<boolean> {
  const m = /^\/dev\/(nvme\d+n\d+|mmcblk\d+|[a-z]+)/.exec(dev);
  if (!m) return false;
  try {
    return (await readFile(`/sys/block/${m[1]}/removable`, "utf8")).trim() === "1";
  } catch {
    return false;
  }
}

/** The mount list, or null when it could not be probed. */
async function probeMounts(platform: NodeJS.Platform): Promise<MountInfo[] | null> {
  try {
    if (platform === "win32") {
      try {
        return parseWindowsDrives(await run("wmic", ["logicaldisk", "get", "DeviceID,DriveType"]));
      } catch {
        const ps = "Get-CimInstance Win32_LogicalDisk | ForEach-Object { \"$($_.DeviceID) $($_.DriveType)\" }";
        return parseWindowsDrives(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]));
      }
    }
    if (platform === "darwin") return parseMacMount(await run("mount", []));
    const text = await readFile("/proc/mounts", "utf8").catch(() => run("mount", []));
    const devs = [...new Set(text.split("\n").map((l) => l.trim().split(/\s+/)[0] ?? ""))];
    const removable = new Set<string>();
    for (const d of devs) if (await linuxRemovable(d)) removable.add(d);
    return parseProcMounts(text, (d) => removable.has(d));
  } catch {
    return null;
  }
}

/** This machine's environment; mount probing is best effort (a failure gives no mounts and `mountsKnown: false`). */
export async function defaultLocationEnv(): Promise<LocationEnv> {
  const mounts = await probeMounts(process.platform);
  const vars: LocationEnv["vars"] = {};
  for (const k of ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"] as const) if (process.env[k]) vars[k] = process.env[k];
  return { homeDir: homedir(), platform: process.platform, mounts: mounts ?? [], mountsKnown: mounts !== null && mounts.length > 0, vars };
}
