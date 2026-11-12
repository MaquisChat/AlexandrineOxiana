import { z } from "zod";
import { Id, LibraryRelativePath, Timestamp } from "./text.js";

/** Options of a watched folder (no path: see Project.watchedFolders). */
export const WatchedFolderOptions = z.object({
  /** A name the researcher gave the watch (shown instead of the folder's path). */
  label: z.string().max(200).optional(),
  /** Also watch subfolders (default: only files directly in the folder). */
  recursive: z.boolean().default(false),
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
   * The IANA time zone the project's calendar rules are read in (e.g. the retention date, R92);
   * absent: UTC. Set through a governed, audited change that accepts only a real zone name
   * (`timeZoneName`, R93); read leniently: a value that names no zone counts as UTC.
   */
  timeZone: z.string().min(1).max(64).optional(),
  backups: z.object({ automatic: z.boolean().optional(), keep: z.number().int().min(1).max(1000).optional() }).optional(),
});
export type Project = z.infer<typeof Project>;

/** Region/City style names (letters, digits, `_`, `+`, `-`), no offsets, spaces or empty parts. */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9][A-Za-z0-9_+-]*)*$/u;

/**
 * An IANA time zone name in its usual spelling (e.g. "europe/berlin" → "Europe/Berlin"), or
 * undefined when `name` is not one this runtime knows: unknown zones, UTC offsets ("+05:00"),
 * padded or overlong text are refused (R93: the project time-zone setting).
 */
export function timeZoneName(name: string): string | undefined {
  if (typeof name !== "string" || name.length < 1 || name.length > 64 || !ZONE_SHAPE.test(name)) return undefined;
  try {
    const resolved = new Intl.DateTimeFormat("en-CA", { timeZone: name }).resolvedOptions().timeZone;
    // The runtime's spelling when only the letter case differs; an alias it maps to an older
    // name ("America/Argentina/Buenos_Aires" → "America/Buenos_Aires") is kept as written.
    return resolved.toLowerCase() === name.toLowerCase() ? resolved : name;
  } catch {
    return undefined;
  }
}
