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
   * absent: UTC.
   */
  timeZone: z.string().min(1).max(64).optional(),
  backups: z.object({ automatic: z.boolean().optional(), keep: z.number().int().min(1).max(1000).optional() }).optional(),
});
export type Project = z.infer<typeof Project>;
