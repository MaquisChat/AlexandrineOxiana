/**
 * The download runs of whole-channel capture (R668, R669), written to the project's job journal (R31).
 *
 * - A run is one `capture.run` record (id: the run id) and one `capture.item` record per video or post (id
 *   `<runId>/<index>`). Like every journal line they are sealed in an encrypted project, hold no secret
 *   (`assertNoSecrets`) and no absolute path, and are appended durably. They are not policy-governed changes
 *   (as the worker's own records are not): what they lead to, each stored video, is governed and audited.
 * - The run's counters (`total`, `done`, `failed`) are worked out from its items whenever an item changes, so a
 *   record written twice is counted once.
 * - The run's record status follows its state: `running` while downloading or waiting, `done` when finished
 *   with no failure, `cancelled` with error DISCARDED once discarded, `queued` otherwise. Compaction keeps a
 *   run's items while the run is neither done nor discarded, and a run that is neither discarded nor finished with
 *   nothing left to do whatever the caps (job-journal.ts, R676).
 * - A run or item an older build claimed as failed UNRECOVERABLE with its `attempt` mark (R672, I4, R676:
 *   `claimedByOlderBuild`) is read as it was: the run with the record status its state gives, the item as queued
 *   (not completed). An item that carries its own failure (`item.errorCode`) stays failed.
 *
 * Every function finds the library root, the project's folder and its key from the repo (ProjectLockedError
 * while the project is locked); every write throws ReadOnlyLibraryError on a read-only library.
 */
import {
  DISCARDED_CODE, assertNoSecrets, claimedByOlderBuild, errorCode, readJobJournal, updateJobRecords,
  type CaptureItemData, type CaptureRunData, type JobRecord, type JobStatus, type ProjectKey,
} from "../job-journal.js";
import { NotFoundError, ReadOnlyLibraryError } from "../repo/errors.js";
import { projectDataKey, repoClock, repoLibrary, type Repo } from "../repo/repo.js";

export interface RunView {
  runId: string;
  record: JobRecord & { run: CaptureRunData };
}

export interface RunItemView {
  id: string;
  status: JobStatus;
  item: CaptureItemData;
}

const RUN_KIND = "capture.run";
const ITEM_KIND = "capture.item";

interface Place {
  root: string;
  folder: string;
  key: ProjectKey;
}

function place(repo: Repo, projectId: string): Place {
  const root = repoLibrary(repo).root;
  const folder = repo.getProject(projectId).folder;
  return { root, folder, key: projectDataKey(repo, projectId) };
}

function writable(repo: Repo, projectId: string): Place {
  const library = repoLibrary(repo);
  if (library.mode !== "read-write") throw new ReadOnlyLibraryError(library.readOnlyReason);
  return place(repo, projectId);
}

const isRun = (r: JobRecord | undefined): r is JobRecord & { run: CaptureRunData } => !!r && r.kind === RUN_KIND && !!r.run;
const isDiscarded = (r: JobRecord) => r.status === "cancelled" && r.error === DISCARDED_CODE;

/** The records with what an older build claimed read as it was (see the module comment). */
function repaired(records: ReadonlyMap<string, JobRecord>): Map<string, JobRecord> {
  const out = new Map(records);
  for (const r of records.values()) {
    if (!claimedByOlderBuild(r)) continue;
    const { error: _error, attempt: _attempt, ...base } = r;
    if (r.kind === RUN_KIND && r.run) out.set(r.id, { ...base, status: runStatus(r.run.state, r.run.failed) });
    else if (r.kind === ITEM_KIND && r.item && r.item.errorCode === undefined) out.set(r.id, { ...base, status: "queued" });
  }
  return out;
}

/** The record status of a run in `state` with `failed` failures (see the module comment). */
function runStatus(state: CaptureRunData["state"], failed: number): JobStatus {
  if (state === "downloading" || state === "waiting") return "running";
  if (state === "finished" && failed === 0) return "done";
  return "queued";
}

function itemsOf(records: ReadonlyMap<string, JobRecord>, runId: string): Array<JobRecord & { item: CaptureItemData }> {
  return [...records.values()]
    .filter((r): r is JobRecord & { item: CaptureItemData } => r.kind === ITEM_KIND && !!r.item && r.item.runId === runId)
    .sort((a, b) => a.item.index - b.item.index);
}

/** The run's live record, or NotFoundError (absent or discarded). */
function liveRun(records: ReadonlyMap<string, JobRecord>, runId: string): JobRecord & { run: CaptureRunData } {
  const r = records.get(runId);
  if (!isRun(r) || isDiscarded(r)) throw new NotFoundError("Download run", runId);
  return r;
}

/** The run's record again with its counters worked out from `items` (the newest record of each). */
function recount(run: JobRecord & { run: CaptureRunData }, items: Array<JobRecord & { item: CaptureItemData }>, at: string): JobRecord & { run: CaptureRunData } {
  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const data: CaptureRunData = { ...run.run, total: items.length, done, failed };
  return { ...run, status: isDiscarded(run) ? run.status : runStatus(data.state, failed), updatedAt: at, run: data };
}

function view(raw: ReadonlyMap<string, JobRecord>, runId: string): RunView {
  const r = repaired(raw).get(runId);
  if (!isRun(r)) throw new NotFoundError("Download run", runId);
  return { runId, record: r };
}

/** A run's items with `changed` (by id) in place of their older records. */
function merged(records: ReadonlyMap<string, JobRecord>, runId: string, changed: JobRecord[]): Array<JobRecord & { item: CaptureItemData }> {
  const byId = new Map(changed.map((c) => [c.id, c]));
  const old = itemsOf(records, runId).map((i) => (byId.get(i.id) as (JobRecord & { item: CaptureItemData }) | undefined) ?? i);
  const added = changed.filter((c): c is JobRecord & { item: CaptureItemData } => c.kind === ITEM_KIND && !!c.item && !records.has(c.id));
  return [...old, ...added].sort((a, b) => a.item.index - b.item.index);
}

/** Writes a new run, state `queued` with no items. The id must be new. */
export async function createRun(repo: Repo, projectId: string, runId: string, data: Omit<CaptureRunData, "state" | "total" | "done" | "failed">): Promise<RunView> {
  const p = writable(repo, projectId);
  assertNoSecrets(data.options, "options");
  const records = await updateJobRecords(p.root, p.folder, projectId, p.key, (raw) => {
    const records = repaired(raw);
    if (records.has(runId)) throw new TypeError(`the run id ${runId} is already in the journal`);
    // A run started later is always newer, even within one millisecond: `readRuns` orders by it.
    const newest = Math.max(0, ...[...records.values()].filter((r) => r.kind === RUN_KIND).map((r) => Date.parse(r.createdAt) || 0));
    const at = new Date(Math.max(repoClock(repo)().getTime(), newest + 1)).toISOString();
    const run: CaptureRunData = { ...data, state: "queued", total: 0, done: 0, failed: 0 };
    return [{ v: 1, id: runId, projectId, kind: RUN_KIND, status: "queued", createdAt: at, updatedAt: at, run }];
  });
  return view(records, runId);
}

/**
 * Writes the run's list of videos: an item not listed yet is added after the others (queued); an item already
 * listed (by post id) keeps its record as it is. The counters follow.
 */
export async function setRunItems(
  repo: Repo,
  projectId: string,
  runId: string,
  items: Array<Pick<CaptureItemData, "postId" | "url" | "title" | "durationSec">>,
): Promise<RunView> {
  const p = writable(repo, projectId);
  const records = await updateJobRecords(p.root, p.folder, projectId, p.key, (raw) => {
    const records = repaired(raw);
    const run = liveRun(records, runId);
    const existing = itemsOf(records, runId);
    const known = new Set(existing.map((i) => i.item.postId));
    let next = existing.reduce((m, i) => Math.max(m, i.item.index + 1), 0);
    const at = repoClock(repo)().toISOString();
    const added: JobRecord[] = [];
    for (const it of items) {
      if (known.has(it.postId)) continue;
      known.add(it.postId);
      const index = next++;
      const item: CaptureItemData = {
        runId, index, postId: it.postId, url: it.url,
        ...(it.title !== undefined ? { title: it.title } : {}),
        ...(typeof it.durationSec === "number" && Number.isFinite(it.durationSec) && it.durationSec > 0 ? { durationSec: it.durationSec } : {}),
      };
      added.push({ v: 1, id: `${runId}/${index}`, projectId, kind: ITEM_KIND, status: "queued", createdAt: at, updatedAt: at, item });
    }
    return [...added, recount(run, merged(records, runId, added), at)];
  });
  return view(records, runId);
}

/** Records what happened to one video of the run (found by its post id); the counters follow. */
export async function recordRunItem(
  repo: Repo,
  projectId: string,
  runId: string,
  postId: string,
  next: { status: "running" } | { status: "queued" } | { status: "done"; sourceId?: string } | { status: "failed"; errorCode: string; platformReason?: string },
): Promise<RunView> {
  const p = writable(repo, projectId);
  const records = await updateJobRecords(p.root, p.folder, projectId, p.key, (raw) => {
    const records = repaired(raw);
    const run = liveRun(records, runId);
    const old = itemsOf(records, runId).find((i) => i.item.postId === postId);
    if (!old) throw new NotFoundError("Item of download run", runId); // never the post id (R672)
    const at = repoClock(repo)().toISOString();
    const { errorCode: _code, platformReason: _reason, ...rest } = old.item;
    const { error: _error, ...base } = old;
    let rec: JobRecord;
    if (next.status === "failed") {
      const code = errorCode(next.errorCode);
      rec = { ...base, status: "failed", updatedAt: at, error: code, item: { ...rest, errorCode: code, ...(next.platformReason !== undefined ? { platformReason: next.platformReason } : {}) } };
    } else if (next.status === "done") {
      rec = { ...base, status: "done", updatedAt: at, item: { ...rest, ...(next.sourceId !== undefined ? { sourceId: next.sourceId } : {}) } };
    } else {
      rec = { ...base, status: next.status, updatedAt: at, item: rest };
    }
    return [rec, recount(run, merged(records, runId, [rec]), at)];
  });
  return view(records, runId);
}

/** Puts every failed item of the run back to be tried again (queued, its error gone); `failed` becomes 0. */
export async function requeueFailedItems(repo: Repo, projectId: string, runId: string): Promise<RunView> {
  const p = writable(repo, projectId);
  const records = await updateJobRecords(p.root, p.folder, projectId, p.key, (raw) => {
    const records = repaired(raw);
    const run = liveRun(records, runId);
    const at = repoClock(repo)().toISOString();
    const back: JobRecord[] = itemsOf(records, runId)
      .filter((i) => i.status === "failed")
      .map((i) => {
        const { errorCode: _code, platformReason: _reason, ...item } = i.item;
        const { error: _error, ...base } = i;
        return { ...base, status: "queued" as const, updatedAt: at, item };
      });
    return [...back, recount(run, merged(records, runId, back), at)];
  });
  return view(records, runId);
}

/**
 * Sets the run's state. `wait`, `tool`, `errorCode` and `reason` are those given now: one not given is
 * cleared (a run downloading again has no wait).
 */
export async function setRunState(
  repo: Repo,
  projectId: string,
  runId: string,
  state: CaptureRunData["state"],
  extra: { wait?: CaptureRunData["wait"]; tool?: string; errorCode?: string; reason?: string } = {},
): Promise<RunView> {
  const p = writable(repo, projectId);
  const records = await updateJobRecords(p.root, p.folder, projectId, p.key, (raw) => {
    const records = repaired(raw);
    const run = liveRun(records, runId);
    const at = repoClock(repo)().toISOString();
    const { wait: _w, tool: _t, errorCode: _c, reason: _r, ...rest } = run.run;
    // The counters are worked out from the items here too (R672: a torn final append leaves them stale).
    const data: CaptureRunData = {
      ...rest,
      state,
      ...(extra.wait !== undefined ? { wait: { ms: extra.wait.ms, why: extra.wait.why } } : {}),
      ...(extra.tool !== undefined ? { tool: extra.tool } : {}),
      ...(extra.errorCode !== undefined ? { errorCode: errorCode(extra.errorCode) } : {}),
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    };
    return [recount({ ...run, run: data }, itemsOf(records, runId), at)];
  });
  return view(records, runId);
}

/** Sets the run's title (the listing's title once it is read); its state and the rest are kept, the counters follow. */
export async function setRunTitle(repo: Repo, projectId: string, runId: string, title: string): Promise<RunView> {
  const p = writable(repo, projectId);
  const records = await updateJobRecords(p.root, p.folder, projectId, p.key, (raw) => {
    const records = repaired(raw);
    const run = liveRun(records, runId);
    const at = repoClock(repo)().toISOString();
    return [recount({ ...run, run: { ...run.run, title } }, itemsOf(records, runId), at)];
  });
  return view(records, runId);
}

/** The project's runs that are not discarded, newest first. */
export async function readRuns(repo: Repo, projectId: string): Promise<RunView[]> {
  const p = place(repo, projectId);
  const records = repaired((await readJobJournal(p.root, p.folder, projectId, p.key)).records);
  return [...records.values()]
    .filter((r): r is JobRecord & { run: CaptureRunData } => isRun(r) && !isDiscarded(r))
    .sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1))
    .map((record) => ({ runId: record.id, record }));
}

/** One run; undefined when it is not known or was discarded. */
export async function readRun(repo: Repo, projectId: string, runId: string): Promise<RunView | undefined> {
  const p = place(repo, projectId);
  const r = repaired((await readJobJournal(p.root, p.folder, projectId, p.key)).records).get(runId);
  return isRun(r) && !isDiscarded(r) ? { runId, record: r } : undefined;
}

/** The run's items, by index. */
export async function readRunItems(repo: Repo, projectId: string, runId: string): Promise<RunItemView[]> {
  const p = place(repo, projectId);
  const records = repaired((await readJobJournal(p.root, p.folder, projectId, p.key)).records);
  return itemsOf(records, runId).map((r) => ({ id: r.id, status: r.status, item: r.item }));
}

/**
 * Takes the run off the list: its record becomes cancelled with error DISCARDED (kept as history), and its items
 * are dropped at the next compaction. What was downloaded stays in the library. False when the run is not known
 * or was already discarded.
 */
export async function discardRun(repo: Repo, projectId: string, runId: string): Promise<boolean> {
  const p = writable(repo, projectId);
  let changed = false;
  await updateJobRecords(p.root, p.folder, projectId, p.key, (raw) => {
    const records = repaired(raw);
    const r = records.get(runId);
    if (!isRun(r) || isDiscarded(r)) return [];
    changed = true;
    return [{ ...r, status: "cancelled", error: DISCARDED_CODE, updatedAt: repoClock(repo)().toISOString() }];
  });
  return changed;
}
