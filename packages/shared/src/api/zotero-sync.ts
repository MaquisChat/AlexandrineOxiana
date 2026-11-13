/**
 * Zotero account sync (Task Z8): the service's routes, declared once for the service and the interface, with every
 * sentence the researcher reads about a sync. Every route is for the desktop app's token only (the browser
 * extension's token gets 403, reads included, R96). Nothing here runs by itself: a run starts only through
 * `POST /zotero/sync/run` (the scheduler is a later task; `automatic: true` may be stored, and starts nothing yet).
 *
 *   POST /zotero/key-check         {} → ZoteroKeyCheckResponse        checks the key SAVED in this computer's password
 *                                                                     store (it is stored only through
 *                                                                     PUT /secrets/zotero-api-key); never answers the key
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
  | "import-running"
  | "error"
  | "sync-undone"
  | "deletions-unconfirmed"
  | "changes-incomplete"
  | "batch-ended";

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
  /** Whether a key is saved; null when the password store cannot be asked. */
  keyStored: boolean | null;
  /** Stored as the researcher chose; no run starts by itself yet (no scheduler in this version). */
  automatic: boolean;
  everyMinutes: ZoteroSyncEveryMinutes;
  links: Array<ZoteroSyncLinkDto & { status: string; lastRun?: ZoteroSyncRun; waitingFor?: "project-locked" | "paused" }>;
  running?: { ref: string; done: number; total: number };
  backoffUntil?: string;
  nextRunAt?: string;
}

export interface ZoteroSyncSettingsRequest {
  automatic: boolean;
  everyMinutes: ZoteroSyncEveryMinutes;
  links: Array<{ ref: string; projectId: string; structure: ZoteroSyncStructure; duplicates: ZoteroSyncDuplicates }>;
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
  "import-running",
  "error",
  "sync-undone",
  "deletions-unconfirmed",
  "changes-incomplete",
  "batch-ended",
];

/**
 * One sentence for every reason. `backing-off` holds `{until}`: zoteroSyncReasonText fills in the time Zotero asked
 * for. `zotero-error`, `no-store`, `too-large` and `error` follow the Web import's sentences (ZOTERO_WEB_REASONS)
 * without their "so nothing was imported" (the status line says what was changed); `batch-ended` follows the runner's
 * note (ZOTERO_SYNC_ENDED_NOTE).
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
  "import-running": "Another import from this Zotero library is running.",
  error: "Something went wrong during the sync.",
  "sync-undone": "You undid this library's last sync, so syncing is paused until you turn it on again on this screen.",
  "deletions-unconfirmed": "This sync could not confirm which items were deleted in Zotero, so the next sync will read the whole library again.",
  "changes-incomplete": "This sync could not read everything that changed in Zotero. The next sync asks for the same changes again.",
  "batch-ended": "This sync could not be resumed, so it was ended; what it brought in stays. The next sync reads the whole Zotero library again.",
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
  keyNotChecked: "Only the saved key can be checked. Save the key first, then check it.",
  settingsUnreadable: "This computer's Zotero sync settings could not be read, so nothing was changed. Try again in a moment.",
} as const;

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

/** The counts the researcher understands, each only when not zero. */
function countParts(c: ZoteroSyncCounts): string[] {
  const parts: string[] = [];
  if (c.new) parts.push(`${c.new} new`);
  if (c.changed) parts.push(`${c.changed} changed`);
  if (c.waiting) parts.push(`${c.waiting} waiting for your review`);
  if (c.conflicts) parts.push(`${c.conflicts} changed both in Zotero and here for you to decide`);
  if (c.goneMarked) parts.push(`${c.goneMarked} marked as no longer in Zotero`);
  if (c.back) parts.push(`${c.back} back in Zotero`);
  if (c.clearedKept) parts.push(`${c.clearedKept} cleared in Zotero and kept here`);
  return parts;
}

/** What a run that did not finish left behind. */
function leftBehind(run: ZoteroSyncRun): string {
  if (!run.batchId) return "Nothing here was changed.";
  const c = run.counts;
  if (!c) return "Some items may have come in before it stopped.";
  const wrote = c.new + c.changed + c.waiting + c.conflicts + c.goneMarked + c.back + c.clearedKept;
  return wrote > 0 ? "Some items came in before it stopped." : "Nothing here was changed.";
}

/**
 * The one line that says how a link's last sync went (plan Z8 Accept 1). A failure always names itself; "nothing has
 * changed" is said only for a run whose outcome is `up-to-date`.
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
      const problems: string[] = [];
      if (run.counts?.failed) problems.push(`${plural(run.counts.failed, "item", "items")} could not be brought in.`);
      if (run.refusedHosts?.length) problems.push(`Some attached files were not fetched, because Zotero sent them from a server this app does not use (${run.refusedHosts.join(", ")}).`);
      if (run.reason === "deletions-unconfirmed" || run.reason === "changes-incomplete") problems.push(reason());
      if (!problems.length) problems.push("Some attached files could not be downloaded; the next sync tries again.");
      const parts = run.counts ? countParts({ ...run.counts, failed: 0 }) : [];
      return `Synced with Zotero ${at}, with problems: ${problems.join(" ")}${parts.length ? ` Came in: ${parts.join(", ")}.` : ""}`;
    }
    case "stopped":
      return `Stopped syncing with Zotero ${at}: ${reason()} ${leftBehind(run)}`;
    case "failed":
    default:
      return `Could not sync with Zotero ${at}: ${reason()} ${leftBehind(run)}`;
  }
}

/** "This key can read your library and 2 group libraries." */
export function zoteroKeySummary(a: ZoteroKeyAccess): string {
  const n = a.groups.length;
  const groups = plural(n, "group library", "group libraries");
  if (a.personal.library) return n ? `This key can read your library and ${groups}.` : "This key can read your library.";
  return n ? `This key can read ${groups}, but not your own library.` : "This key cannot read any of your Zotero libraries.";
}
