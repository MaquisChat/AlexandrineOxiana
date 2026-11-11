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
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { SECRET_STORE_UNAVAILABLE, SecretStoreUnavailableError, deleteSecret, getSecret, setSecret } from "@ao/library";
import { isZoteroApiKeyShape, type SecretDeleteResponse, type SecretStatusResponse, type ZoteroDataFolder, type ZoteroDataFoldersResponse } from "@ao/shared";
import { ApiError, badRequest } from "../errors.js";
import { bodyOf, type Ctx } from "./util.js";

/** Zotero's prefs.js is a few kilobytes; anything far larger is not read. */
const PREFS_MAX_BYTES = 1024 * 1024;
/** Profiles looked at per place. */
const PROFILES_MAX = 32;

const NO_STORE_FOR_STATUS =
  "No secure key store is available on this computer (the system keychain or credential manager), so no Zotero key can be kept here. Keys are never kept in plain files.";

async function isRegularFile(p: string, maxBytes?: number): Promise<boolean> {
  try {
    const s = await lstat(p);
    return s.isFile() && (maxBytes === undefined || s.size <= maxBytes);
  } catch {
    return false;
  }
}

/** A folder Zotero would use: it holds a regular file `zotero.sqlite` (only its entry is looked at). */
async function looksLikeZoteroData(dir: string): Promise<boolean> {
  return isAbsolute(dir) && isRegularFile(join(dir, "zotero.sqlite"));
}

/** The data folder a profile's prefs.js names, when Zotero is set to use it. */
export function dataDirFromPrefs(text: string): string | null {
  const use = /^\s*user_pref\(\s*"extensions\.zotero\.useDataDir"\s*,\s*true\s*\)\s*;/m.test(text);
  if (!use) return null;
  const m = /^\s*user_pref\(\s*"extensions\.zotero\.dataDir"\s*,\s*("(?:[^"\\\n]|\\.)*")\s*\)\s*;/m.exec(text);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]!) as unknown;
    return typeof v === "string" && v.length > 0 && v.length <= 4096 && isAbsolute(v) ? v : null;
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
      const prefs = join(place, name, "prefs.js");
      if (!(await isRegularFile(prefs, PREFS_MAX_BYTES))) continue;
      let text: string;
      try {
        text = await readFile(prefs, "utf8");
      } catch {
        continue;
      }
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

/** The password store's refusal, in words that fit what was asked. */
function storeError(e: unknown, message: string): unknown {
  return e instanceof SecretStoreUnavailableError ? new ApiError(503, "UNAVAILABLE", message) : e;
}

export function registerZotero(app: FastifyInstance, ctx: Ctx): void {
  const uiOnly = (caller: string | undefined) => {
    if (caller !== "ui") throw new ApiError(403, "FORBIDDEN", "Only the desktop app can do this.");
  };

  // ---- the Zotero Web API key (R78): write-only ----
  app.get("/secrets/zotero-api-key", async (req): Promise<SecretStatusResponse> => {
    uiOnly(req.caller);
    try {
      return { stored: (await getSecret("zotero-api-key")) !== null };
    } catch (e) {
      throw storeError(e, NO_STORE_FOR_STATUS);
    }
  });

  app.put("/secrets/zotero-api-key", async (req): Promise<SecretStatusResponse> => {
    uiOnly(req.caller);
    const b = bodyOf(req);
    if (Object.keys(b).some((k) => k !== "apiKey")) throw badRequest('Only "apiKey" can be sent here.');
    // The value is never echoed: the message describes the rule, not what was sent.
    if (!isZoteroApiKeyShape(b.apiKey)) throw badRequest("That does not look like a Zotero API key: it is 24 letters and digits, from zotero.org, Settings, Security.");
    try {
      await setSecret("zotero-api-key", b.apiKey);
    } catch (e) {
      throw storeError(e, SECRET_STORE_UNAVAILABLE);
    }
    return { stored: true };
  });

  app.delete("/secrets/zotero-api-key", async (req): Promise<SecretDeleteResponse> => {
    uiOnly(req.caller);
    try {
      return { removed: await deleteSecret("zotero-api-key") };
    } catch (e) {
      throw storeError(e, NO_STORE_FOR_STATUS);
    }
  });

  // ---- the Zotero data folder ----
  app.get("/import/zotero-data-folders", async (req): Promise<ZoteroDataFoldersResponse> => {
    uiOnly(req.caller);
    void ctx;
    return { folders: await findZoteroDataFolders({ platform: process.platform, home: homedir(), env: process.env }) };
  });
}
