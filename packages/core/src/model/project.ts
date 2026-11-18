import { z } from "zod";
import { Id, LibraryRelativePath, Timestamp } from "./text.js";

/** Options of a watched folder (no path: see Project.watchedFolders). */
export const WatchedFolderOptions = z.object({
  /** A name the researcher gave the watch (shown instead of the folder's path). */
  label: z.string().max(200).optional(),
  /** Also watch subfolders (default: only files directly in the folder). */
  recursive: z.boolean().default(false),
  /**
   * The collection new sources from this folder go into (cloud-drive folders, Task W3). Optional: an
   * old project.json has none; a collection that no longer exists means no collection.
   */
  collectionId: Id.optional(),
});
export type WatchedFolderOptions = z.infer<typeof WatchedFolderOptions>;

export const WatchedFolder = z.object({ id: Id, options: WatchedFolderOptions, createdAt: Timestamp });
export type WatchedFolder = z.infer<typeof WatchedFolder>;

export const Project = z.object({
  id: Id,
  name: z.string().min(1),
  folder: LibraryRelativePath,
  createdAt: Timestamp,
  targetLanguages: z.array(z.string()),
  encryption: z.object({ enabled: z.boolean(), keyId: z.string().optional() }),
  /** One-time explanations the researcher has acknowledged (spec 5.1), e.g. using their browser session. */
  captureAcknowledgements: z
    .object({ cookies: z.object({ at: Timestamp, by: z.string() }).optional() })
    .optional(),
  /** Per-project automation (spec 5.2); everything is manual (off) by default. */
  automation: z.object({ transcribeNewMedia: z.boolean().optional() }).optional(),
  /**
   * Import settings (Task 26, R78). `zoteroWeb`: per Zotero library ("user:<id>" / "group:<id>"),
   * the library version the last finished Web API import saw, so the next one asks only for what
   * changed since (`?since=`). Written through a governed, audited change. Never an API key.
   */
  importSettings: z
    .object({
      zoteroWeb: z
        .record(z.string().regex(/^(user|group):\d{1,12}$/), z.object({ lastLibraryVersion: z.number().int().min(0), at: Timestamp }))
        .optional(),
    })
    .optional(),
  /**
   * Watched folders (Task 26, R78): an id and options only. The folder's absolute path is a
   * device setting (`<appConfigDir>/watched-folders.json`, by library and project, R69), never
   * stored in the library: on another computer the watch exists but has no folder until one is chosen.
   */
  watchedFolders: z.array(WatchedFolder).max(100).optional(),
  /**
   * Backups (spec 9, R90 b): `automatic` — a daily backup while the app is open (absent: on);
   * `keep` — how many backups of this project are kept (absent: 10).
   */
  /**
   * The IANA time zone every date rule of the project is read in: protocol validity and retention
   * (R93, R160 as amended; see `dateRuleZone`). Absent: protocol dates in the computer's zone
   * (R17), retention in UTC (R92). Set through a governed, audited change that accepts only a
   * real zone name (`timeZoneName`); read leniently: a value that names no zone counts as unset.
   */
  timeZone: z.string().min(1).max(64).optional(),
  backups: z.object({ automatic: z.boolean().optional(), keep: z.number().int().min(1).max(1000).optional() }).optional(),
});
export type Project = z.infer<typeof Project>;

/**
 * Area/Location names of the geographic IANA areas (letters, digits, `_`, `+`, `-`; no offsets,
 * spaces or empty parts), or "UTC". Legacy and offset-style zones (`Etc/GMT+2`, which means
 * UTC−2; `EST`, `CET`, `SystemV/…`) are refused: they are easy to misread.
 */
const ZONE_SHAPE = /^(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)(?:\/[A-Za-z0-9][A-Za-z0-9_+-]*)+$/iu;

/**
 * An IANA time zone name in its usual spelling (e.g. "europe/berlin" → "Europe/Berlin"), or
 * undefined when `name` is not one this runtime knows: unknown zones, UTC offsets ("+05:00"),
 * legacy zones, padded or overlong text are refused (R93: the project time-zone setting).
 */
export function timeZoneName(name: string): string | undefined {
  if (typeof name !== "string" || name.length < 1 || name.length > 64) return undefined;
  if (name.toUpperCase() === "UTC") return "UTC";
  if (!ZONE_SHAPE.test(name)) return undefined;
  try {
    const resolved = new Intl.DateTimeFormat("en-CA", { timeZone: name }).resolvedOptions().timeZone;
    // The runtime's spelling when only the letter case differs. An alias it maps to another name
    // ("America/Argentina/Buenos_Aires" → "America/Buenos_Aires") is kept as written when written
    // in the usual case (every part capitalised), else the runtime's name is stored.
    if (resolved.toLowerCase() === name.toLowerCase()) return resolved;
    return name.split("/").every((part) => /^[A-Z]/u.test(part) && /[a-z]/u.test(part)) ? name : resolved;
  } catch {
    return undefined;
  }
}

/** The date rules of a project: protocol validity (R16, R17) and every other date; retention (R92). */
export type DateRule = "protocol" | "retention";

/**
 * THE zone a project's date rule is read in (R160 as amended): the project's time zone when one
 * is set (and names a zone), for every rule; else each rule's own default: the computer's zone
 * (`computerZone`, else this runtime's) for protocol dates and other dates (R17), UTC for
 * retention (R92). Every caller that gives the policy engine or a date check a zone uses this.
 */
export function dateRuleZone(project: { timeZone?: string | undefined }, rule: DateRule, computerZone: string | undefined): string {
  const set = project.timeZone ? timeZoneName(project.timeZone) : undefined;
  if (set) return set;
  if (rule === "retention") return "UTC";
  return computerZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}
