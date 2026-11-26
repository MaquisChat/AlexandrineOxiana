/**
 * The project's transcription list (R668, R669), written to its job journal (R31): one `transcription.list`
 * record (id TRANSCRIPTION_LIST_ID, status always queued) holding the list's state and counters, and one
 * `transcription.entry` record per source put on it (a fresh id each).
 *
 * - An entry is queued, then running (with the id of its transcription job), then done, failed or cancelled.
 *   The pending entries (queued and running) are transcribed one at a time, in the order they were added.
 * - `total` counts what was put on the list since it was last stopped, less what was cancelled (a source gone
 *   before its turn): so `total` = done + failed + pending. An add only adds: the counters go back to 0 only
 *   through `stopTranscriptionList` (a Stop, or "Remove from this list" of an idle list) (R692).
 * - Putting sources on the list is decided once by the project's rules (process: transcription, local); a deny
 *   is audited and thrown, an allow is not audited here: each transcription audits its own decision when it runs
 *   (as `transcriptionJob` does). The records themselves are not governed changes, as the worker's are not.
 *
 * - An entry an older build claimed as failed UNRECOVERABLE (R672, I4: OLDER_BUILD_CLAIM_CODE) is read as queued
 *   (pending), and the list record it claimed as if untouched; an entry this build marked failed with another
 *   error stays failed.
 *
 * Every function finds the library root, the project's folder and its key from the repo (ProjectLockedError
 * while the project is locked); every write throws ReadOnlyLibraryError on a read-only library.
 */
import { randomUUID } from "node:crypto";
import { primary, type SourceFile } from "@ao/core";
import { DEFAULT_SPEECH_MODEL } from "@ao/shared";
import {
  claimedByOlderBuild, errorCode, readJobJournal, updateJobRecords,
  type JobRecord, type JobStatus, type ProjectKey, type TranscriptionEntryData, type TranscriptionListData,
} from "../job-journal.js";
import { NotFoundError, ReadOnlyLibraryError } from "../repo/errors.js";
import { authorizeProcessing, projectDataKey, repoClock, repoLibrary, type Repo } from "../repo/repo.js";
import { recordingOf } from "../transcription-jobs.js";

export const TRANSCRIPTION_LIST_ID = "transcription-list";

export interface TranscriptionEntryView {
  entryId: string;
  status: JobStatus;
  entry: TranscriptionEntryData;
  addedAt: string;
}

export interface TranscriptionListView {
  state: "running" | "paused";
  total: number;
  done: number;
  failed: number;
  /** Queued and running entries, in the order they were added. */
  pending: TranscriptionEntryView[];
}

const LIST_KIND = "transcription.list";
const ENTRY_KIND = "transcription.entry";
const EMPTY: TranscriptionListData = { state: "running", total: 0, done: 0, failed: 0 };

type Entry = JobRecord & { entry: TranscriptionEntryData };

interface Place {
  root: string;
  folder: string;
  key: ProjectKey;
}

function place(repo: Repo, projectId: string): Place {
  return { root: repoLibrary(repo).root, folder: repo.getProject(projectId).folder, key: projectDataKey(repo, projectId) };
}

function writable(repo: Repo, projectId: string): Place {
  const library = repoLibrary(repo);
  if (library.mode !== "read-write") throw new ReadOnlyLibraryError(library.readOnlyReason);
  return place(repo, projectId);
}

const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/**
 * The length of a source's recording in seconds: the platform's `duration` in its details, else the recording's
 * `metadata.durationSec`, else undefined.
 */
export function soundSecondsOf(sf: SourceFile): number | undefined {
  const snap = sf.source.provenance.platformSnapshot;
  const fromPlatform = snap && typeof snap === "object" ? positive((snap as { duration?: unknown }).duration) : undefined;
  if (fromPlatform !== undefined) return fromPlatform;
  const media = recordingOf(sf);
  const meta = media?.metadata as { durationSec?: unknown } | undefined;
  return positive(meta?.durationSec);
}

/** The records with what an older build claimed read as it was (see the module comment). */
function repaired(records: ReadonlyMap<string, JobRecord>): Map<string, JobRecord> {
  const out = new Map(records);
  for (const r of records.values()) {
    if (!claimedByOlderBuild(r) || (r.kind !== ENTRY_KIND && r.kind !== LIST_KIND)) continue;
    const { error: _error, attempt: _attempt, ...base } = r;
    out.set(r.id, { ...base, status: "queued" });
  }
  return out;
}

function listOf(records: ReadonlyMap<string, JobRecord>): { rec?: JobRecord; data: TranscriptionListData } {
  const rec = records.get(TRANSCRIPTION_LIST_ID);
  return rec?.kind === LIST_KIND && rec.list ? { rec, data: rec.list } : { data: EMPTY };
}

const isPendingEntry = (r: Entry) => r.status === "queued" || r.status === "running";

/** The entries in the order they were added (their `createdAt` is strictly increasing: see `addToTranscriptionList`). */
function entriesOf(records: ReadonlyMap<string, JobRecord>): Entry[] {
  return [...records.values()]
    .filter((r): r is Entry => r.kind === ENTRY_KIND && !!r.entry)
    .sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1));
}

function listRecord(projectId: string, records: ReadonlyMap<string, JobRecord>, data: TranscriptionListData, at: string): JobRecord {
  const { rec } = listOf(records);
  return { v: 1, id: TRANSCRIPTION_LIST_ID, projectId, kind: LIST_KIND, status: "queued", createdAt: rec?.createdAt ?? at, updatedAt: at, list: data };
}

export async function readTranscriptionList(repo: Repo, projectId: string): Promise<TranscriptionListView> {
  const p = place(repo, projectId);
  const records = repaired((await readJobJournal(p.root, p.folder, projectId, p.key)).records);
  const { data } = listOf(records);
  const pending = entriesOf(records)
    .filter(isPendingEntry)
    .map((r) => ({ entryId: r.id, status: r.status, entry: r.entry, addedAt: r.createdAt }));
  return { state: data.state, total: data.total, done: data.done, failed: data.failed, pending };
}

/**
 * Puts sources at the end of the list, each once: a source already pending on the list, one that is gone, or
 * one with no recording is left out. The project's rules are asked once (see the module comment).
 */
export async function addToTranscriptionList(repo: Repo, projectId: string, items: Array<{ sourceId: string; model?: string }>): Promise<{ added: number }> {
  const p = writable(repo, projectId);
  await authorizeProcessing(repo, projectId, { action: "process", process: { op: "transcription", provider: "local" } }, { op: "transcription.list.add" });
  const wanted: Array<{ sourceId: string; model: string; title?: string; soundSec?: number }> = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.sourceId)) continue;
    seen.add(it.sourceId);
    const sf = await repo.getSource(projectId, it.sourceId).catch((err: unknown) => {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    });
    if (!sf || !recordingOf(sf)) continue;
    const title = primary(sf.source.title);
    const soundSec = soundSecondsOf(sf);
    wanted.push({ sourceId: it.sourceId, model: it.model ?? DEFAULT_SPEECH_MODEL, ...(title ? { title } : {}), ...(soundSec !== undefined ? { soundSec } : {}) });
  }
  if (wanted.length === 0) return { added: 0 };
  let added = 0;
  await updateJobRecords(p.root, p.folder, projectId, p.key, (raw) => {
    const records = repaired(raw);
    const entries = entriesOf(records);
    const pending = entries.filter(isPendingEntry);
    const onList = new Set(pending.map((e) => e.entry.sourceId));
    const fresh = wanted.filter((w) => !onList.has(w.sourceId));
    added = fresh.length;
    if (fresh.length === 0) return [];
    // Each entry is added after every earlier one, even within one millisecond: the list's order is by it.
    const last = entries.reduce((m, e) => Math.max(m, Date.parse(e.createdAt) || 0), 0);
    const start = Math.max(repoClock(repo)().getTime(), last + 1);
    const at = new Date(start + fresh.length - 1).toISOString();
    const recs: JobRecord[] = fresh.map((w, i) => {
      const created = new Date(start + i).toISOString();
      const entry: TranscriptionEntryData = { sourceId: w.sourceId, model: w.model, ...(w.soundSec !== undefined ? { soundSec: w.soundSec } : {}), ...(w.title !== undefined ? { title: w.title } : {}) };
      return { v: 1, id: randomUUID(), projectId, kind: ENTRY_KIND, status: "queued", createdAt: created, updatedAt: created, entry };
    });
    const { data } = listOf(records);
    return [...recs, listRecord(projectId, records, { ...data, total: data.total + fresh.length }, at)];
  });
  return { added };
}

/** What an entry in each status adds to the list's counters. */
function weight(status: JobStatus): { total: number; done: number; failed: number } {
  if (status === "done") return { total: 0, done: 1, failed: 0 };
  if (status === "failed") return { total: 0, done: 0, failed: 1 };
  if (status === "cancelled") return { total: -1, done: 0, failed: 0 };
  return { total: 0, done: 0, failed: 0 };
}

function moved(data: TranscriptionListData, from: JobStatus, to: JobStatus): TranscriptionListData {
  const a = weight(from);
  const b = weight(to);
  return {
    ...data,
    total: Math.max(0, data.total + b.total - a.total),
    done: Math.max(0, data.done + b.done - a.done),
    failed: Math.max(0, data.failed + b.failed - a.failed),
  };
}

const ENDED: ReadonlySet<JobStatus> = new Set(["done", "failed", "cancelled"]);

/**
 * Records what became of one entry; the list's counters follow. An entry that has ended (done, failed,
 * cancelled) never moves again: any call that would move it out of its ended state writes nothing and returns
 * false (R672: a Stop that came between the start of an entry's job and this mark, the caller then cancels the
 * job it started; R692: a Stop that landed just as the job ended, so the list stays empty with its counters at
 * 0). Marking an ended entry with the status it already has writes nothing and returns true. An entry no longer in the journal (dropped by compaction after a Stop) is treated
 * the same: nothing is written and false is returned (R676). Every other move returns true.
 */
export async function markTranscriptionEntry(
  repo: Repo,
  projectId: string,
  entryId: string,
  next: { status: "running"; jobId: string } | { status: "done" } | { status: "failed"; error: string } | { status: "cancelled"; error?: string },
): Promise<boolean> {
  const p = writable(repo, projectId);
  let moves = true;
  await updateJobRecords(p.root, p.folder, projectId, p.key, (raw) => {
    const records = repaired(raw);
    const old = records.get(entryId);
    // R676: an entry no longer in the journal (a stopped entry compaction dropped) is a late mark: nothing is written.
    if (!old || old.kind !== ENTRY_KIND || !old.entry) {
      moves = false;
      return [];
    }
    if (ENDED.has(old.status)) {
      moves = next.status === old.status;
      return [];
    }
    const at = repoClock(repo)().toISOString();
    const { error: _error, ...base } = old;
    const entry: TranscriptionEntryData = next.status === "running" ? { ...old.entry, jobId: next.jobId } : old.entry;
    const error = next.status === "failed" ? errorCode(next.error) : next.status === "cancelled" ? errorCode(next.error ?? "CANCELLED") : undefined;
    const rec: JobRecord = { ...base, status: next.status, updatedAt: at, entry, ...(error !== undefined ? { error } : {}) };
    const { data } = listOf(records);
    return [rec, listRecord(projectId, records, moved(data, old.status, next.status), at)];
  });
  return moves;
}

/** Pauses the list (the transcription in hand finishes) or lets it run. */
export async function setTranscriptionListState(repo: Repo, projectId: string, state: "running" | "paused"): Promise<void> {
  const p = writable(repo, projectId);
  await updateJobRecords(p.root, p.folder, projectId, p.key, (raw) => {
    const records = repaired(raw);
    const { data } = listOf(records);
    return [listRecord(projectId, records, { ...data, state }, repoClock(repo)().toISOString())];
  });
}

/**
 * Empties the list: every pending entry is cancelled (error STOPPED), `total`, `done` and `failed` go back to 0
 * (so the idle list shows no line, R672), and the list runs again for whatever is put on it next. Returns the job ids of the entries that were running, for the caller to cancel those jobs.
 */
export async function stopTranscriptionList(repo: Repo, projectId: string): Promise<{ jobIds: string[] }> {
  const p = writable(repo, projectId);
  const jobIds: string[] = [];
  await updateJobRecords(p.root, p.folder, projectId, p.key, (raw) => {
    const records = repaired(raw);
    const pending = entriesOf(records).filter(isPendingEntry);
    jobIds.length = 0;
    const at = repoClock(repo)().toISOString();
    const { data } = listOf(records);
    const recs: JobRecord[] = pending.map((e) => {
      if (e.status === "running" && e.entry.jobId) jobIds.push(e.entry.jobId);
      const { error: _error, ...base } = e;
      return { ...base, status: "cancelled", updatedAt: at, error: "STOPPED" };
    });
    const emptied: TranscriptionListData = { ...data, state: "running", total: 0, done: 0, failed: 0 };
    if (recs.length === 0 && data.state === "running" && data.total === 0 && data.done === 0 && data.failed === 0) return [];
    return [...recs, listRecord(projectId, records, emptied, at)];
  });
  return { jobIds };
}
