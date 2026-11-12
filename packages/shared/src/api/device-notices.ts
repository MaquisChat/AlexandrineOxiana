/**
 * Device-level notices (Task 68, R154, R178): something happened to this computer's own settings
 * that the researcher must hear about, and that belongs to no library or project. A notice is a
 * kind from this closed list and the time it was raised: nothing typed by anyone, no path, no id, no
 * file contents. The words shown are the interface's own, keyed by the kind. At most one notice of
 * each kind is kept; it goes only by the researcher's own "Got it".
 *
 *  - `device-identity-renewed`: this computer's identity for the app could not be read as it was
 *    (its file was damaged), so the damaged file was kept aside and a new identity made.
 *  - `old-copies-list-set-aside`: the list of old library copies awaiting deletion was damaged, so it
 *    was kept aside and a fresh list started.
 *  - `watched-folders-list-set-aside`: this computer's list of watched folders was damaged, so it was
 *    kept aside and a fresh list started (Task 68 fix round 1).
 *  - `approved-folders-list-set-aside`: this computer's list of folders approved for imports was
 *    damaged, so it was kept aside and a fresh list started (Task 68 fix round 1).
 *  - `libraries-list-set-aside`: this computer's list of libraries was damaged, so it was kept aside
 *    and a fresh list started; the libraries themselves are untouched (Task 68 fix round 2, R181 a).
 *
 * Carried in `library.state` (`notices`); dismissed with `POST /settings/notices/dismiss { kind }`
 * (the desktop app's token only).
 */
export const DEVICE_NOTICE_KINDS = ["device-identity-renewed", "old-copies-list-set-aside", "watched-folders-list-set-aside", "approved-folders-list-set-aside", "libraries-list-set-aside"] as const;
export type DeviceNoticeKind = (typeof DEVICE_NOTICE_KINDS)[number];

export function isDeviceNoticeKind(v: unknown): v is DeviceNoticeKind {
  return typeof v === "string" && (DEVICE_NOTICE_KINDS as readonly string[]).includes(v);
}

export interface DeviceNotice {
  kind: DeviceNoticeKind;
  /** When it was raised (ISO 8601). */
  at: string;
}

/** `POST /settings/notices/dismiss`. */
export interface DeviceNoticeDismissRequest {
  kind: DeviceNoticeKind;
}
