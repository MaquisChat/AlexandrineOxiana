/**
 * A settings file of this computer that cannot be read (Task 68, defect D16). The service never
 * writes over a settings file it could not read: the change is refused with
 * `503 { error: { code: "UNAVAILABLE", reason: <ResettableSetting>, message } }`. The desktop app
 * then offers a way out: `POST /settings/reset` (the desktop app's token only) sets that one file
 * aside, under a name that says what it is, and the feature starts again empty.
 */

/** The settings files that can be reset this way, as the error's `reason` names them. */
export const RESETTABLE_SETTINGS = ["extension-pairings", "fonts", "appearance", "background"] as const;
export type ResettableSetting = (typeof RESETTABLE_SETTINGS)[number];

export function isResettableSetting(v: unknown): v is ResettableSetting {
  return typeof v === "string" && (RESETTABLE_SETTINGS as readonly string[]).includes(v);
}

/** `POST /settings/reset`. `confirm` must be `true`: the desktop app sends it only after its confirmation. */
export interface SettingsResetRequest {
  file: ResettableSetting;
  confirm: true;
}

export interface SettingsResetResponse {
  reset: true;
  /** The name the unreadable file was kept under, beside it in the settings folder (never a path). */
  keptAs: string;
}
