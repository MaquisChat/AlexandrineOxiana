/**
 * Device-level settings shared by the CLI and the local library service (Task 30): where the app's
 * settings folder is, this device's `Deps`, small JSON settings files in that folder (appearance,
 * paired browser extensions …: per user and device, never in the library), and the scrubbing of
 * absolute paths out of messages shown to people or returned by the service.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { newId } from "@ao/core";
import type { Deps } from "./deps.js";
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

function deviceIdIn(dir: string): string {
  const file = join(dir, "device.json");
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { deviceId?: unknown };
    if (typeof v.deviceId === "string" && v.deviceId) return v.deviceId;
  } catch {
    // first run
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
  return id;
}

/** This device's Deps (clock, device id, lock liveness) with `dir` as the app settings folder. */
export function deviceDeps(dir: string = appConfigDir()): Deps {
  ensurePrivateDir(dir);
  return {
    clock: () => new Date(),
    deviceId: deviceIdIn(dir),
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
 * Read-modify-write of a settings file (owner-only, 0600, written atomically), serialised per file
 * in this process. `edit` gets the current value (undefined when none) and returns the new one.
 */
export function updateAppSetting<T>(dir: string, name: string, edit: (cur: T | undefined) => T): Promise<T> {
  if (!SETTING_NAME.test(name)) throw new TypeError(`not a settings file name: ${name}`);
  const key = join(dir, name);
  const run = (settingLocks.get(key) ?? Promise.resolve()).then(async () => {
    ensurePrivateDir(dir);
    const next = edit(await readAppSetting<T>(dir, name));
    await writeFileAtomic(key, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return next;
  });
  settingLocks.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * Makes a message safe to show or return: no absolute paths. Paths inside one of `roots` (library
 * folders) become library-relative; other absolute paths become `<path>`. Links (anything with a
 * scheme) are kept exactly as they are.
 */
export function scrubPaths(text: string, roots: Iterable<string> = []): string {
  const urls: string[] = [];
  let out = text.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>)]+/g, (u) => `\u0000${urls.push(u) - 1}\u0000`);
  for (const r of [...roots].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const esc = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${esc}[\\\\/]`, "g"), "").replace(new RegExp(esc, "g"), "<library>");
  }
  out = out.replace(/[A-Za-z]:\\[^\s"'),;]+/g, "<path>");
  out = out.replace(/(?<![\w.:])\/[\w.@~-]+(?:\/[\w.@~-]+)+/g, "<path>");
  return out.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => urls[Number(n)]!);
}
