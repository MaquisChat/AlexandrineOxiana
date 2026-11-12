/**
 * The way out for a settings file that stays unreadable (Task 68, defect D16, Task 66's M8).
 *
 * The service never writes over a settings file it could not read: a change is refused with
 * 503 UNAVAILABLE, its `reason` naming the file (`extension-pairings`, `fonts`, `appearance`).
 * `POST /settings/reset { file, confirm: true }` (the desktop app's token only; 127.0.0.1, token,
 * Host and Origin as everywhere, R96) then sets that ONE file aside: it is renamed beside itself to
 * `<name>.unreadable-<date>-<time>` (never deleted, never read again by the app), and the feature
 * starts from nothing. A file that can be read, or is not there, is never reset (409).
 *
 *  - extension-pairings: no browser stays paired; each must be paired again.
 *  - fonts: the list of added fonts starts empty; their kept copies stay in the fonts folder and are
 *    reused when the same file is added again (fonts.ts resetFontIndex).
 *  - appearance: the appearance choices go back to the defaults.
 */
import type { FastifyInstance } from "fastify";
import { dismissDeviceNotice, setAppSettingAside } from "@ao/library";
import { isDeviceNoticeKind, isResettableSetting, type DeviceNotice, type SettingsResetResponse } from "@ao/shared";
import { ApiError, badRequest } from "../errors.js";
import { APPEARANCE_FILE, isAppearanceFile } from "./appearance.js";
import { resetFontIndex } from "./fonts.js";
import { bodyOf, type Ctx } from "./util.js";

export function registerSettingsReset(app: FastifyInstance, ctx: Ctx): void {
  const dir = ctx.state.deps.appConfigDir;

  // A device-level notice goes only by the researcher's own "Got it" (Task 68, R154, R178): the
  // desktop app's token only; the library state is sent again without it.
  app.post("/settings/notices/dismiss", async (req): Promise<{ notices: DeviceNotice[] }> => {
    if (req.caller !== "ui") throw new ApiError(403, "FORBIDDEN", "Only the desktop app can do this.");
    const b = bodyOf(req);
    if (Object.keys(b).some((k) => k !== "kind")) throw badRequest('Only "kind" can be sent here.');
    if (!isDeviceNoticeKind(b.kind)) throw badRequest('"kind" must be the kind of a notice this app shows.');
    const notices = await dismissDeviceNotice(dir, b.kind);
    await ctx.state.refreshNotices();
    ctx.state.publishState();
    return { notices };
  });

  app.post("/settings/reset", async (req): Promise<SettingsResetResponse> => {
    if (req.caller !== "ui") throw new ApiError(403, "FORBIDDEN", "Only the desktop app can do this.");
    const b = bodyOf(req);
    if (Object.keys(b).some((k) => k !== "file" && k !== "confirm")) throw badRequest('Only "file" and "confirm" can be sent here.');
    if (!isResettableSetting(b.file)) throw badRequest('"file" must be "extension-pairings", "fonts" or "appearance".');
    if (b.confirm !== true) throw badRequest("A settings file is reset only after its confirmation in the desktop app.");
    const now = new Date();
    switch (b.file) {
      case "extension-pairings":
        return { reset: true, keptAs: await ctx.pairing.reset(now) };
      case "fonts":
        return { reset: true, keptAs: await resetFontIndex(dir, now) };
      case "appearance":
        return { reset: true, keptAs: await setAppSettingAside(dir, APPEARANCE_FILE, isAppearanceFile, now) };
    }
  });
}
