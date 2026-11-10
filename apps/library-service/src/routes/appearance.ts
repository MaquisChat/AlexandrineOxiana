/**
 * Appearance (spec 8A): the researcher's theme and typefaces, per user and device, in
 * `<appConfigDir>/appearance.json` (a readable file, owner-only). PUT merges and validates.
 */
import type { FastifyInstance } from "fastify";
import { readAppSetting, updateAppSetting } from "@ao/library";
import { badRequest } from "../errors.js";
import { bodyOf, type Ctx, type Obj } from "./util.js";

const FILE = "appearance.json";
const GOUDY = "'Goudy Old Style', 'Sorts Mill Goudy', Garamond, Georgia, serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export interface FontChoice {
  family: string;
  source: "bundled" | "system" | "user-file";
  file?: string;
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
    interface: { family: GOUDY, source: "bundled" },
    reading: { family: GOUDY, source: "bundled" },
    transcript: { family: GOUDY, source: "bundled" },
    notes: { family: GOUDY, source: "bundled" },
    mono: { family: MONO, source: "system" },
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
  if (typeof o.family !== "string" || !o.family.trim() || o.family.length > 300 || /[;{}<>]/.test(o.family)) throw badRequest(`"fonts.${name}.family" is not a font name.`);
  const source = oneOf(o.source, ["bundled", "system", "user-file"] as const, `fonts.${name}.source`);
  if (o.file !== undefined && (typeof o.file !== "string" || o.file.length > 4096)) throw badRequest(`"fonts.${name}.file" must be a path.`);
  return { family: o.family, source, ...(typeof o.file === "string" ? { file: o.file } : {}) };
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

export function registerAppearance(app: FastifyInstance, ctx: Ctx): void {
  const dir = ctx.state.deps.appConfigDir;
  const current = async (): Promise<AppearanceSettings> => {
    const stored = await readAppSetting<Obj>(dir, FILE);
    try {
      return stored ? mergeAppearance(DEFAULT_APPEARANCE, stored) : DEFAULT_APPEARANCE;
    } catch {
      return DEFAULT_APPEARANCE; // a hand-edited file that is not valid: the defaults, until saved again
    }
  };

  app.get("/settings/appearance", async () => current());

  app.put("/settings/appearance", async (req) => {
    const next = mergeAppearance(await current(), bodyOf(req));
    await updateAppSetting<AppearanceSettings>(dir, FILE, () => next);
    return next;
  });
}
