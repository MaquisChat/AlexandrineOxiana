/**
 * What the import wizard needs before a Zotero import (Task 57; types in @ao/shared import-setup).
 *
 * The Zotero Web API key (R78) is kept only in the system password store, through the library's
 * secrets module: it can be stored, asked about (stored or not) and removed, and is never sent back,
 * logged, or put in an error or an address. With no password store, the answer says so and nothing
 * is stored anywhere else.
 *
 * The Zotero data folder: Zotero's usual place (`~/Zotero`, also `%USERPROFILE%\Zotero`) and the
 * folder Zotero's own setting names when the researcher moved it (`extensions.zotero.dataDir` with
 * `useDataDir` in a Zotero profile's prefs.js). A folder is offered only when it holds a
 * `zotero.sqlite` file; nothing inside it is opened or read. Nothing is imported until the
 * researcher picks one and scans it.
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import nativePath, { isAbsolute, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { isZoteroApiKeyShape, type ZoteroDataFolder, type ZoteroDataFoldersResponse } from "@ao/shared";
import { ApiError } from "../errors.js";
import { readSmallRegularFile } from "./safe-file.js";
import { registerSecretKey } from "./search-settings.js";
import { type Ctx } from "./util.js";

/** Zotero's prefs.js is a few kilobytes; anything far larger is not read. */
const PREFS_MAX_BYTES = 1024 * 1024;
/** Profiles looked at per place. */
const PROFILES_MAX = 32;

const NO_STORE_FOR_STATUS =
  "No secure key store is available on this computer (the system keychain or credential manager), so no Zotero key can be kept here. Keys are never kept in plain files.";

async function isRegularFile(p: string): Promise<boolean> {
  try {
    const s = await lstat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/** A folder Zotero would use: it holds a regular file `zotero.sqlite` (only its entry is looked at). */
async function looksLikeZoteroData(dir: string): Promise<boolean> {
  return isAbsolute(dir) && isRegularFile(join(dir, "zotero.sqlite"));
}

/**
 * A data folder Zotero's setting names, as an absolute local path, normalised (`..` resolved, one
 * separator kind on Windows), or null. Decided on the text alone, before anything on disk is looked
 * at: a network path (`\\server\share`, `//server/share`), a Windows device or long path (`\\?\`,
 * `\\.\`), a path relative to a drive's current folder (`C:Zotero`) or to the current drive's root
 * (`\Zotero`), and anything relative are refused, so a planted prefs.js cannot make the service
 * reach out to another computer. `p` is the platform's path module (`path.win32` or `path.posix`).
 */
export function localDataDir(value: string, p: typeof nativePath.posix): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\u0000")) return null;
  if (p.sep === "\\") {
    // A fully qualified path on a drive: a letter, a colon and a separator, and nothing in front of it.
    if (!/^[A-Za-z]:[\\/]/.test(value)) return null;
    const n = p.normalize(value);
    if (!/^[A-Za-z]:\\/.test(n)) return null;
    return n.length > 3 ? n.replace(/\\+$/, "") : n;
  }
  // POSIX: a leading "//" may name a network root on some systems, so it is not taken.
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  const n = p.normalize(value);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

/** The last value prefs.js gives a preference (Mozilla reads the file top to bottom, so a later line wins). */
function lastPref(text: string, name: string, value: string): string | undefined {
  const re = new RegExp(`^\\s*user_pref\\(\\s*"${name.replace(/\./g, "\\.")}"\\s*,\\s*(${value})\\s*\\)\\s*;`, "gm");
  let last: string | undefined;
  for (const m of text.matchAll(re)) last = m[1];
  return last;
}

/** The data folder a profile's prefs.js names, when Zotero is set to use it (the last line of each setting counts). */
export function dataDirFromPrefs(text: string, p: typeof nativePath.posix = nativePath): string | null {
  if (lastPref(text, "extensions.zotero.useDataDir", "true|false") !== "true") return null;
  const raw = lastPref(text, "extensions.zotero.dataDir", '"(?:[^"\\\\\\n]|\\\\.)*"');
  if (raw === undefined) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === "string" ? localDataDir(v, p) : null;
  } catch {
    return null;
  }
}

/** Where Zotero keeps its profiles on each system. */
function profilePlaces(platform: string, home: string, env: Record<string, string | undefined>): string[] {
  if (platform === "darwin") return [join(home, "Library", "Application Support", "Zotero", "Profiles")];
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return [join(appData, "Zotero", "Zotero", "Profiles")];
  }
  return [join(home, ".zotero", "zotero"), join(home, ".var", "app", "org.zotero.Zotero", ".zotero", "zotero")];
}

/**
 * The folders on this computer that look like a Zotero data folder: first those Zotero's own
 * setting names, then the usual place. Each folder once.
 */
export async function findZoteroDataFolders(o: { platform: string; home: string; env: Record<string, string | undefined> }): Promise<ZoteroDataFolder[]> {
  const candidates: ZoteroDataFolder[] = [];
  for (const place of profilePlaces(o.platform, o.home, o.env)) {
    let names: string[];
    try {
      names = (await readdir(place, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort().slice(0, PROFILES_MAX);
    } catch {
      continue;
    }
    for (const name of names) {
      // Opened without following a link and without waiting on a pipe; read through that one handle.
      const text = await readSmallRegularFile(join(place, name, "prefs.js"), PREFS_MAX_BYTES);
      if (text === null) continue;
      const dir = dataDirFromPrefs(text);
      if (dir) candidates.push({ path: dir, from: "zotero-setting" });
    }
  }
  const homes = o.platform === "win32" && o.env.USERPROFILE ? [o.env.USERPROFILE, o.home] : [o.home];
  for (const h of homes) candidates.push({ path: join(h, "Zotero"), from: "usual-place" });

  const seen = new Set<string>();
  const out: ZoteroDataFolder[] = [];
  for (const c of candidates) {
    if (!(await looksLikeZoteroData(c.path))) continue;
    const real = await realpath(c.path).catch(() => c.path);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(c);
  }
  return out;
}

const ONLY_DESKTOP_APP = "Only the desktop app can do this.";

export function registerZotero(app: FastifyInstance, ctx: Ctx): void {
  const uiOnly = (caller: string | undefined) => {
    if (caller !== "ui") throw new ApiError(403, "FORBIDDEN", ONLY_DESKTOP_APP);
  };

  // ---- the Zotero Web API key (R78): write-only, through the one implementation of a kept key's routes (R297 d) ----
  registerSecretKey(app, {
    name: "zotero-api-key",
    uiOnly: ONLY_DESKTOP_APP,
    noStoreForStatus: NO_STORE_FOR_STATUS,
    keyFields: 'Only "apiKey" can be sent here.',
    keyShape: "That does not look like a Zotero API key: it is 24 letters and digits, from zotero.org, Settings, Security.",
    isShape: isZoteroApiKeyShape,
  });

  // ---- the Zotero data folder ----
  app.get("/import/zotero-data-folders", async (req): Promise<ZoteroDataFoldersResponse> => {
    uiOnly(req.caller);
    void ctx;
    return { folders: await findZoteroDataFolders({ platform: process.platform, home: homedir(), env: process.env }) };
  });
}
