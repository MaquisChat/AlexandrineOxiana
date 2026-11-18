/**
 * Appearance (spec 8A): the researcher's theme and typefaces, per user and device, in
 * `<appConfigDir>/appearance.json` (a readable file, owner-only). PUT merges and validates.
 */
import type { FastifyInstance } from "fastify";
import { AppSettingUnreadableError, RESEARCHER_NAME_MAX, readAppSettingStrict, researcherName, researcherNameOk, setResearcherName, updateAppSettingStrict } from "@ao/library";
import { GENERIC_FAMILIES, inferGenericFamily, isGenericFamily, isUsableFontFamily, type GenericFamily } from "@ao/shared";
import { badRequest } from "../errors.js";
import { registerFonts } from "./fonts.js";
import { registerSettingsReset } from "./settings-reset.js";
import { bodyOf, type Ctx, type Obj } from "./util.js";

export const APPEARANCE_FILE = "appearance.json";
const FILE = APPEARANCE_FILE;
const GOUDY = "'Goudy Old Style', 'Sorts Mill Goudy', Garamond, Georgia, serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export interface FontChoice {
  family: string;
  source: "bundled" | "system" | "user-file";
  file?: string;
  /** The kind of face, for the UI's fallbacks (R105, R109); inferred from the family when not given. */
  generic?: GenericFamily;
}
export interface AppearanceSettings {
  theme: "system" | "light" | "dark";
  highContrast: boolean;
  accent?: string;
  fonts: { interface: FontChoice; reading: FontChoice; transcript: FontChoice; notes: FontChoice; mono: FontChoice };
  textScale: 0.875 | 1 | 1.125 | 1.25 | 1.5;
  lineSpacing: 1.3 | 1.5 | 1.8;
  density: "comfortable" | "compact";
  reducedMotion: "system" | "on" | "off";
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "system",
  highContrast: false,
  fonts: {
    interface: { family: GOUDY, source: "bundled", generic: "serif" },
    reading: { family: GOUDY, source: "bundled", generic: "serif" },
    transcript: { family: GOUDY, source: "bundled", generic: "serif" },
    notes: { family: GOUDY, source: "bundled", generic: "serif" },
    mono: { family: MONO, source: "system", generic: "monospace" },
  },
  textScale: 1,
  lineSpacing: 1.5,
  density: "comfortable",
  reducedMotion: "system",
};

function oneOf<T>(v: unknown, allowed: readonly T[], name: string): T {
  if (!allowed.includes(v as T)) throw badRequest(`"${name}" must be one of: ${allowed.join(", ")}.`);
  return v as T;
}

function font(v: unknown, name: string): FontChoice {
  if (!v || typeof v !== "object") throw badRequest(`"fonts.${name}" must be an object.`);
  const o = v as Obj;
  // The same rule as the UI (@ao/shared, R105/R108): no control, bidi or zero-width characters, no CSS delimiters.
  if (typeof o.family !== "string" || !isUsableFontFamily(o.family)) throw badRequest(`"fonts.${name}.family" is not a font name.`);
  const source = oneOf(o.source, ["bundled", "system", "user-file"] as const, `fonts.${name}.source`);
  if (o.file !== undefined && (typeof o.file !== "string" || o.file.length > 4096)) throw badRequest(`"fonts.${name}.file" must be a path.`);
  const given = o.generic;
  if (given !== undefined && !isGenericFamily(given)) throw badRequest(`"fonts.${name}.generic" must be one of: ${GENERIC_FAMILIES.join(", ")}.`);
  // Absent: inferred the way the UI infers it (R109), or left out when the family does not say.
  const generic = given ?? inferGenericFamily(o.family);
  return { family: o.family, source, ...(typeof o.file === "string" ? { file: o.file } : {}), ...(generic ? { generic } : {}) };
}

/** `patch` applied to `cur`, every value checked. */
export function mergeAppearance(cur: AppearanceSettings, patch: Obj): AppearanceSettings {
  const next: AppearanceSettings = structuredClone(cur);
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case "theme":
        next.theme = oneOf(v, ["system", "light", "dark"] as const, k);
        break;
      case "highContrast":
        if (typeof v !== "boolean") throw badRequest('"highContrast" must be true or false.');
        next.highContrast = v;
        break;
      case "accent":
        if (v === null) delete next.accent;
        else if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) next.accent = v;
        else throw badRequest('"accent" must be a colour written #rrggbb.');
        break;
      case "fonts": {
        if (!v || typeof v !== "object") throw badRequest('"fonts" must be an object.');
        for (const [slot, f] of Object.entries(v as Obj)) {
          if (!(slot in next.fonts)) throw badRequest(`"fonts.${slot}" is not a font setting.`);
          next.fonts[slot as keyof AppearanceSettings["fonts"]] = font(f, slot);
        }
        break;
      }
      case "textScale":
        next.textScale = oneOf(v, [0.875, 1, 1.125, 1.25, 1.5] as const, k);
        break;
      case "lineSpacing":
        next.lineSpacing = oneOf(v, [1.3, 1.5, 1.8] as const, k);
        break;
      case "density":
        next.density = oneOf(v, ["comfortable", "compact"] as const, k);
        break;
      case "reducedMotion":
        next.reducedMotion = oneOf(v, ["system", "on", "off"] as const, k);
        break;
      default:
        throw badRequest(`"${k}" is not an appearance setting.`);
    }
  }
  return next;
}

/**
 * An appearance file as the app writes it: an object whose values this app accepts (Task 68). Any
 * other content (not JSON, truncated, a value it refuses) is unreadable: never written over.
 */
export function isAppearanceFile(v: unknown): v is Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  try {
    mergeAppearance(DEFAULT_APPEARANCE, v as Obj);
    return true;
  } catch {
    return false;
  }
}

export function registerAppearance(app: FastifyInstance, ctx: Ctx): void {
  const dir = ctx.state.deps.appConfigDir;
  // Typefaces from the researcher's own files (R100, Task 57).
  registerFonts(app, ctx);
  // The way out for a settings file that stays unreadable (Task 68).
  registerSettingsReset(app, ctx);

  // The researcher's display name on this device (R84/R117): the photographer of device imports and
  // the `by` of destruction certificates. Device settings, like appearance; null clears it.
  app.get("/settings/researcher", async () => ({ name: (await researcherName(dir)) ?? null }));
  app.put("/settings/researcher", async (req) => {
    const name = bodyOf(req).name;
    if (name !== null && !researcherNameOk(name)) throw badRequest(`"name" must be 1 to ${RESEARCHER_NAME_MAX} characters without control or direction characters, or null.`);
    return { name: (await setResearcherName(dir, name)) ?? null };
  });
  const current = async (): Promise<AppearanceSettings> => {
    try {
      const stored = await readAppSettingStrict(dir, FILE, isAppearanceFile);
      return stored ? mergeAppearance(DEFAULT_APPEARANCE, stored) : DEFAULT_APPEARANCE;
    } catch (err) {
      if (!(err instanceof AppSettingUnreadableError)) throw err;
      // Shown with the defaults so the app stays usable; a change is refused until the file is
      // readable or reset (Task 68), so the defaults are never written over it.
      return DEFAULT_APPEARANCE;
    }
  };

  app.get("/settings/appearance", async () => current());

  app.put("/settings/appearance", async (req) => {
    const patch = bodyOf(req);
    mergeAppearance(DEFAULT_APPEARANCE, patch); // a bad value is refused before anything is written
    // Merged inside the serialised read-modify-write, so concurrent PUTs all apply (R105); only over
    // what was read: a file that cannot be read refuses the change (503, reason "appearance", Task 68).
    return updateAppSettingStrict<Obj>(dir, FILE, isAppearanceFile, (cur) => mergeAppearance(cur ? mergeAppearance(DEFAULT_APPEARANCE, cur) : DEFAULT_APPEARANCE, patch) as unknown as Obj) as unknown as Promise<AppearanceSettings>;
  });
}
