/**
 * The Find and acquire screen's remembered settings on this computer (Task F5; R245 c; R247 M8): the device file
 * `find-screen.json` (0600, written with the strict helper). Read by the service's state (the runner's "Check
 * everything I have") and by the routes.
 */
import { isId } from "@ao/core";
import { AppSettingUnreadableError, readAppSettingStrict, setAppSettingAside, updateAppSettingStrict } from "@ao/library";
import type { FindScreenSettings } from "@ao/shared";

export const FIND_SCREEN_FILE = "find-screen.json";
export const FIND_SCREEN_KEYS: readonly string[] = ["checkEverything", "projectId", "collectionId"];
const DEFAULTS: FindScreenSettings = Object.freeze({ checkEverything: false }) as FindScreenSettings;

export function isFindScreen(v: unknown): v is FindScreenSettings {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => !FIND_SCREEN_KEYS.includes(k))) return false;
  if (typeof o.checkEverything !== "boolean") return false;
  for (const k of ["projectId", "collectionId"]) if (o[k] !== undefined && (typeof o[k] !== "string" || !isId(o[k]))) return false;
  return true;
}

/** Only the three keys, in order. */
export const findScreenOf = (v: FindScreenSettings): FindScreenSettings => ({
  checkEverything: v.checkEverything,
  ...(v.projectId !== undefined ? { projectId: v.projectId } : {}),
  ...(v.collectionId !== undefined ? { collectionId: v.collectionId } : {}),
});

/** The settings: the defaults when the file is missing or cannot be read (a read never rewrites it). */
export async function readFindScreen(appConfigDir: string): Promise<FindScreenSettings> {
  try {
    const v = await readAppSettingStrict(appConfigDir, FIND_SCREEN_FILE, isFindScreen);
    return v ? findScreenOf(v) : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Writes the settings. A file that cannot be read never locks the researcher out of the switch (R245 c): it is set
 * aside as the other settings files of this computer are (`find-screen.json.unreadable-<stamp>`, never deleted), and
 * the new settings are written. (It is set aside only while it still cannot be read; a write in between is kept.)
 */
export async function writeFindScreen(appConfigDir: string, next: FindScreenSettings, now: Date): Promise<FindScreenSettings> {
  try {
    return await updateAppSettingStrict(appConfigDir, FIND_SCREEN_FILE, isFindScreen, () => next);
  } catch (err) {
    if (!(err instanceof AppSettingUnreadableError)) throw err;
    await setAppSettingAside(appConfigDir, FIND_SCREEN_FILE, isFindScreen, now).catch(() => undefined);
    return updateAppSettingStrict(appConfigDir, FIND_SCREEN_FILE, isFindScreen, () => next);
  }
}
