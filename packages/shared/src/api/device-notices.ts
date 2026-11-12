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
 *
 * Carried in `library.state` (`notices`); dismissed with `POST /settings/notices/dismiss { kind }`
 * (the desktop app's token only).
 */
export const DEVICE_NOTICE_KINDS = ["device-identity-renewed", "old-copies-list-set-aside"] as const;
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
