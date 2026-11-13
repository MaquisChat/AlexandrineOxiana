/**
 * Zotero account sync (Task Z7): the runner. `syncZoteroLibrary` performs ONE sync of one linked Zotero library
 * (`user:<n>` / `group:<n>`) into one project, and always leaves an honest record of it in this computer's history
 * (zotero-sync-settings.ts). Nothing here runs by itself: Z8 (manual runs), Z10 (the scheduler) and Z12 (the CLI)
 * call it.
 *
 * The order of a run (plan Z7 Accept 1, brief points 1–11):
 *   1. Refusals before any request, in this order, each finished in one record with outcome `failed`: the library
 *      is read-only (or closed) → `library-read-only`; the project is unknown → `error`, locked → `project-locked`;
 *      the link is paused (its stored pause wins over the caller's copy) → the pause's reason (`key-refused`,
 *      `library-gone`, `sync-undone`); a run of this library and project is going on — this runner's own (its lock,
 *      taken synchronously at the call, so two calls at the same moment are one run and one refusal) or any import
 *      batch of the same Zotero library in the project (`isBatchActive`: a manual import from the wizard) →
 *      `import-running`; inside back-off → `backing-off` (with the time); no key → `key-missing`, no password store →
 *      `no-store`. An abort before or between any of these is `stopped`.
 *   2. A started record is written (`outcome: "stopped"`, `reason: "app-closed"`, no `finishedAt`: if the process dies
 *      now, that is what happened; readZoteroSyncHistory reads it so in any other process).
 *   3. This link's own unfinished batch (state paused, cancelled, failed or interrupted, kind zotero-web, this ref) is
 *      resumed with the options it started with. "Own": `origin: "zotero-sync"` on the batch record, which startBatch
 *      writes at the record's creation for the runner's batches only (R242); the history file plays no part. A batch
 *      of the library without it (started by hand) is never adopted: it blocks while active (1.), else is ignored.
 *   4. Otherwise, when `fullDone` and the project's remembered version (`since`) are both known: ONE request
 *      (zoteroLibraryUnchanged). 304 → `up-to-date`, and nothing at all is written to the library.
 *   5. Otherwise the key is checked (checkZoteroKey: two GETs) — what it may read decides `files`, and a library the
 *      key can no longer read is `library-gone` before any batch — and a batch is started: full until `fullDone`,
 *      with the link's options, `includeDeleted: false`, the default auto-accept threshold.
 *   6. The run waits for the batch, which ends through finishZoteroWebRun (Z2): the ONE function that records the
 *      library version, for started and resumed batches alike (R212, R214, R215). The runner records nothing in the
 *      library itself. `fullDone` becomes true only when this batch recorded a version after a full read
 *      (`recordedLibraryVersion` on its record: the key list was whole and nothing was held back).
 *   7. The record is finished: counts (zoteroSyncCounts; never in the device file for an encrypted project), refused
 *      host names, the back-off Zotero asked for, and the outcome:
 *        finished                 the batch finished, nothing failed, no refused host, no download to retry;
 *        finished-with-problems   the batch finished with failed items, refused hosts or downloads to retry;
 *        failed                   a refusal (1.), the cheap check or the key check failed, the scan failed (its
 *                                 failure item: offline, key-refused, library-gone, too-large, library-changing …),
 *                                 or anything threw (`error`); since and fullDone as they were;
 *        stopped                  aborted (`o.signal`: its reason when it is "app-closed" or "project-locked", else
 *                                 `stopped-by-you`), the batch suspended by someone else (closing the library:
 *                                 `app-closed`), the library closed under it, the project locked during it.
 *      `key-refused` pauses every link of the library; `library-gone` pauses this link only (a 403 on a group whose
 *      key is still accepted is `library-gone`).
 *
 * Back-off (R210; Global Constraints): `o.backoffUntil` (ms) is the caller's kept time. The clock rule: a back-off
 * ends at the EARLIER of the kept time and now + ZOTERO_SYNC_MAX_BACKOFF_MS (a day, the longest Zotero's wait is ever
 * kept, zotero-web.ts M6), so a clock put backwards can neither make the wait endless nor skip it (it is still
 * refused); the record carries the time actually in force, for the caller to keep in place of its own. After a run in
 * which Zotero asked for a wait (Backoff, Retry-After), the record carries the later of now + an hour and that wait.
 *
 * The key (R78) is read here once, to know that one is saved (getSecret, the value dropped at once); the requests
 * read it themselves (zotero-web-account.ts, zotero-web.ts). It is in no record, error, settings or log line.
 */
import { newId } from "@ao/core";
import type { Dispatcher } from "undici";
import { isClosed } from "../library.js";
import { ProjectLockedError } from "../repo/errors.js";
import { projectEncrypted, repoLibrary, type Repo } from "../repo/repo.js";
import { SecretStoreUnavailableError, getSecret } from "../secrets.js";
import { BOOKKEEPING, activeBatches, batchDirs, countOutcomes, findBatch, latestByKey, readBatchAt, readJournal, writeBatchRecord, type BatchRecord, type JournalEntry } from "./bulk/batch.js";
import { BatchRefusedError, REASONS as BULK_REASONS, isBatchActive, resumeBatch, startBatch, type BatchCounts, type BatchHandle, type BatchResult, type BulkImportDeps } from "./bulk/run.js";
import { ZoteroAccountError, checkZoteroKey, zoteroLibraryUnchanged, type ZoteroAccountReason } from "./zotero-web-account.js";
import { ZOTERO_WEB_FILE_NOTES, ZOTERO_WEB_NOTES, ZOTERO_WEB_REASONS, finishZoteroWebRun, zoteroWebAdapter, zoteroWebSince, type ZoteroWebAdapter } from "./zotero-web.js";
import {
  ZOTERO_REF,
  ZOTERO_SYNC_MAX_HOSTS,
  isZoteroSyncId,
  markZoteroSyncFullDone,
  setZoteroSyncUnfinished,
  pauseAllZoteroSyncLinks,
  pauseLink,
  putZoteroSyncRun,
  readZoteroSyncSettings,
  runningZoteroSyncRuns,
  type ZoteroSyncCounts,
  type ZoteroSyncFileOptions,
  type ZoteroSyncLink,
  type ZoteroSyncReason,
  type ZoteroSyncRun,
} from "./zotero-sync-settings.js";

/** After Zotero asks for a wait, no run starts before the later of now + this and Zotero's own time (Global Constraints). */
export const ZOTERO_SYNC_MIN_BACKOFF_MS = 60 * 60_000;
/** The longest back-off kept (as the scan keeps it): a back-off further ahead than this from now ends this far ahead. */
export const ZOTERO_SYNC_MAX_BACKOFF_MS = 24 * 3_600_000;

export interface ZoteroSyncDeps extends BulkImportDeps {
  /** This computer's settings folder (the two device files). */
  appConfigDir: string;
  libraryId: string;
  /** The batch, as soon as there is one (started or resumed): for progress, and for suspending it on close. */
  onBatch?(projectId: string, h: BatchHandle): void;
  /** Told when a device file's damaged content was set aside (the device notice belongs there). */
  onSetAside?: ZoteroSyncFileOptions["onSetAside"];
  /** Test seams: the dispatcher for every Zotero request, the waits, the clock (ms) for back-off and record times. */
  dispatcher?: Dispatcher;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ZoteroSyncOptions {
  trigger: "manual" | "automatic";
  /** Aborting stops the run (a batch is suspended, resumable). Abort with "app-closed", "library-closed" (R248) or "project-locked" to say why. */
  signal: AbortSignal;
  /** The back-off time the caller keeps (ms since the epoch), from the last record that carried one. */
  backoffUntil?: number;
}

/**
 * The run's numbers from the batch's counts (plan A8, A9), in this one place:
 *   new = created · changed = updated (an item counted once; a back that also changed is in updated, and in back) ·
 *   unchanged = unchanged · waiting = needsReview · conflicts = conflicts · goneMarked = goneInZotero (what THIS run
 *   marked, bin included; never goneAlready) · failed = failed · back = backInZotero · clearedKept = clearedInZoteroKept.
 * Not counted: duplicates, merged, deletedHere, goneAlready, goneNotMarked, collectionsRenamed (in the batch's report).
 */
export function zoteroSyncCounts(c: BatchCounts | ReturnType<typeof countOutcomes>): ZoteroSyncCounts {
  return {
    new: c.created,
    changed: c.updated,
    unchanged: c.unchanged,
    waiting: c.needsReview,
    conflicts: c.conflicts,
    goneMarked: c.goneInZotero,
    failed: c.failed,
    back: c.backInZotero,
    clearedKept: c.clearedInZoteroKept,
  };
}

/** The scan's own failure item (zotero-web.ts `fail`): one journal line with this key and outcome `failed`. */
const SCAN_FAILURE_KEY = "zotero-web:";

function batchCountsOf(lines: Iterable<JournalEntry>): { counts: ZoteroSyncCounts; scanFailure?: string; retryDownloads: boolean } {
  const latest = [...latestByKey([...lines]).values()];
  const scan = latest.find((e) => e.key === SCAN_FAILURE_KEY && e.outcome === "failed");
  const counts = zoteroSyncCounts(countOutcomes(latest));
  // The scan's failure is the run's reason, not an item that could not be brought in.
  if (scan) counts.failed = Math.max(0, counts.failed - 1);
  const retry = new Set<string>([ZOTERO_WEB_FILE_NOTES.failed, ZOTERO_WEB_FILE_NOTES.noSpace]);
  return { counts, ...(scan ? { scanFailure: scan.reason ?? "" } : {}), retryDownloads: latest.some((e) => e.notes?.some((n) => retry.has(n))) };
}

/**
 * A run's counts read from its batch (every part of it), for a caller that needs them for an encrypted project:
 * they are never in the device file. Undefined when the batch cannot be read (the project is locked, the batch gone).
 */
export async function zoteroSyncRunCounts(repo: Repo, projectId: string, batchId: string): Promise<ZoteroSyncCounts | undefined> {
  try {
    if (projectEncrypted(repo, projectId) && !repo.isUnlocked(projectId)) return undefined;
    const rec = await findBatch(repo, projectId, batchId);
    if (!rec) return undefined;
    return batchCountsOf(await readJournal(repo, projectId, rec.dir)).counts;
  } catch {
    return undefined;
  }
}

/** Runs of this runner going on in this process, by library and Zotero library (one project per Zotero library). */
const running = new Set<string>();
const lockKey = (libraryId: string, ref: string) => `${libraryId}\u0000${ref}`;

/** Whether this runner is syncing `ref` of the library now (in this process). */
export function zoteroSyncRunning(libraryId: string, ref: string): boolean {
  return running.has(lockKey(libraryId, ref));
}

/** The Zotero Web batches of `ref` in the project, newest first (records that cannot be read are left out). */
async function webBatches(repo: Repo, projectId: string, ref: string): Promise<BatchRecord[]> {
  const out: BatchRecord[] = [];
  for (const d of (await batchDirs(repo, projectId)).reverse()) {
    try {
      const r = await readBatchAt(repo, projectId, d.name);
      if (r?.source.kind === "zotero-web" && r.source.location === ref) out.push(r);
    } catch {
      // unreadable: not provably of this library
    }
  }
  return out;
}

/**
 * Whether an import of the Zotero library `ref` runs in the project now, whoever started it (the sync, or the import
 * wizard): the import route should refuse a manual Zotero Web import while this is true (Z8; see the report).
 */
export async function zoteroImportRunning(repo: Repo, projectId: string, ref: string): Promise<boolean> {
  if (!activeBatches.size) return false;
  return (await webBatches(repo, projectId, ref)).some((r) => isBatchActive(r.id));
}

/** The back-off in force at `now` (ms), by the clock rule in the header; undefined when none is. */
export function zoteroSyncBackoff(backoffUntil: number | undefined, now: number): number | undefined {
  if (backoffUntil === undefined || !Number.isFinite(backoffUntil)) return undefined;
  const until = Math.min(backoffUntil, now + ZOTERO_SYNC_MAX_BACKOFF_MS);
  return now < until ? until : undefined;
}

/** What Zotero asked for in this run, as the record keeps it: at least an hour, at most a day, from now. */
const askedBackoff = (asked: number | undefined, now: number): number | undefined =>
  asked === undefined ? undefined : Math.min(Math.max(asked, now + ZOTERO_SYNC_MIN_BACKOFF_MS), now + ZOTERO_SYNC_MAX_BACKOFF_MS);

const STOP_REASONS: readonly ZoteroSyncReason[] = ["stopped-by-you", "app-closed", "library-closed", "project-locked"];
const stopReason = (signal: AbortSignal): ZoteroSyncReason => (typeof signal.reason === "string" && STOP_REASONS.includes(signal.reason as ZoteroSyncReason) ? (signal.reason as ZoteroSyncReason) : "stopped-by-you");

const ACCOUNT_REASON: Record<ZoteroAccountReason, ZoteroSyncReason> = {
  "no-key": "key-missing",
  "no-store": "no-store",
  "key-refused": "key-refused",
  "library-gone": "library-gone",
  offline: "offline",
  "backing-off": "backing-off",
};

/** The scan's failure sentence (ZOTERO_WEB_REASONS) as a reason. */
function scanReason(sentence: string): ZoteroSyncReason {
  switch (sentence) {
    case ZOTERO_WEB_REASONS.noKey:
      return "key-missing";
    case ZOTERO_WEB_REASONS.noStore:
      return "no-store";
    case ZOTERO_WEB_REASONS.keyRefused:
      return "key-refused";
    case ZOTERO_WEB_REASONS.notFound:
      return "library-gone";
    case ZOTERO_WEB_REASONS.unavailable:
      return "offline";
    case ZOTERO_WEB_REASONS.tooLarge:
      return "too-large";
    case ZOTERO_WEB_REASONS.changing:
      return "library-changing";
    default:
      return "zotero-error";
  }
}

/** The run ends here: `outcome`, `reason`, and what else the record holds. */
class Ending extends Error {
  constructor(
    readonly outcome: ZoteroSyncRun["outcome"],
    readonly reason?: ZoteroSyncReason,
    readonly backoffUntil?: number,
  ) {
    super(reason ?? outcome);
  }
}

const isAbort = (err: unknown, signal: AbortSignal) => signal.aborted || (err as Error | undefined)?.name === "AbortError";

/** Batch states this runner resumes ("interrupted" is `running` with no process running it). */
const UNFINISHED = new Set<BatchRecord["state"]>(["running", "paused", "cancelled", "failed"]);

/** The note written into a batch the runner ended because it could never be resumed (R244 b). */
export const ZOTERO_SYNC_ENDED_NOTE = "This sync could not be resumed, so it was ended here; what it brought in stays. The next sync reads the whole Zotero library again.";

/**
 * Whether a refusal to resume this link's own batch means it can NEVER be resumed (R244 b, made certain by R246 b).
 * Only two errors, by type, and only when certain to repeat:
 *   - `BatchRefusedError` of kind `invalid` — the engine read the record and refuses it as unusable (a fieldwork
 *     session or participant it links to was deleted, the source cannot be rebuilt) — EXCEPT the unreadable record of
 *     sources deleted here, which every Zotero batch meets alike and the researcher can reset;
 *   - `NotFoundError` — and only when the batch's folder is really absent from the project's imports (`gone`). The
 *     engine reports any record it could not read as "not found" (a project locked at that moment, a busy file, a
 *     passing I/O error), so a folder still there is a passing failure.
 * Everything else leaves the batch to be resumed later: kinds `locked`, `running`, `denied` (the project's rules,
 * which the researcher may change back) and `finished`, and every failure that is not a refusal. In doubt: resumable.
 */
function neverResumable(err: unknown, gone: boolean): boolean {
  if ((err as Error | undefined)?.name === "NotFoundError") return gone;
  return err instanceof BatchRefusedError && err.kind === "invalid" && err.reason !== BULK_REASONS.deletedRecordsUnreadable;
}

/**
 * One sync of `link` (see the header). Never throws for anything that can go wrong in a run: every ending is a record,
 * returned in the form it is kept in this computer's history (R244 M2). A record the history file cannot take, even on
 * a second try, is returned with `recordSaved: false` and a debug note (R244 M3).
 */
export async function syncZoteroLibrary(deps: ZoteroSyncDeps, link: ZoteroSyncLink, o: ZoteroSyncOptions): Promise<ZoteroSyncRun> {
  const now = () => (deps.now ? deps.now() : Date.now());
  const iso = (ms: number) => new Date(ms).toISOString();
  const debugName = (err: unknown) => (err instanceof Error ? err.name : "error");
  // A damaged history file is set aside with a debug note only (R242); the settings file raises its device notice itself.
  const fileOpts: ZoteroSyncFileOptions = {
    onSetAside: (file, keptAs) => {
      deps.debug?.(`zotero sync: the damaged file ${file} was set aside`);
      deps.onSetAside?.(file, keptAs);
    },
  };
  const run: ZoteroSyncRun = { id: newId(), ref: link.ref, projectId: link.projectId, trigger: o.trigger, startedAt: iso(now()), outcome: "stopped", reason: "app-closed" };
  // M2: ids are checked once, here. A link that cannot make a valid record is refused before anything else (no
  // request, no lock, no file), and its record says it was not saved.
  if (!ZOTERO_REF.test(link.ref) || !isZoteroSyncId(link.projectId) || (o.trigger !== "manual" && o.trigger !== "automatic")) {
    deps.debug?.("zotero sync: a run was refused: its link is not valid, so no record of it could be kept");
    return { ...run, ref: String(link.ref), projectId: String(link.projectId), outcome: "failed", reason: "error", finishedAt: run.startedAt, recordSaved: false };
  }
  // The runner's own lock, taken before anything is awaited: two calls at the same moment are one run and one refusal.
  const key = lockKey(deps.libraryId, link.ref);
  const busy = running.has(key);
  if (!busy) running.add(key);
  const encrypted = (() => {
    try {
      return projectEncrypted(deps.repo, link.projectId);
    } catch {
      return false;
    }
  })();
  /** Saves the record as it is returned; `tries` 2 for the final one (M3). */
  const save = async (tries = 1): Promise<boolean> => {
    for (let t = 1; t <= tries; t++) {
      try {
        await putZoteroSyncRun(deps.appConfigDir, deps.libraryId, run, fileOpts);
        return true;
      } catch (err) {
        if (t === tries) deps.debug?.(`zotero sync: the run's record could not be saved (${debugName(err)})`);
      }
    }
    return false;
  };
  /** The runner's own changes to its stored link; a settings file that cannot take them leaves a debug note only. */
  const settingsChange = async (what: string, change: () => Promise<void>) => {
    try {
      await change();
    } catch (err) {
      deps.debug?.(`zotero sync: ${what} could not be saved (${debugName(err)})`);
    }
  };
  let started = false;
  /** The stored link (the settings file's own copy), when there is one: it wins over the caller's copy (M1). */
  let stored: ZoteroSyncLink | undefined;
  let handle: BatchHandle | undefined;
  let scanResult: (() => ReturnType<ZoteroWebAdapter["scanResult"]>) | undefined;
  /** The latest moment Zotero asked to wait for, from any answer of this run (M5). */
  let asked: number | undefined;
  const ask = (until: number | undefined) => {
    if (until !== undefined) asked = Math.max(asked ?? 0, until);
  };
  const onAbort = () => void handle?.suspend().catch(() => {});
  const setHint = (hint: string | undefined) =>
    stored ? settingsChange("the batch hint", () => setZoteroSyncUnfinished(deps.appConfigDir, deps.libraryId, link.ref, link.projectId, hint, fileOpts)) : Promise.resolve();
  const setFullDone = (done: boolean) => settingsChange("fullDone", () => markZoteroSyncFullDone(deps.appConfigDir, deps.libraryId, link.ref, link.projectId, fileOpts, done));
  const hintOf = (r: BatchRecord) => `${r.dir.split("/").pop()}/${r.id}`;
  try {
    const checkStop = () => {
      if (o.signal.aborted) throw new Ending("stopped", stopReason(o.signal));
    };
    checkStop();
    // 1. Refusals, in order, before any request.
    const libState = repoLibrary(deps.repo);
    if (libState.mode !== "read-write" || isClosed(libState)) throw new Ending("failed", "library-read-only");
    try {
      deps.repo.getProject(link.projectId);
    } catch {
      throw new Ending("failed", "error");
    }
    if (encrypted && !deps.repo.isUnlocked(link.projectId)) throw new Ending("failed", "project-locked");
    let settingsReadable = true;
    try {
      const s = await readZoteroSyncSettings(deps.appConfigDir, deps.libraryId, fileOpts);
      stored = s.links.find((l) => l.ref === link.ref && l.projectId === link.projectId);
    } catch {
      settingsReadable = false; // the caller's copy of the link stands
    }
    const current = stored ?? link;
    checkStop();
    // M1: the stored link's pause, or its absence, is what counts; the caller's copy only when nothing is stored.
    const paused = current.paused;
    if (paused) throw new Ending("failed", paused === "undone" ? "sync-undone" : paused);
    if (busy || (await zoteroImportRunning(deps.repo, link.projectId, link.ref))) throw new Ending("failed", "import-running");
    checkStop();
    const waitUntil = zoteroSyncBackoff(o.backoffUntil, now());
    if (waitUntil !== undefined) throw new Ending("failed", "backing-off", waitUntil);
    try {
      // Only whether a key is saved: the value is dropped at once.
      let k: string | null = await getSecret("zotero-api-key");
      const has = !!k;
      k = null;
      if (!has) throw new Ending("failed", "key-missing");
    } catch (err) {
      if (err instanceof Ending) throw err;
      throw new Ending("failed", err instanceof SecretStoreUnavailableError ? "no-store" : "error");
    }
    checkStop();

    // 2. Started.
    runningZoteroSyncRuns.add(run.id);
    started = true;
    await save();
    checkStop();

    const [type, id] = link.ref.split(":") as ["user" | "group", string];
    const seams = { ...(deps.dispatcher ? { dispatcher: deps.dispatcher } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) };
    /**
     * Zotero refused a request for a GROUP: the key is asked about once more; a key Zotero still accepts makes it this
     * group gone (`library-gone`, this link paused), not the key (`key-refused`, every link paused).
     */
    const refusedFor = async (): Promise<ZoteroSyncReason> => {
      if (type !== "group") return "key-refused";
      try {
        await checkZoteroKey({ signal: o.signal, ...seams });
        return "library-gone";
      } catch (err) {
        if (isAbort(err, o.signal)) throw new Ending("stopped", stopReason(o.signal));
        return err instanceof ZoteroAccountError && err.reason === "key-refused" ? "key-refused" : "library-gone";
      }
    };
    const accountCall = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        if (isAbort(err, o.signal)) throw new Ending("stopped", stopReason(o.signal));
        if (!(err instanceof ZoteroAccountError)) throw err;
        ask(err.backoffUntil);
        const reason = err.reason === "key-refused" ? await refusedFor() : ACCOUNT_REASON[err.reason];
        throw new Ending("failed", reason);
      }
    };

    // 3. This link's own unfinished batch (M9): by the stored hint when there is one; no hint on a stored link means
    // none (the hint is written before every batch is started, and cleared only when the batch ended for good); the
    // scan of the project's batch records only when the hint is `unknown`, wrong, or there is no stored link.
    const isOwnUnfinished = (r: BatchRecord | undefined): r is BatchRecord =>
      !!r && r.origin === "zotero-sync" && r.source.kind === "zotero-web" && r.source.location === link.ref && !isBatchActive(r.id) && UNFINISHED.has(r.state);
    let own: BatchRecord | undefined;
    let scan = !stored;
    if (stored?.unfinished && stored.unfinished !== "unknown") {
      const [dirName, batchId] = stored.unfinished.split("/") as [string, string];
      const r = await readBatchAt(deps.repo, link.projectId, dirName).catch(() => undefined);
      if (r?.id === batchId && isOwnUnfinished(r)) own = r;
      else if (r?.id === batchId && r.origin === "zotero-sync" && (r.state === "finished" || r.state === "undone")) await setHint(undefined);
      else scan = true;
    } else if (stored?.unfinished === "unknown") scan = true;
    if (scan) {
      own = (await webBatches(deps.repo, link.projectId, link.ref)).find(isOwnUnfinished);
      if (stored) await setHint(own ? hintOf(own) : undefined);
    }
    checkStop();
    let full = false;
    if (own) {
      const ro = own.adapterOptions;
      const since = Number.isInteger(ro?.zoteroSince) && ro!.zoteroSince! >= 0 ? ro!.zoteroSince : undefined;
      full = since === undefined;
      // As zoteroWebAdapterFor builds it (the options it started with, the versions its parts read at), with the seams.
      const adapter = zoteroWebAdapter({ libraryType: type, libraryId: id, ...(since !== undefined ? { since } : {}), ...(ro?.zoteroFiles === false ? { files: false } : {}), ...seams });
      const read = ro?.zoteroReadVersions;
      if (Array.isArray(read) && read.length && read.every((v) => Number.isInteger(v) && v >= 0)) adapter.resumeOptions!.zoteroReadVersions = [...read];
      else delete adapter.resumeOptions!.zoteroReadVersions;
      run.batchId = own.id;
      let resumed: BatchHandle;
      try {
        resumed = await resumeBatch(deps, link.projectId, own.id, adapter);
      } catch (err) {
        // The batch's folder, by name only (no record is read): is it really gone?
        const dirName = own.dir.split("/").pop();
        const gone = !(await batchDirs(deps.repo, link.projectId).catch(() => [{ name: dirName }])).some((d) => d.name === dirName);
        if (!neverResumable(err, gone)) {
          // A passing failure: the batch, its hint and fullDone stay; the run says the true reason (R246 b).
          if (encrypted && !deps.repo.isUnlocked(link.projectId)) throw new Ending("failed", "project-locked");
          throw err;
        }
        // R244 b: ended for good through the batch's own record (the engine's terminal state; nothing undone), the hint
        // cleared and the next run a fresh full one.
        const sentence = err instanceof BatchRefusedError ? err.reason : "The batch could not be found.";
        const cur = await findBatch(deps.repo, link.projectId, own.id).catch(() => undefined);
        if (cur) {
          const projectRel = deps.repo.getProject(link.projectId).folder;
          await deps.repo.mutate(
            link.projectId,
            BOOKKEEPING,
            (tx) => writeBatchRecord(tx, projectRel, { ...cur, state: "finished", finishedAt: iso(Math.max(now(), Date.parse(cur.startedAt) || 0)), notes: [...cur.notes, ZOTERO_SYNC_ENDED_NOTE] }),
            { op: "import.batch.save" },
          );
        }
        await setHint(undefined);
        await setFullDone(false);
        run.note = sentence.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 500);
        throw new Ending("failed", "batch-ended");
      }
      handle = finishZoteroWebRun(deps, link.projectId, adapter, resumed, since);
      scanResult = () => adapter.scanResult();
    } else {
      // 4. The cheap question, when there is a version to ask about and a full run has been done.
      const since = zoteroWebSince(deps.repo, link.projectId, link.ref);
      if (current.fullDone && since !== undefined) {
        const u = await accountCall(() => zoteroLibraryUnchanged({ ref: link.ref, since, signal: o.signal, ...seams }));
        ask(u.backoffUntil);
        if (u.unchanged) throw new Ending("up-to-date");
      }
      checkStop();
      // 5. What the key may read, then the batch.
      const access = await accountCall(() => checkZoteroKey({ signal: o.signal, ...seams }));
      ask(access.backoffUntil);
      const readable = type === "user" ? access.userId === id && access.personal.library : access.groups.some((g) => g.ref === link.ref);
      if (!readable) throw new Ending("failed", "library-gone");
      checkStop();
      full = !current.fullDone || since === undefined;
      const adapter = zoteroWebAdapter({
        libraryType: type,
        libraryId: id,
        ...(full ? {} : { since }),
        files: type === "user" ? access.personal.files : true,
        ...seams,
      });
      const options = { structure: current.options.structure, duplicates: current.options.duplicates, includeDeleted: false };
      // The hint first (M9): a batch may exist only while the stored link says one may.
      await setHint("unknown");
      handle = finishZoteroWebRun(deps, link.projectId, adapter, await startBatch(deps, link.projectId, adapter, options, { origin: "zotero-sync" }), full ? undefined : since);
      scanResult = () => adapter.scanResult();
    }
    run.batchId = handle.batchId;
    o.signal.addEventListener("abort", onAbort, { once: true });
    if (o.signal.aborted) onAbort();
    try {
      deps.onBatch?.(link.projectId, handle);
    } catch {
      // the caller's own trouble: the run goes on
    }
    if (!own) {
      const made = await findBatch(deps.repo, link.projectId, handle.batchId).catch(() => undefined);
      if (made) await setHint(hintOf(made));
    }
    await save();

    // 6. Wait for it (since is recorded, or not, inside finishZoteroWebRun before `done` settles).
    const result: BatchResult = await handle.done;
    const sr = scanResult();
    ask(sr.backoffUntil);
    const rec = await findBatch(deps.repo, link.projectId, result.batchId).catch(() => undefined);
    if (result.state === "finished") await setHint(undefined);
    let detail: ReturnType<typeof batchCountsOf> = { counts: zoteroSyncCounts(result.counts), retryDownloads: false };
    try {
      if (rec) detail = batchCountsOf(await readJournal(deps.repo, link.projectId, rec.dir));
    } catch {
      // the journal cannot be read (the project locked under it): the run's own counts stand
    }
    // Never in the device file for an encrypted project, and the record is returned as it is kept (M2, Accept 4).
    if (!encrypted) run.counts = detail.counts;
    // Host names only, in the form the history file accepts (one odd name must not make the record unsaveable).
    const hosts = sr.refusedHosts.filter((h) => /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(h)).slice(0, ZOTERO_SYNC_MAX_HOSTS);
    if (hosts.length) run.refusedHosts = hosts;
    const closed = isClosed(repoLibrary(deps.repo));
    if (result.state === "paused" || result.state === "cancelled") {
      throw new Ending("stopped", o.signal.aborted ? stopReason(o.signal) : result.state === "paused" ? "app-closed" : "stopped-by-you");
    }
    if (result.state === "failed") {
      if (closed) throw new Ending("stopped", "app-closed");
      if (o.signal.aborted) throw new Ending("stopped", stopReason(o.signal));
      const locked = (encrypted && !deps.repo.isUnlocked(link.projectId)) || rec?.notes.some((n) => /project was locked/u.test(n));
      throw new Ending(locked ? "stopped" : "failed", locked ? "project-locked" : "error");
    }
    if (result.state !== "finished") throw new Ending("failed", "error");
    if (detail.scanFailure !== undefined) {
      const reason = scanReason(detail.scanFailure);
      throw new Ending("failed", reason === "key-refused" ? await refusedFor() : reason);
    }
    // R244 a (A7, R214, R215): the scan did not see the whole picture — the batch's own note (a full run whose key list
    // was not whole) or the scan's own flag (a listing cut, moved or short of its total). The version was not recorded
    // (finishZoteroWebRun keeps that rule), so the next run asks again.
    if (rec?.notes.includes(ZOTERO_WEB_NOTES.notConfirmed) || !sr.completed) {
      // R246 a: an INCREMENTAL run leaves fullDone and since as they were — the next incremental run asks again for
      // everything since the same version, deletions included; a full read would add nothing. Only a FULL run that
      // could not see the whole picture is `deletions-unconfirmed` (fullDone false: the next run reads it all again).
      if (!full) throw new Ending("finished-with-problems", "changes-incomplete");
      if (settingsReadable) await setFullDone(false);
      throw new Ending("finished-with-problems", "deletions-unconfirmed");
    }
    // A full run truly finished: this batch recorded a version (the key list was whole, nothing held back).
    if (full && rec?.recordedLibraryVersion !== undefined && settingsReadable) await setFullDone(true);
    const problems = detail.counts.failed > 0 || hosts.length > 0 || sr.downloadsFailed > 0 || detail.retryDownloads;
    throw new Ending(problems ? "finished-with-problems" : "finished");
  } catch (err) {
    let end: Ending;
    if (err instanceof Ending) end = err;
    else if (isAbort(err, o.signal)) end = new Ending("stopped", stopReason(o.signal));
    else if (err instanceof BatchRefusedError) end = new Ending("failed", err.kind === "locked" ? "project-locked" : err.kind === "running" ? "import-running" : "error");
    else if (err instanceof ProjectLockedError) end = new Ending("failed", "project-locked");
    else {
      deps.debug?.(`zotero sync: the run stopped on an unexpected error (${debugName(err)})`);
      end = new Ending("failed", "error");
    }
    run.outcome = end.outcome;
    if (end.reason) run.reason = end.reason;
    else delete run.reason;
    // The back-off in force after this run: a refusal inside one carries its time; otherwise what Zotero asked for.
    const until = end.reason === "backing-off" && end.backoffUntil !== undefined ? end.backoffUntil : askedBackoff(asked, now());
    if (until !== undefined) run.backoffUntil = iso(until);
    run.finishedAt = iso(Math.max(now(), Date.parse(run.startedAt)));
    // Pauses (Accept 3): a refused key pauses every link of the library; a library gone, this link. Not for a refusal
    // that only read a pause already there.
    if (started && run.reason === "key-refused") await settingsChange("the pause", () => pauseAllZoteroSyncLinks(deps.appConfigDir, deps.libraryId, fileOpts));
    if (started && run.reason === "library-gone") await settingsChange("the pause", () => pauseLink(deps.appConfigDir, deps.libraryId, link.ref, "library-gone", fileOpts));
    const saved = await save(2);
    // M3: a record the history could not take says so; the started record on disk then reads stopped / app-closed
    // in every later read (this run no longer runs), which says less than happened, never more.
    return saved ? structuredClone(run) : { ...structuredClone(run), recordSaved: false };
  } finally {
    o.signal.removeEventListener("abort", onAbort);
    runningZoteroSyncRuns.delete(run.id);
    if (!busy) running.delete(key);
  }
}

export type { ZoteroSyncCounts, ZoteroSyncLink, ZoteroSyncReason, ZoteroSyncRun };
