/**
 * Device-level notices (Task 68, R154, R178; shapes in @ao/shared api/device-notices): what the
 * researcher must hear about this computer's own settings, when it belongs to no library or project.
 * Kept in `<appConfigDir>/notices.json` (`{ v: 1, notices: [{ kind, at }] }`) through the strict
 * settings helper, so a notice is never the reason another is lost. At most one notice per kind.
 *
 * Raising never throws: a notice about a damaged file must not stop the app. When the notices file
 * itself cannot be read or written, the event is written to the standard error stream in plain words,
 * without a path, and the operation that raised it completes.
 */
import { isDeviceNoticeKind, type DeviceNotice, type DeviceNoticeKind } from "@ao/shared";
import { readAppSettingStrict, updateAppSettingStrict } from "./app-settings.js";

export const NOTICES_FILE = "notices.json";

interface NoticesFile {
  v: 1;
  notices: unknown[];
}

const isNoticesFile = (v: unknown): v is NoticesFile => typeof v === "object" && v !== null && Array.isArray((v as { notices?: unknown }).notices);
const usable = (n: unknown): n is DeviceNotice => isDeviceNoticeKind((n as DeviceNotice | null)?.kind) && typeof (n as DeviceNotice).at === "string";

/** What each kind is about, for the log line when the notice itself cannot be saved. */
const ABOUT: Record<DeviceNoticeKind, string> = {
  "device-identity-renewed": "this computer's identity for the app was damaged and had to be renewed",
  "old-copies-list-set-aside": "the list of old library copies awaiting deletion was damaged and was set aside",
  "watched-folders-list-set-aside": "this computer's list of watched folders was damaged and was set aside",
};

const pending = new Set<Promise<void>>();

/** Resolves once every notice being raised has been written (or logged). */
export async function deviceNoticesIdle(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** The notices kept on this computer. Throws AppSettingUnreadableError when the file cannot be read. */
export async function readDeviceNotices(dir: string): Promise<DeviceNotice[]> {
  const f = await readAppSettingStrict(dir, NOTICES_FILE, isNoticesFile);
  return (f?.notices ?? []).filter(usable);
}

/**
 * Raises a notice of `kind` (kept once: raising it again changes nothing). Never throws; when the
 * notices file cannot be read or written, says so on the standard error stream (no path).
 */
export function raiseDeviceNotice(dir: string, kind: DeviceNoticeKind, now: Date): Promise<void> {
  const run = updateAppSettingStrict<NoticesFile>(dir, NOTICES_FILE, isNoticesFile, (cur) => {
    const list = cur?.notices ?? [];
    if (list.some((n) => usable(n) && n.kind === kind)) return cur as NoticesFile;
    return { ...(cur ?? {}), v: 1, notices: [...list, { kind, at: now.toISOString() }] };
  }).then(
    () => undefined,
    () => {
      process.stderr.write(`A notice for the researcher could not be saved, because the app's list of notices on this computer could not be read or written. It was about this: ${ABOUT[kind]}.\n`);
    },
  );
  pending.add(run);
  void run.finally(() => pending.delete(run));
  return run;
}

/** Removes the notice of `kind` (the researcher's "Got it"). Throws when the notices file cannot be read. */
export async function dismissDeviceNotice(dir: string, kind: DeviceNoticeKind): Promise<DeviceNotice[]> {
  const next = await updateAppSettingStrict<NoticesFile>(dir, NOTICES_FILE, isNoticesFile, (cur) => ({
    ...(cur ?? {}),
    v: 1,
    notices: (cur?.notices ?? []).filter((n) => !(usable(n) && n.kind === kind)),
  }));
  return next.notices.filter(usable);
}
