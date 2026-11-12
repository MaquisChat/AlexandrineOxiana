/**
 * Device-level settings shared by the CLI and the local library service (Task 30): where the app's
 * settings folder is, this device's `Deps`, small JSON settings files in that folder (appearance,
 * paired browser extensions …: per user and device, never in the library), and the scrubbing of
 * absolute paths out of messages shown to people or returned by the service.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { newId } from "@ao/core";
import type { Deps } from "./deps.js";
import { raiseDeviceNotice } from "./device-notices.js";
import { writeFileAtomic } from "./fs/atomic.js";

/** The app's settings folder: AO_CONFIG_DIR, else the platform's usual place. */
export function appConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AO_CONFIG_DIR) return resolve(env.AO_CONFIG_DIR);
  if (process.platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "AlexandrineOxiana");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "AlexandrineOxiana");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "alexandrine-oxiana");
}

/** The settings folder holds device ids, approved folders, audit anchors and tokens: private (0700). */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // not ours to change (a shared folder given in AO_CONFIG_DIR): left as it is
    }
  }
}

/**
 * This computer's identity could not be read (Task 68, ruling 2): the file is there but cannot be
 * opened or read (no permission, a folder in its place, a passing I/O error). Nothing was written:
 * the identity is never replaced over a file that merely could not be read, since it says which
 * device holds a library's lock. The message carries no path.
 */
export class DeviceIdUnreadableError extends Error {
  constructor() {
    super("This computer's identity for the app (its device file in the app's settings folder) could not be read, so it was not replaced. Check that the app's settings folder can be read, then start the app again.");
    this.name = "DeviceIdUnreadableError";
  }
}

/** `<base>.corrupt-<YYYYMMDD-HHMMSS>` beside it, with `-n` when that name is taken (nothing kept before is overwritten). */
function corruptNameFor(dir: string, base: string, now: Date): string {
  const stamp = now.toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
  for (let n = 0; ; n++) {
    const name = n === 0 ? `${base}.corrupt-${stamp}` : `${base}.corrupt-${stamp}-${n}`;
    try {
      lstatSync(join(dir, name));
    } catch {
      return name;
    }
  }
}

/**
 * This device's id (Task 68, ruling 2): missing (a fresh settings folder) makes a new one; a file
 * that cannot be read refuses (DeviceIdUnreadableError) and writes nothing; damaged content (not
 * JSON, truncated, the wrong shape) is kept aside as `device.json.corrupt-<stamp>` and a new id is
 * made. Returns whether the identity was renewed over a damaged file.
 */
function deviceIdIn(dir: string, now: () => Date): { id: string; renewed: boolean } {
  const file = join(dir, "device.json");
  let raw: string | undefined;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new DeviceIdUnreadableError();
  }
  let renewed = false;
  if (raw !== undefined) {
    try {
      const v = JSON.parse(raw) as { deviceId?: unknown } | null;
      if (typeof v?.deviceId === "string" && v.deviceId) return { id: v.deviceId, renewed: false };
    } catch {
      // damaged: kept aside below
    }
    // Damaged content: kept aside, never overwritten; if it cannot be set aside, nothing is replaced.
    try {
      renameSync(file, join(dir, corruptNameFor(dir, "device.json", now())));
    } catch {
      throw new DeviceIdUnreadableError();
    }
    renewed = true;
  }
  let id: string;
  try {
    id = newId();
  } catch {
    id = randomUUID();
  }
  try {
    ensurePrivateDir(dir);
    writeFileSync(file, JSON.stringify({ deviceId: id }), { mode: 0o600 });
  } catch {
    // an unwritable config folder: the id is just not remembered
  }
  return { id, renewed };
}

/**
 * This device's Deps (clock, device id, lock liveness) with `dir` as the app settings folder.
 * Throws DeviceIdUnreadableError when this device's identity file is there but cannot be read
 * (Task 68, ruling 2). `deviceRenewed` is true when a damaged identity file was kept aside and a new
 * identity made.
 */
export function deviceDeps(dir: string = appConfigDir(), opts: { now?: () => Date } = {}): Deps & { deviceRenewed?: true } {
  ensurePrivateDir(dir);
  const now = opts.now ?? (() => new Date());
  const device = deviceIdIn(dir, now);
  // Never silent (R154, R178): the researcher is told, through a device-level notice; raising it
  // never throws and never holds up the start (deviceNoticesIdle waits for it where that matters).
  if (device.renewed) void raiseDeviceNotice(dir, "device-identity-renewed", now());
  return {
    clock: () => new Date(),
    deviceId: device.id,
    ...(device.renewed ? { deviceRenewed: true as const } : {}),
    hostname: hostname(),
    pid: process.pid,
    isPidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    appConfigDir: dir,
  };
}

const SETTING_NAME = /^[a-z][a-z0-9-]{0,63}\.json$/;
const settingLocks = new Map<string, Promise<unknown>>();

/** A settings file of the app settings folder, parsed; undefined when missing or unreadable. */
export async function readAppSetting<T = unknown>(dir: string, name: string): Promise<T | undefined> {
  if (!SETTING_NAME.test(name)) throw new TypeError(`not a settings file name: ${name}`);
  try {
    return JSON.parse(await fsp.readFile(join(dir, name), "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Writes a settings file whose whole content is `value` (owner-only, 0600, atomically), in its
 * per-file turn. Nothing is read, so nothing read can be lost: for files that hold one thing (the
 * researcher's name, the remembered port). A file that keeps several things changes only through
 * updateAppSettingStrict (Task 68, D16: there was a lenient read-modify-write here, which wrote a
 * default over a file it could not read).
 */
export function writeAppSetting<T>(dir: string, name: string, value: T): Promise<T> {
  if (!SETTING_NAME.test(name)) throw new TypeError(`not a settings file name: ${name}`);
  return inSettingTurn(dir, name, async () => {
    ensurePrivateDir(dir);
    await writeFileAtomic(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return value;
  });
}

/** Runs `step` in the file's turn: every write of one settings file, one at a time in this process. */
function inSettingTurn<T>(dir: string, name: string, step: () => Promise<T>): Promise<T> {
  const key = join(dir, name);
  const run = (settingLocks.get(key) ?? Promise.resolve()).then(step);
  settingLocks.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * A settings file that is there but cannot be read as itself (unreadable, not JSON, truncated,
 * empty, the wrong shape, a folder or a broken link in its place). Nothing was written (Task 68,
 * D16). Its message never carries a path; `fileName` names the file within the settings folder.
 */
export class AppSettingUnreadableError extends Error {
  constructor(readonly fileName: string) {
    super(`The settings file "${fileName}" could not be read, so it was not changed.`);
    this.name = "AppSettingUnreadableError";
  }
}

/** A reset was asked for a settings file that can be read (or is not there): nothing was set aside. */
export class AppSettingReadableError extends Error {
  /** `missing`: the file is not there at all (review round 1, M7), rather than readable. */
  constructor(
    readonly fileName: string,
    readonly missing = false,
  ) {
    super(missing ? `The settings file "${fileName}" is not there, so there is nothing to reset.` : `The settings file "${fileName}" can be read, so it was not reset.`);
    this.name = "AppSettingReadableError";
  }
}

/**
 * Reads a settings file strictly (Task 68, D16): undefined only when it is missing (a fresh settings
 * folder: "nothing yet", the one legitimate empty start); its value when it parses and passes
 * `check`; anything else throws AppSettingUnreadableError.
 */
export async function readAppSettingStrict<T>(dir: string, name: string, check: (v: unknown) => v is T): Promise<T | undefined> {
  if (!SETTING_NAME.test(name)) throw new TypeError(`not a settings file name: ${name}`);
  let raw: string;
  try {
    raw = await fsp.readFile(join(dir, name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new AppSettingUnreadableError(name);
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new AppSettingUnreadableError(name);
  }
  if (!check(v)) throw new AppSettingUnreadableError(name);
  return v;
}

/**
 * The read-modify-write every settings file that keeps more than one thing goes through (Task 68,
 * D16): the file is read strictly in its per-file turn; `edit` gets what was read (undefined only
 * when the file is missing) and its result is written atomically (0600). When the read fails,
 * `edit` is not called and nothing is written: AppSettingUnreadableError.
 */
export function updateAppSettingStrict<T>(dir: string, name: string, check: (v: unknown) => v is T, edit: (cur: T | undefined) => T): Promise<T> {
  if (!SETTING_NAME.test(name)) throw new TypeError(`not a settings file name: ${name}`);
  return inSettingTurn(dir, name, async () => {
    const cur = await readAppSettingStrict(dir, name, check);
    ensurePrivateDir(dir);
    const next = edit(cur);
    await writeFileAtomic(join(dir, name), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return next;
  });
}

const asideStamp = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");

/**
 * The way out for a settings file that stays unreadable (Task 68): in its per-file turn, and only
 * when it is there and cannot be read, it is renamed to `<name>.unreadable-<stamp>` beside it
 * (never deleted), so the feature starts again from nothing. Returns that name. A file that can be
 * read, or is missing, is left alone: AppSettingReadableError.
 */
export function setAppSettingAside(dir: string, name: string, check: (v: unknown) => v is unknown, now: Date): Promise<string> {
  if (!SETTING_NAME.test(name)) throw new TypeError(`not a settings file name: ${name}`);
  return inSettingTurn(dir, name, async () => {
    try {
      const v = await readAppSettingStrict(dir, name, check);
      throw new AppSettingReadableError(name, v === undefined); // readable, or missing: nothing to reset
    } catch (err) {
      if (!(err instanceof AppSettingUnreadableError)) throw err;
    }
    const base = `${name}.unreadable-${asideStamp(now)}`;
    for (let n = 0; ; n++) {
      const keptAs = n === 0 ? base : `${base}-${n}`;
      try {
        await fsp.lstat(join(dir, keptAs));
        continue; // taken: never overwrite a file kept aside before
      } catch {
        // free
      }
      await fsp.rename(join(dir, name), join(dir, keptAs));
      return keptAs;
    }
  });
}

/** The researcher's display name on this device (R84/R117): photographer of device imports, `by` of destruction certificates. */
export const RESEARCHER_SETTING = "researcher.json";
export const RESEARCHER_NAME_MAX = 200;

/** A usable display name: 1–200 characters once trimmed, no control, format (bidi, zero-width), line-separator or lone surrogate characters. */
export function researcherNameOk(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const t = v.trim();
  return t.length > 0 && t.length <= RESEARCHER_NAME_MAX && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(t);
}

/** The researcher's display name on this device, or undefined when none is set (or the file is not usable). */
export async function researcherName(dir: string): Promise<string | undefined> {
  const v = await readAppSetting<{ name?: unknown }>(dir, RESEARCHER_SETTING);
  return v && researcherNameOk(v.name) ? v.name.trim() : undefined;
}

/** Sets (or, with null, clears) the researcher's display name on this device. */
export async function setResearcherName(dir: string, name: string | null): Promise<string | undefined> {
  if (name !== null && !researcherNameOk(name)) throw new TypeError("not a usable researcher name");
  const next = await writeAppSetting<{ name?: string }>(dir, RESEARCHER_SETTING, name === null ? {} : { name: name.trim() });
  return next.name;
}

/** One path segment character: anything but whitespace, separators, quotes and angle brackets. */
const SEG = String.raw`[^\s/\\"'<>|]`;
/** An absolute POSIX path; spaces are taken only inside folder names (another "/" follows). */
const POSIX_PATH = new RegExp(String.raw`(?<![\w.:/<\\])/${SEG}+(?:(?: ${SEG}+)*/${SEG}+)+`, "gu");
/** A Windows path (drive or UNC), the same way. */
const WINDOWS_PATH = new RegExp(String.raw`(?:[A-Za-z]:|\\\\${SEG}+)\\${SEG}*(?:(?: ${SEG}+)*\\${SEG}+)*`, "gu");
/** A quoted absolute path: everything up to the closing quote. */
const QUOTED_PATH = /(["'`])((?:\/|[A-Za-z]:\\|\\\\)[^"'`\n]*[/\\][^"'`\n]*)\1/gu;

/**
 * Makes a message safe to show or return: no absolute paths. Paths inside one of `roots` (library
 * folders) become library-relative; other absolute paths (with spaces, non-ASCII letters, Windows
 * drive or UNC forms) become `<path>`. Links (anything with a scheme) are kept exactly as they are.
 */
export function scrubPaths(text: string, roots: Iterable<string> = []): string {
  const urls: string[] = [];
  let out = text.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>)]+/g, (u) => `\u0000${urls.push(u) - 1}\u0000`);
  for (const r of [...roots].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const esc = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${esc}[\\\\/]`, "g"), "").replace(new RegExp(esc, "g"), "<library>");
  }
  out = out.replace(QUOTED_PATH, (_m, q: string) => `${q}<path>${q}`);
  out = out.replace(WINDOWS_PATH, "<path>");
  out = out.replace(POSIX_PATH, "<path>");
  return out.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => urls[Number(n)]!);
}
