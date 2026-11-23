/**
 * Zotero account sync (Task Z8): the service's routes, declared once for the service and the interface, with every
 * sentence the researcher reads about a sync. Every route is for the desktop app's token only (the browser
 * extension's token gets 403, reads included, R96). Nothing here runs by itself: a run starts only through
 * `POST /zotero/sync/run` (the scheduler is a later task; `automatic: true` may be stored, and starts nothing yet).
 *
 *   POST /zotero/key-check         {} → ZoteroKeyCheckResponse        checks the key SAVED in this computer's password
 *                                                                     store (it is stored only through
 *                                                                     PUT /secrets/zotero-api-key); never answers the key.
 *                                                                     No body: no key ever travels in it (R248). A
 *                                                                     successful check clears every link's `key-refused`
 *                                                                     pause (and `library-gone` where the key reads it
 *                                                                     again); a failed one clears nothing.
 *   GET  /zotero/sync              → ZoteroSyncStateResponse
 *   PUT  /zotero/sync/settings     ZoteroSyncSettingsRequest → ZoteroSyncStateResponse   (writes this computer's file only)
 *   POST /zotero/sync/run          ZoteroSyncRunRequest → 202 ZoteroSyncRunResponse
 *   POST /zotero/sync/stop         → ZoteroSyncStopResponse
 *   GET  /zotero/sync/history      → ZoteroSyncHistoryResponse
 *
 * Live updates: the server-sent event `zotero.sync` with a ZoteroSyncEvent: "checking" when a link's run begins,
 * "running" with progress (at most once a second), "finished" with the run's record (always the last for that run).
 *
 * Words (plan, Global Constraints): plain British English; times in the service's local time zone as "14:32", and
 * "today" decided by local midnight; other days as "on 12 March 2027 at 14:32". A failure always names itself and never
 * reads like "up to date".
 */

/** Why a run ended as it did (the runner's reasons, plan Z7 and A10). */
export type ZoteroSyncReason =
  | "offline"
  | "zotero-error"
  | "key-missing"
  | "key-refused"
  | "no-store"
  | "library-gone"
  | "backing-off"
  | "project-locked"
  | "library-read-only"
  | "library-changing"
  | "too-large"
  | "stopped-by-you"
  | "app-closed"
  | "library-closed"
  | "import-running"
  | "error"
  | "sync-undone"
  | "deletions-unconfirmed"
  | "changes-incomplete"
  | "batch-ended"
  | "rules-denied";

export type ZoteroSyncOutcome = "up-to-date" | "finished" | "finished-with-problems" | "stopped" | "failed";
export type ZoteroSyncPause = "key-refused" | "library-gone" | "undone";
export type ZoteroSyncStructure = "collections" | "tags" | "none";
export type ZoteroSyncDuplicates = "merge" | "skip" | "keep-both";
export const ZOTERO_SYNC_EVERY_MINUTES = [30, 60, 240] as const;
export type ZoteroSyncEveryMinutes = (typeof ZOTERO_SYNC_EVERY_MINUTES)[number];

/** A run's numbers (plan A8–A10). */
export interface ZoteroSyncCounts {
  new: number;
  changed: number;
  unchanged: number;
  waiting: number;
  conflicts: number;
  goneMarked: number;
  failed: number;
  back: number;
  clearedKept: number;
}

/** One run's record, as this computer's history keeps it (no title, no name, no key). */
export interface ZoteroSyncRun {
  id: string;
  ref: string;
  projectId: string;
  trigger: "manual" | "automatic";
  startedAt: string;
  finishedAt?: string;
  outcome: ZoteroSyncOutcome;
  reason?: ZoteroSyncReason;
  batchId?: string;
  /** For an encrypted project: only while it is unlocked (read from its batch), never from this computer's file. */
  counts?: ZoteroSyncCounts;
  refusedHosts?: string[];
  backoffUntil?: string;
  note?: string;
  recordSaved?: false;
  /** R474 M8: no end yet, and another process of this computer (the command line, another copy of the app) is running it. */
  runningElsewhere?: true;
}

/** What the saved key may read (the key itself is never in it). */
export interface ZoteroKeyAccess {
  userId: string;
  personal: { library: boolean; files: boolean; notes: boolean; write: boolean };
  /** Group names are outside text: shown only through UserText. */
  groups: Array<{ ref: string; name: string; write: boolean }>;
}

/** `POST /zotero/key-check` takes no key: it checks the saved one. */
export type ZoteroKeyCheckRequest = Record<string, never>;
export type ZoteroKeyCheckResponse = ZoteroKeyAccess & { summary: string };

export interface ZoteroSyncLinkDto {
  ref: string;
  projectId: string;
  structure: ZoteroSyncStructure;
  duplicates: ZoteroSyncDuplicates;
  paused?: ZoteroSyncPause;
  fullDone: boolean;
}

export interface ZoteroSyncStateResponse {
  readOnly: boolean;
  /**
   * This computer's sync settings were written by a newer version of the app (R268 M4): they are left as they are, not
   * read (so `links` is empty and nothing runs) and not changed (a save is refused with `ZOTERO_SYNC_SENTENCES.settingsNewer`).
   */
  settingsNewer: boolean;
  /** Whether a key is saved; null when the password store cannot be asked. */
  keyStored: boolean | null;
  /** Stored as the researcher chose; while on, the service's scheduler (Z10) starts a linked library's sync when it is due. */
  automatic: boolean;
  everyMinutes: ZoteroSyncEveryMinutes;
  links: Array<ZoteroSyncLinkDto & { status: string; lastRun?: ZoteroSyncRun; waitingFor?: "project-locked" | "paused" }>;
  running?: { ref: string; done: number; total: number };
  backoffUntil?: string;
  /**
   * Z10 (R274 c): the earliest time (ISO) at which the scheduler would start a run for any link — "not before" (said by
   * `zoteroNextSyncLine`). Absent when automatic sync is off, or no link can become due (every link paused or its
   * project locked, the library read-only, the settings written by a newer version).
   */
  nextRunAt?: string;
}

export interface ZoteroSyncSettingsRequest {
  automatic: boolean;
  everyMinutes: ZoteroSyncEveryMinutes;
  /**
   * `resume: true` turns syncing of that link on again after an undo: its "undone" pause is cleared by this save
   * (R265, D26). Without it an existing "undone" is kept, whatever else the save changes. "key-refused" and
   * "library-gone" are never cleared by a save (a successful key check clears them).
   */
  links: Array<{ ref: string; projectId: string; structure: ZoteroSyncStructure; duplicates: ZoteroSyncDuplicates; resume?: true }>;
}

export interface ZoteroSyncRunRequest {
  ref?: string;
}
export interface ZoteroSyncRunResponse {
  started: true;
}
export interface ZoteroSyncStopResponse {
  stopped: true;
  /** The stopped run's record, when it ended in time. */
  run?: ZoteroSyncRun;
}
export interface ZoteroSyncHistoryResponse {
  runs: ZoteroSyncRun[];
}

export interface ZoteroSyncEvent {
  ref: string;
  projectId: string;
  state: "checking" | "running" | "finished";
  done?: number;
  total?: number;
  run?: ZoteroSyncRun;
}

/** Added to the answer of `POST /imports/:batchId/undo` when the batch was a sync's. */
export interface ZoteroSyncUndoNote {
  paused: boolean;
  message: string;
}

/** Every reason, once (a test compares it with the runner's list). */
export const ZOTERO_SYNC_REASONS_LIST: readonly ZoteroSyncReason[] = [
  "offline",
  "zotero-error",
  "key-missing",
  "key-refused",
  "no-store",
  "library-gone",
  "backing-off",
  "project-locked",
  "library-read-only",
  "library-changing",
  "too-large",
  "stopped-by-you",
  "app-closed",
  "library-closed",
  "import-running",
  "error",
  "sync-undone",
  "deletions-unconfirmed",
  "changes-incomplete",
  "batch-ended",
  "rules-denied",
];

/**
 * One sentence for every reason. `backing-off` holds `{until}`: zoteroSyncReasonText fills in the time Zotero asked
 * for. `zotero-error`, `no-store`, `too-large` and `error` follow the Web import's sentences (ZOTERO_WEB_REASONS)
 * without their "so nothing was imported" (the status line says what was changed). `batch-ended` and `library-closed`
 * are the coordinator's (R248).
 */
export const ZOTERO_SYNC_REASON_TEXT: Readonly<Record<ZoteroSyncReason, string>> = {
  offline: "Zotero could not be reached; check the internet connection.",
  "zotero-error": "Zotero's online service answered with an error. Try again later.",
  "key-missing": "No Zotero key is saved on this computer.",
  "key-refused": "Zotero refused the key: it may have been revoked. Check the key on this screen.",
  "no-store": "No secure key store (the system keychain or credential manager) is available on this computer, so the Zotero key cannot be read.",
  "library-gone": "This key can no longer read this library.",
  "backing-off": "Zotero asked this app to wait until {until}.",
  "project-locked": "The project is locked. Unlock it to sync.",
  "library-read-only": "This library is open read-only, so nothing can be synced.",
  "library-changing": "The Zotero library kept changing while it was read; it will be tried again.",
  "too-large": "Zotero sent a response that is too large or holds too many items.",
  "stopped-by-you": "You stopped it.",
  "app-closed": "The app was closed during the sync; it continues next time.",
  "library-closed": "The library was closed or moved during the sync; it continues next time.",
  "import-running": "Another import from this Zotero library is running.",
  error: "Something went wrong during the sync.",
  "sync-undone": "You undid this library's last sync, so syncing is paused until you turn it on again on this screen.",
  "deletions-unconfirmed": "This sync could not confirm which items were deleted in Zotero, so the next sync will read the whole library again.",
  "changes-incomplete": "This sync could not read everything that changed in Zotero. The next sync asks for the same changes again.",
  "batch-ended": "An unfinished sync could not be continued, so it was closed. The next sync starts again from the beginning.",
  /** R295 b: the engine's own refusal text is never shown (it may name a raw method). */
  "rules-denied": "This project's rules do not allow this sync. Change them in the project's Governance settings.",
};

/** The service's own sentences about syncing. */
export const ZOTERO_SYNC_SENTENCES = {
  alreadyRunning: "A sync is already running.",
  notRunning: "No sync is running.",
  nothingLinked: "No Zotero library is linked to a project yet. Choose one on the Zotero screen and save.",
  allPaused: "Every linked Zotero library is paused. Check the key, or turn the library on again, on the Zotero screen.",
  notLinked: "This Zotero library is not linked to a project. Link it on the Zotero screen and save.",
  undonePaused: "Syncing this Zotero library is paused. Turn it on again on the Zotero screen.",
  undoNotPaused: "Syncing this Zotero library could not be paused, so the next sync may bring back what you undid. Turn it off on the Zotero screen.",
  importRunning: "Another import from this Zotero library is running.",
  belongsToSync: "This import belongs to a Zotero sync. Stop it or run it again from the Zotero screen.",
  keyNotChecked: "Only the saved key can be checked. Save the key first, then check it.",
  settingsUnreadable: "This computer's Zotero sync settings could not be read, so nothing was changed. Try again in a moment.",
  /** FR-508: the device notice `zotero-sync-settings-set-aside`, in the app's banner and the command line alike. */
  settingsSetAside: "This computer's Zotero sync settings could not be read and were set aside. Automatic sync is off until you set it up again. Nothing in your library has changed.",
  /** The library module's own sentence for a settings file of a newer version (the service checks they are one). */
  settingsNewer: "These sync settings were written by a newer version of the app. Update the app to change them.",
  /** FR-507 (R474): a key check that worked, but the pauses its refusals set could not be cleared (`ao zotero check-key`). */
  keyPausesNotCleared: "This computer's Zotero sync settings could not be read or changed, so a Zotero library paused because of the key stays paused. Run the check again in a moment.",
} as const;

/**
 * FR-463 (R474 M4): the Zotero rows of an import's report that count items also counted in another row (an item
 * waiting for you that took other changes is also updated; a field cleared in Zotero and kept here belongs to an item
 * counted under its own outcome). The screen's table and the report file say the same words.
 */
export const ZOTERO_REPORT_ROWS = {
  conflicts: "Changed in Zotero and here — waiting for you (also counted in another row when other changes came in too)",
  clearedInZoteroKept: "Cleared in Zotero, kept here (also counted in another row)",
} as const;

/** FR-507 (R474): how many links a key check that worked turned on again (said only when at least one was). */
export const zoteroSyncsAgainLine = (n: number): string => `Syncing is on again for ${n} linked Zotero ${n === 1 ? "library" : "libraries"}.`;

const timeOf = (d: Date) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
const dateOf = (d: Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "long" }).format(d);
const dayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const sameDay = (a: Date, b: Date) => dayOf(a) === dayOf(b);

/** "at 14:32 today" or "on 12 March 2027 at 14:32", in the service's local time zone. */
function whenSaid(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "at an unknown time";
  return sameDay(d, now) ? `at ${timeOf(d)} today` : `on ${dateOf(d)} at ${timeOf(d)}`;
}

/**
 * Z10 (R274 c): the state's `nextRunAt` in words, its time said as the status lines say times: "Next automatic sync: not
 * before 15:10 today." or "… not before 13 March 2027 at 00:10." — "not before", because a run that is due may still
 * wait for another one, an import of the same Zotero library, or the next tick.
 */
export function zoteroNextSyncLine(nextRunAt: string, now: Date): string {
  return `Next automatic sync: not before ${whenSaid(nextRunAt, now).replace(/^(at|on) /u, "")}.`;
}

/** A reason's sentence; for `backing-off`, with the time Zotero asked for ("15:10", or "09:05 on 13 March 2027"). */
export function zoteroSyncReasonText(reason: ZoteroSyncReason | undefined, now: Date, backoffUntil?: string): string {
  const r = reason ?? "error";
  if (r !== "backing-off") return ZOTERO_SYNC_REASON_TEXT[r] ?? ZOTERO_SYNC_REASON_TEXT.error;
  const d = backoffUntil === undefined ? undefined : new Date(backoffUntil);
  if (!d || Number.isNaN(d.getTime())) return "Zotero asked this app to wait before it asks again.";
  const until = sameDay(d, now) ? timeOf(d) : `${timeOf(d)} on ${dateOf(d)}`;
  return ZOTERO_SYNC_REASON_TEXT["backing-off"].replace("{until}", until);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The counts the researcher understands, each only when not zero, in this order (R250 e). */
function countParts(c: ZoteroSyncCounts): string[] {
  const parts: string[] = [];
  if (c.new) parts.push(`${c.new} new`);
  if (c.changed) parts.push(`${c.changed} changed`);
  if (c.waiting) parts.push(`${c.waiting} waiting for your review`);
  if (c.conflicts) parts.push(`${c.conflicts} changed in Zotero and here (waiting for your decision)`);
  if (c.goneMarked) parts.push(`${c.goneMarked} deleted or binned in Zotero (kept here)`);
  if (c.back) parts.push(`${c.back} back in Zotero`);
  if (c.clearedKept) parts.push(`${c.clearedKept} cleared in Zotero (kept here)`);
  return parts;
}

/**
 * What a run that did not finish left behind (R250 f). With no batch, nothing was written. With a batch, its counts
 * cover the whole batch (a resumed one too): "had already come in" when they show writes; "Nothing here was changed."
 * only when they show none; "may already have come in" when they are not known (an encrypted project while locked).
 */
function leftBehind(run: ZoteroSyncRun): string {
  if (!run.batchId) return "Nothing here was changed.";
  const c = run.counts;
  if (!c) return "Some items may already have come in.";
  const wrote = c.new + c.changed + c.waiting + c.conflicts + c.goneMarked + c.back + c.clearedKept;
  return wrote > 0 ? "Some items had already come in." : "Nothing here was changed.";
}

/**
 * Why a run finished with problems, only as far as its record shows (R250 c). Z7 makes a run "finished-with-problems"
 * in exactly five ways, each mapped to its sentence here:
 *   1. items that could not be brought in (counts.failed)       → "N items could not be brought in."
 *   2. redirects to a host this app does not use (refusedHosts) → the refused-host sentence
 *   3. attached files to download again (no field of its own)   → the attached-files sentence, said only when the
 *      counts are known and show no failed item, no host and no reason (then it is the only cause Z7 has left)
 *   4. reason `deletions-unconfirmed`, 5. reason `changes-incomplete` → their reason sentences
 * With no counts (an encrypted project while it is locked) causes 1 and 3 cannot be told apart, so neither is said.
 */
function problemsOf(run: ZoteroSyncRun, now: Date): { known: string[]; unknown: boolean } {
  const known: string[] = [];
  const c = run.counts;
  if (c?.failed) known.push(`${plural(c.failed, "item", "items")} could not be brought in.`);
  if (run.refusedHosts?.length) known.push(`Some attached files were not fetched, because Zotero sent them from a server this app does not use (${run.refusedHosts.join(", ")}).`);
  if (run.reason === "deletions-unconfirmed" || run.reason === "changes-incomplete") known.push(zoteroSyncReasonText(run.reason, now));
  if (c && !known.length) known.push("Some attached files could not be downloaded; the next sync tries again.");
  return { known, unknown: !c };
}

/**
 * The one line that says how a link's last sync went (plan Z8 Accept 1). A failure always names itself; "nothing has
 * changed" is said only for a run whose outcome is `up-to-date`; a line names a cause only when its record shows it.
 */
export function zoteroSyncStatusLine(run: ZoteroSyncRun | undefined, now: Date): string {
  if (!run) return "Not synced yet.";
  const at = whenSaid(run.finishedAt ?? run.startedAt, now);
  const reason = () => zoteroSyncReasonText(run.reason, now, run.backoffUntil);
  switch (run.outcome) {
    case "up-to-date":
      return `Checked Zotero ${at}: nothing has changed since the last sync.`;
    case "finished": {
      if (!run.counts) return `Last synced with Zotero ${at}.`;
      const parts = countParts(run.counts);
      return `Last synced with Zotero ${at}: ${parts.length ? parts.join(", ") : "no items were new or changed"}.`;
    }
    case "finished-with-problems": {
      const { known, unknown } = problemsOf(run, now);
      if (!known.length) return `Synced with Zotero ${at}, with problems. Unlock the project to see what they were.`;
      const parts = run.counts ? countParts({ ...run.counts, failed: 0 }) : [];
      const tail = unknown ? " Unlock the project to see if there were others." : parts.length ? ` Came in: ${parts.join(", ")}.` : "";
      return `Synced with Zotero ${at}, with problems: ${known.join(" ")}${tail}`;
    }
    case "stopped":
      // R474 M8: a run another process of this computer is still running is said as running, not as without an end.
      if (run.runningElsewhere && run.finishedAt === undefined)
        return `A sync with Zotero started ${at} is still running elsewhere on this computer, in the command line or in another copy of the app.`;
      // FR-477: a record with no end is the started record (any finished one has an end): the app may have been
      // closed during the run, or the run's end could not be saved (R252 c). Not said as the app's closing alone.
      if (run.reason === "app-closed" && run.finishedAt === undefined)
        return `The sync started with Zotero ${at} has no recorded end: the app may have been closed during it, or its end could not be saved. It continues next time. ${leftBehind(run)}`;
      return `Stopped syncing with Zotero ${at}: ${reason()} ${leftBehind(run)}`;
    case "failed":
      return `Could not sync with Zotero ${at}: ${reason()} ${leftBehind(run)}`;
    default:
      // An outcome this build does not know (R250 f).
      return `A sync ${at} was recorded by a newer version of this app.`;
  }
}

/** "This key can read your library and 2 group libraries." */
export function zoteroKeySummary(a: ZoteroKeyAccess): string {
  const n = a.groups.length;
  const groups = plural(n, "group library", "group libraries");
  if (a.personal.library) return n ? `This key can read your library and ${groups}.` : "This key can read your library.";
  return n ? `This key can read ${groups}, but not your own library.` : "This key cannot read any of your Zotero libraries.";
}
