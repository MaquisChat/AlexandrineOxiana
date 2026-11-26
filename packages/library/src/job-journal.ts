/**
 * The job journal (R31): `<Project>/jobs/journal.jsonl`, the file record of the media worker's jobs.
 *
 * - One JSON object per line, append-only; a later line with the same job id supersedes an earlier
 *   one. Every line is a whole snapshot of the job (never a delta), so the newest line per id is
 *   all that is needed, and compaction keeps exactly that.
 * - In encrypted projects every line is sealed with the project key (AES-256-GCM, AAD
 *   `ao-jobs|<projectId>`), like the review queue and the change log: input paths, capture URLs,
 *   output paths and parameters (e.g. the browser named for cookies) never sit in plaintext.
 * - Lines are appended durably (fsync) before the `jobs` row of `library.sqlite` changes: the file
 *   is the record, the row a cache. When the two disagree the file wins (`syncJobRows`, the
 *   rebuild, and resubmission at launch all read the file).
 * - An incomplete last line (a crash during an append) is not a record (R28): readers skip it, the
 *   open trims and reports it (incomplete-lines.ts), and an append trims it first.
 *
 * The cache row keeps only id, project id, job type, status, created_at and a `payload_json`
 * holding at most a fixed error code: nothing identifying for any project (R30), and the full
 * job (needed to resubmit it) is read from the journal.
 *
 * Libraries made before the journal existed have job rows only: `upgradeLegacyJobs` writes each
 * such row into its project's journal once (migration 0003 marks a database that had rows).
 */
import * as fsp from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LibraryRelativePath, type EntityType } from "@ao/core";
import { writeFileAtomic } from "./fs/atomic.js";
import type { KeyRing } from "./crypto/keys.js";
import { getMeta, setMeta, type IndexDb } from "./index/db.js";
import { listProjectEntries, projectKey } from "./index/changes.js";
import { appendDurable, assertContained, decryptBytes, incompleteTail, openLine, readMaybe, sealLine, truncateDurable } from "./repo/io.js";
import { KeyNotAvailableError } from "./crypto/format.js";

export const JOBS_FILE = "jobs/journal.jsonl";
const PURPOSE = "ao-jobs";
const FILE_MODE = 0o600;
/** Meta key set (by migration 0003) while job rows written before the journal existed await `upgradeLegacyJobs`. */
export const LEGACY_JOBS_META = "jobsLegacy";

export type WorkerJobType = "audio.transcribe" | "capture.download" | "image.proxy" | "video.proxy" | "pdf.ocr";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
const STATUSES: ReadonlySet<string> = new Set(["queued", "running", "done", "failed", "cancelled"]);
export const UNFINISHED: ReadonlySet<JobStatus> = new Set(["queued", "running"]);
/** The error of a job cancelled because its project was locked before it started (R142): it runs again at the next unlock. */
export const LOCKED_CODE = "PROJECT_LOCKED";

/**
 * What is needed to submit the job again. No absolute path is stored (R379): `input` and `output`
 * are relative to the library root ("/"-separated, no ".."), resolved against the root of the
 * moment the job runs (`fromLibraryPath`). A capture's `input` is its URL. An input that is a file
 * linked in place from outside the library is not stored as a path: `input` is "" and
 * `inputAsset` names the asset, whose record holds the file's path. Lines written before R379 hold
 * absolute paths; they are read as they are (see `fromLibraryPath`).
 */
export interface StoredJob {
  type: WorkerJobType;
  input: string;
  inputEncrypted?: boolean;
  /** The input is this asset's file (a file linked in place, R379); `input` is then "". */
  inputAsset?: JobInputAsset;
  output: string;
  params: Record<string, unknown>;
  entity?: { type: EntityType; id: string };
}

/** One journal line: the whole state of one job at one moment. */
export interface JobRecord {
  v: 1;
  id: string;
  projectId: string;
  kind: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  /** Present while the job is pending (queued, running, or cancelled by a lock: `isPending`): what resubmitting it needs. */
  job?: StoredJob;
  /** Failed or cancelled jobs: a fixed error code (never a message, which may quote paths). */
  error?: string;
  /**
   * The run this line belongs to: a fresh token on each resubmission's claim line, carried by that
   * run's later lines. A claim succeeds only on the very record it was decided on (`claimJobRecord`).
   */
  attempt?: string;
  /**
   * What the job is for, kept on every line of it, finished ones too (Task 62): the source a
   * transcription is of and the model asked for, so that its state can be found and shown after a
   * reload or a restart. Older lines have none (they are read as before).
   */
  about?: JobAbout;
  /** A `capture.run` record (R668, R669): one download run of a channel, playlist or profile. */
  run?: CaptureRunData;
  /** A `capture.item` record: one video (or post) of a run. Its id is `<runId>/<index>`. */
  item?: CaptureItemData;
  /** The `transcription.list` record: the project's transcription list (id `transcription-list`). */
  list?: TranscriptionListData;
  /** A `transcription.entry` record: one source on the transcription list. */
  entry?: TranscriptionEntryData;
}

// ---- the lists (R668, R669) ------------------------------------------------------------------------

/**
 * The record kinds of the two lists of whole-channel capture: the download runs with their videos, and the
 * transcription list with its entries. They live in the job journal beside the worker's jobs, sealed the same
 * way, but they are not worker jobs: never pending (no resubmission, no cancel of a pending job), never cached
 * as job rows. What they lead to (each stored video, each stored transcript) is governed and audited as ever.
 */
export const LIST_KINDS = ["capture.run", "capture.item", "transcription.list", "transcription.entry"] as const;
const LIST_KIND_SET: ReadonlySet<string> = new Set(LIST_KINDS);

export function isListKind(kind: string): boolean {
  return LIST_KIND_SET.has(kind);
}

/**
 * A download run. Its record's status is `running` while downloading or waiting, `done` when finished with no
 * failure, `cancelled` (error DISCARDED) once discarded, and `queued` otherwise. "Interrupted" is never written:
 * a run that says downloading or waiting and that no service holds is shown so.
 */
export interface CaptureRunData {
  url: string;
  title: string;
  platform: "youtube" | "instagram" | "tiktok";
  /** The run's options as given; checked with assertNoSecrets. */
  options: Record<string, unknown>;
  state: "queued" | "downloading" | "waiting" | "paused" | "paused-disk" | "paused-rate-limited" | "paused-tool" | "stopped" | "finished" | "failed";
  total: number;
  done: number;
  failed: number;
  wait?: { ms: number; why: "rate-limited" | "connection" };
  tool?: string;
  errorCode?: string;
  reason?: string;
  startedBy: "desktop";
}

/** One video (or post) of a run. Its record's status is queued (not reached, or to retry), running, done or failed. */
export interface CaptureItemData {
  runId: string;
  index: number;
  postId: string;
  url: string;
  title?: string;
  durationSec?: number;
  sourceId?: string;
  errorCode?: string;
  platformReason?: string;
}

/** The project's transcription list (its record's status is always queued). */
export interface TranscriptionListData {
  state: "running" | "paused";
  total: number;
  done: number;
  failed: number;
}

/** One source on the transcription list. Its record's status is queued, running, done, failed or cancelled. */
export interface TranscriptionEntryData {
  sourceId: string;
  model: string;
  jobId?: string;
  soundSec?: number;
  title?: string;
}

/** The error of a run the researcher discarded. */
export const DISCARDED_CODE = "DISCARDED";

/**
 * R672 (I4): an older build that opens this journal takes every queued or running list record for a worker job it
 * cannot resume and claims it as failed with this error, keeping the data. This build reads such a record as it
 * was before (run-journal.ts, transcription-list.ts) and compaction keeps it.
 */
export const OLDER_BUILD_CLAIM_CODE = "UNRECOVERABLE";

/** A list record an older build claimed (see OLDER_BUILD_CLAIM_CODE). */
export function claimedByOlderBuild(r: JobRecord): boolean {
  return isListKind(r.kind) && r.status === "failed" && r.error === OLDER_BUILD_CLAIM_CODE;
}

/** What a job is for (see JobRecord.about): ids and a model name only, nothing identifying. */
export interface JobAbout {
  sourceId: string;
  model?: string;
}

export type ProjectKey = { key: Uint8Array; keyId: string } | null;

/** Which asset a job's input is: ids only (R379). */
export interface JobInputAsset {
  sourceId: string;
  assetId: string;
}

// ---- paths (R379) ------------------------------------------------------------------------------

/** A control character (C0, DEL, C1; NUL among them): never part of a path a job may use (R400 c). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * `abs` as a journal stores it: relative to `root`, "/"-separated, no ".." (R379). Undefined when
 * `abs` is not an absolute path strictly inside `root`, or holds a control character (R400 c).
 */
export function toLibraryPath(root: string, abs: string): string | undefined {
  if (!isAbsolute(abs) || CONTROL.test(abs)) return undefined;
  const r = relative(resolve(root), resolve(abs));
  if (!r || isAbsolute(r) || r === ".." || r.startsWith(`..${sep}`)) return undefined;
  const rel = r.split(sep).join("/");
  return LibraryRelativePath.safeParse(rel).success ? rel : undefined;
}

/**
 * A stored path as an absolute path under the library's current root (R379). A relative path is
 * joined to `root` (undefined unless it is a plain library-relative path: no "..", no empty or "."
 * segment, no control character: R400 c). An absolute path (a line written before R379) is used as it is when it lies inside
 * `root`; outside it (the library was moved or copied) it is undefined: the old place is not
 * this library's.
 */
export function fromLibraryPath(root: string, stored: string): string | undefined {
  if (CONTROL.test(stored)) return undefined; // R400 (c)
  if (isAbsolute(stored)) return toLibraryPath(root, stored) !== undefined ? resolve(stored) : undefined;
  if (!LibraryRelativePath.safeParse(stored).success || stored.split("/").some((s) => s === "" || s === ".")) return undefined;
  return join(root, ...stored.split("/"));
}

// ---- secrets ---------------------------------------------------------------------------------

/** Parameter names that would carry a secret. A job carrying one is never recorded (nor run). */
const SECRET_NAMES = new Set([
  "token", "accesstoken", "refreshtoken", "bearer", "password", "passwd", "passphrase", "secret", "clientsecret",
  "apikey", "authorization", "auth", "cookie", "cookies", "cookieheader", "cookievalue", "session", "sessionid", "recoverycode",
]);

/** Throws TypeError when a parameter (at any depth) is named like a secret (R31 records must never hold one). */
export function assertNoSecrets(params: unknown, path = "params"): void {
  if (Array.isArray(params)) {
    params.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
    return;
  }
  if (!params || typeof params !== "object") return;
  for (const [k, v] of Object.entries(params)) {
    if (SECRET_NAMES.has(k.toLowerCase().replace(/[^a-z]/g, ""))) {
      throw new TypeError(`a worker job parameter may not carry a secret (${path}.${k}); job records are kept in files`);
    }
    assertNoSecrets(v, `${path}.${k}`);
  }
}

/** A fixed error code for the record (worker codes are upper-case words; anything else is "FAILED"). */
export function errorCode(code: string | undefined): string {
  return code && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "FAILED";
}

// ---- reading -----------------------------------------------------------------------------------

export function journalPath(root: string, projectRel: string): string {
  return join(root, ...projectRel.split("/"), ...JOBS_FILE.split("/"));
}

function isRecord(o: unknown, projectId: string): o is JobRecord {
  const r = o as JobRecord;
  return (
    !!r && typeof r === "object" && r.v === 1 && typeof r.id === "string" && r.projectId === projectId && typeof r.kind === "string" &&
    STATUSES.has(r.status) && typeof r.createdAt === "string" && typeof r.updatedAt === "string"
  );
}

export interface ParsedJournal {
  /** Newest record per job id, in order of first appearance. */
  records: Map<string, JobRecord>;
  /** The raw line of each id's newest record (compaction keeps these as they are). */
  latestLines: Map<string, string>;
  /** Complete lines that could not be read (another key, damaged): kept by compaction. */
  unreadable: string[];
  /** Number of complete lines. */
  lines: number;
  /** An incomplete last line was ignored. */
  torn: boolean;
  /** Some readable line (superseded or not) holds an absolute path: written before R379 (R400 e). */
  absolutePaths: boolean;
}

/** Whether a stored job names a file by an absolute path (a line written before R379). */
const holdsAbsolutePath = (j: StoredJob | undefined): boolean =>
  !!j && ((j.type !== "capture.download" && typeof j.input === "string" && isAbsolute(j.input)) || (typeof j.output === "string" && isAbsolute(j.output)));

/** Parses a journal's text. `key` opens sealed lines (encrypted projects). */
export function parseJobJournal(text: string, projectId: string, key: Uint8Array | null): ParsedJournal {
  const out: ParsedJournal = { records: new Map(), latestLines: new Map(), unreadable: [], lines: 0, torn: false, absolutePaths: false };
  const parts = text.split("\n");
  for (const [i, line] of parts.entries()) {
    if (i === parts.length - 1) {
      if (line.length > 0) out.torn = true; // no newline yet: not a record (R28)
      continue;
    }
    if (!line.trim()) continue;
    out.lines++;
    try {
      const o = JSON.parse(key ? openLine(key, projectId, line, PURPOSE) : line) as unknown;
      if (!isRecord(o, projectId)) throw new Error("not a job record of this project");
      out.records.delete(o.id); // keep insertion order = order of the newest line
      out.records.set(o.id, o);
      out.latestLines.set(o.id, line);
      if (holdsAbsolutePath(o.job)) out.absolutePaths = true;
    } catch (err) {
      // A wiped key: the read was cut short by a lock; nothing is decided (or rewritten) from it (R386 a).
      if (err instanceof KeyNotAvailableError) throw err;
      out.unreadable.push(line);
    }
  }
  return out;
}

/** Reads a project's journal (missing file: empty). */
export async function readJobJournal(root: string, projectRel: string, projectId: string, key: ProjectKey): Promise<ParsedJournal> {
  const raw = await readMaybe(journalPath(root, projectRel));
  return parseJobJournal(raw ? raw.toString("utf8") : "", projectId, key ? key.key : null);
}

// ---- writing -----------------------------------------------------------------------------------

/** Appends and compactions of one file run one at a time (the library lock makes this process the only writer). */
const chains = new Map<string, Promise<unknown>>();
function serialize<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(path) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(path, tail);
  void tail.then(() => {
    if (chains.get(path) === tail) chains.delete(path);
  });
  return run;
}

function encode(rec: JobRecord, key: ProjectKey): string {
  const json = JSON.stringify(rec);
  return key ? sealLine(key.key, key.keyId, rec.projectId, json, PURPOSE) : json;
}

/** A temporary file of `writeFileAtomic` for the journal (left only by a crash during compaction). */
const COMPACTION_TEMP = /^journal\.jsonl\.tmp-[0-9a-f]{16}$/;

/**
 * Removes what a crash during compaction left in `jobs/`: regular files named exactly as
 * `writeFileAtomic` names its temporary copy of the journal. Called in the file's turn, when no
 * compaction of this process is writing one (the library lock makes it the only writer).
 */
async function sweepCompactionTemps(root: string, projectRel: string): Promise<void> {
  const dir = join(root, ...projectRel.split("/"), "jobs");
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  for (const n of names) {
    if (!COMPACTION_TEMP.test(n)) continue;
    const st = await fsp.lstat(join(dir, n)).catch(() => null);
    if (st?.isFile()) await fsp.rm(join(dir, n), { force: true }).catch(() => {});
  }
}

async function prepare(root: string, projectRel: string): Promise<string> {
  const projectDir = join(root, ...projectRel.split("/"));
  const path = journalPath(root, projectRel);
  await assertContained(projectDir, join(projectDir, "jobs"));
  await fsp.mkdir(join(projectDir, "jobs"), { recursive: true, mode: 0o700 });
  await assertContained(projectDir, path);
  return path;
}

/**
 * Appends records durably (one write, one fsync for all of them). An incomplete last line left by
 * an earlier failed append is cut off first (it was never a record, R28).
 */
export async function appendJobRecords(root: string, projectRel: string, key: ProjectKey, recs: JobRecord[]): Promise<void> {
  if (recs.length === 0) return;
  await serialize(journalPath(root, projectRel), () => appendNow(root, projectRel, key, recs));
}

/** The append itself; callers hold the file's turn in `serialize`. */
async function appendNow(root: string, projectRel: string, key: ProjectKey, recs: JobRecord[]): Promise<void> {
  if (recs.length === 0) return;
  const text = recs.map((r) => `${encode(r, key)}\n`).join("");
  const path = await prepare(root, projectRel);
  const torn = await incompleteTail(path);
  if (torn) await truncateDurable(path, torn.keep);
  await appendDurable(path, text, FILE_MODE);
}

/**
 * Claims a job for one run (R142, "resubmitted once"): appends `next` only if the job's newest
 * record in the journal is still exactly `expected` (the record the decision to rerun was made
 * on) and still pending. Reading and appending happen in the file's turn, so of two overlapping
 * resubmissions (a launch and an unlock, two unlocks) exactly one claims each pending record; the
 * other finds the claim (or the finished job) and does nothing. A crash after the claim leaves a
 * pending record that the next launch claims again: the job runs once, not zero times or twice.
 */
export async function claimJobRecord(
  root: string,
  projectRel: string,
  key: ProjectKey,
  expected: JobRecord,
  next: JobRecord,
): Promise<boolean> {
  return serialize(journalPath(root, projectRel), async () => {
    const journal = await readJobJournal(root, projectRel, expected.projectId, key);
    const newest = journal.records.get(expected.id);
    if (!newest || !isPending(newest) || JSON.stringify(newest) !== JSON.stringify(expected)) return false;
    await appendNow(root, projectRel, key, [next]);
    return true;
  });
}

/**
 * Appends the first record of a job whose id the caller chose (Task 62), only if the journal has no
 * record of that id yet (checked and appended in the file's turn). False: the id is taken.
 */
export async function appendNewJobRecord(root: string, projectRel: string, key: ProjectKey, rec: JobRecord): Promise<boolean> {
  return serialize(journalPath(root, projectRel), async () => {
    const journal = await readJobJournal(root, projectRel, rec.projectId, key);
    if (journal.records.has(rec.id)) return false;
    await appendNow(root, projectRel, key, [rec]);
    return true;
  });
}

/**
 * Reads the journal, asks `fn` for the records to append, and appends them, all in the file's turn: of two
 * calls at once, the second reads what the first appended. Returns the records as they stand after the append
 * (newest per id). `fn` may throw: nothing is appended then. Callers check that the library is writable.
 */
export async function updateJobRecords(
  root: string,
  projectRel: string,
  projectId: string,
  key: ProjectKey,
  fn: (records: ReadonlyMap<string, JobRecord>) => JobRecord[],
): Promise<ReadonlyMap<string, JobRecord>> {
  return serialize(journalPath(root, projectRel), async () => {
    const parsed = await readJobJournal(root, projectRel, projectId, key);
    const records = parsed.records;
    const next = fn(records);
    await appendNow(root, projectRel, key, next);
    for (const r of next) {
      records.delete(r.id);
      records.set(r.id, r);
    }
    // R672: a whole channel must not make every write read tens of thousands of dead lines.
    const lines = parsed.lines + next.length;
    const superseded = lines - records.size - parsed.unreadable.length;
    if (lines > UPDATE_COMPACT_LINES && superseded * 2 > lines) {
      const dropped = await compactNow(root, projectRel, projectId, key, UPDATE_COMPACT_LINES, Date.now());
      for (const id of dropped ?? []) records.delete(id);
    }
    return records;
  });
}

/** `updateJobRecords` compacts in its own turn a journal of more than this many lines, more than half superseded (R672). */
export const UPDATE_COMPACT_LINES = 2000;

/** Lines beyond which a journal is compacted. */
const COMPACT_MIN_LINES = 64;
/** R142: succeeded (done) jobs are dropped at compaction once older than this many days ... */
export const SUCCEEDED_MAX_AGE_DAYS = 30;
/** ... or beyond this many most recent ones per project. */
export const MAX_SUCCEEDED_KEPT = 500;
/** R142: failed and cancelled jobs stay until retried or superseded, but at most this many most recent per project. */
export const MAX_FAILED_KEPT = 500;

/** A record that will run again: unfinished, or cancelled because its project was locked before it started (R142). */
export function isPending(r: JobRecord): boolean {
  if (isListKind(r.kind)) return false; // the lists' records are not worker jobs: nothing resubmits them
  return UNFINISHED.has(r.status) || (r.status === "cancelled" && r.error === LOCKED_CODE && r.job !== undefined);
}

const cancelledEntry = (r: JobRecord) => r.kind === "transcription.entry" && r.status === "cancelled";
const liveRun = (r: JobRecord) =>
  r.kind === "capture.run" && !!r.run && r.run.state !== "finished" && !(r.status === "cancelled" && r.error === DISCARDED_CODE);

/**
 * The ids compaction drops (R142): see the constants above. Pending records are never dropped. The lists'
 * records: a `capture.item` is dropped exactly when its run's record is absent, done, or discarded (the age and
 * count rules never apply to items, so a live run keeps every video); the `transcription.list` record is never
 * dropped; runs and transcription entries follow the rules of finished jobs, except that a cancelled
 * `transcription.entry` is always dropped and never counts toward MAX_FAILED_KEPT (R672: one Stop of a long list
 * must not push out the worker's failed jobs). Never dropped, whatever the caps (R672, I4): a `capture.run` that is
 * neither finished nor discarded, and a `transcription.entry` an older build claimed (it is still pending).
 */
function prunable(records: Map<string, JobRecord>, now: number): Set<string> {
  const drop = new Set<string>();
  const newestFirst = (a: JobRecord, b: JobRecord) => (a.updatedAt === b.updatedAt ? 0 : a.updatedAt < b.updatedAt ? 1 : -1);
  const all = [...records.values()].filter(
    (r) => r.kind !== "capture.item" && r.kind !== "transcription.list" && !cancelledEntry(r) && !liveRun(r) && !(r.kind === "transcription.entry" && claimedByOlderBuild(r)),
  );
  for (const r of records.values()) {
    if (cancelledEntry(r)) drop.add(r.id);
    if (r.kind !== "capture.item") continue;
    const run = r.item ? records.get(r.item.runId) : undefined;
    if (!run || run.kind !== "capture.run" || run.status === "done" || (run.status === "cancelled" && run.error === DISCARDED_CODE)) drop.add(r.id);
  }
  const done = all.filter((r) => r.status === "done").sort(newestFirst);
  const oldest = new Date(now - SUCCEEDED_MAX_AGE_DAYS * 86_400_000).toISOString();
  done.forEach((r, i) => {
    if (i >= MAX_SUCCEEDED_KEPT || r.updatedAt < oldest) drop.add(r.id);
  });
  const failed = all.filter((r) => (r.status === "failed" || r.status === "cancelled") && !isPending(r)).sort(newestFirst);
  failed.slice(MAX_FAILED_KEPT).forEach((r) => drop.add(r.id));
  return drop;
}

/**
 * Rewrites the journal (atomically: temp file, fsync, rename) with the newest line per job, minus
 * the finished jobs R142 lets go (succeeded ones older than SUCCEEDED_MAX_AGE_DAYS or beyond the
 * MAX_SUCCEEDED_KEPT most recent; failed and cancelled ones beyond the MAX_FAILED_KEPT most
 * recent), plus any unreadable lines (kept verbatim). Runs when the journal has more than
 * `minLines` lines and either half of them are superseded or some record can be dropped, and
 * whenever a line holds an absolute path (R400 e: such paths inside the root are written relative). Returns
 * true when it was rewritten. Bound: MAX_SUCCEEDED_KEPT + MAX_FAILED_KEPT lines plus the pending
 * jobs after compaction; between compactions at most three more lines per job (queued, running,
 * final). A job's result lives in its source's files: a dropped record loses only history.
 */
export async function compactJobJournal(
  root: string,
  projectRel: string,
  projectId: string,
  key: ProjectKey,
  minLines = COMPACT_MIN_LINES,
  now = Date.now(),
): Promise<boolean> {
  return serialize(journalPath(root, projectRel), async () => (await compactNow(root, projectRel, projectId, key, minLines, now)) !== undefined);
}

/** The compaction itself; callers hold the file's turn in `serialize`. Returns the ids dropped, or undefined when not rewritten. */
async function compactNow(root: string, projectRel: string, projectId: string, key: ProjectKey, minLines: number, now: number): Promise<Set<string> | undefined> {
  const path = journalPath(root, projectRel);
  await sweepCompactionTemps(root, projectRel);
  const raw = await readMaybe(path);
  if (!raw) return undefined;
  const parsed = parseJobJournal(raw.toString("utf8"), projectId, key ? key.key : null);
  const drop = prunable(parsed.records, now);
  const kept = parsed.latestLines.size - drop.size + parsed.unreadable.length;
  // R400 (e): a journal that still holds a line with an absolute path is compacted whatever its size.
  if (!parsed.absolutePaths && (parsed.lines <= minLines || (drop.size === 0 && kept * 2 > parsed.lines))) return undefined;
  await prepare(root, projectRel);
  const lines = [
    ...parsed.unreadable,
    ...[...parsed.latestLines].filter(([id]) => !drop.has(id)).map(([id, l]) => relativeLine(root, parsed.records.get(id)!, key) ?? l),
  ];
  await writeFileAtomic(path, lines.map((l) => `${l}\n`).join(""), { mode: FILE_MODE });
  return drop;
}

/**
 * R400 (e): a newest line whose job names its files by absolute paths inside `root`, written again
 * with the same record and those paths library-relative (R379). Undefined (the line is kept as it
 * is) when it holds none, or one outside `root`: that job fails as a missing input when resumed,
 * and the next compaction drops the superseded line.
 */
function relativeLine(root: string, rec: JobRecord, key: ProjectKey): string | undefined {
  const j = rec.job;
  if (!j || !holdsAbsolutePath(j)) return undefined;
  const input = j.type === "capture.download" || !isAbsolute(j.input) ? j.input : toLibraryPath(root, j.input);
  const output = isAbsolute(j.output) ? toLibraryPath(root, j.output) : j.output;
  if (input === undefined || output === undefined) return undefined;
  return encode({ ...rec, job: { ...j, input, output } }, key);
}

/**
 * Reads the journal and makes the project's rows match it, as one step with respect to this
 * process's appends (no line appended meanwhile is missed, so no newer row is overwritten or
 * removed by an older read). Returns what was read.
 */
export async function refreshJobRows(
  db: () => IndexDb | undefined,
  root: string,
  projectRel: string,
  projectId: string,
  key: ProjectKey,
): Promise<ParsedJournal> {
  return serialize(journalPath(root, projectRel), async () => {
    const journal = await readJobJournal(root, projectRel, projectId, key);
    const live = db();
    if (live?.open) syncJobRows(live, projectId, journal.records.values());
    return journal;
  });
}

// ---- the cache -----------------------------------------------------------------------------------

/** Writes a job's cache row from its record (nothing identifying: see the module comment). The lists' records have none. */
export function upsertJobRow(db: IndexDb, rec: JobRecord): void {
  if (isListKind(rec.kind)) return;
  db.prepare(
    `INSERT INTO jobs (id, project_id, kind, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, kind = excluded.kind, status = excluded.status,
       payload_json = excluded.payload_json, created_at = excluded.created_at`,
  ).run(rec.id, rec.projectId, rec.kind, rec.status, rec.error ? JSON.stringify({ error: rec.error }) : "{}", rec.createdAt);
}

/** Makes the project's job rows match its journal (the file wins). The lists' records are never cached. */
export function syncJobRows(db: IndexDb, projectId: string, records: Iterable<JobRecord>): void {
  db.transaction(() => {
    const seen = new Set<string>();
    for (const r of records) {
      if (isListKind(r.kind)) continue;
      upsertJobRow(db, r);
      seen.add(r.id);
    }
    // Rows the journal does not know are stale, unless they still await the legacy upgrade.
    if (getMeta(db, LEGACY_JOBS_META) === undefined) {
      const rows = db.prepare("SELECT id FROM jobs WHERE project_id = ?").all(projectId) as Array<{ id: string }>;
      for (const { id } of rows) if (!seen.has(id)) db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
    }
  })();
}

// ---- upgrade of libraries made before the journal --------------------------------------------------

interface LegacyRow {
  id: string;
  project_id: string | null;
  kind: string;
  status: string;
  payload_json: string;
  created_at: string;
}

export interface LegacyUpgrade {
  /** Rows written into a journal by this call. */
  migrated: number;
  /** Rows that wait for their encrypted project to be unlocked (they stay in the database). */
  waiting: LegacyRow[];
  /** Rows of projects that no longer exist in the library (removed from the database). */
  dropped: number;
  errors: Array<{ folder: string; message: string }>;
}

/**
 * A legacy row's job with its paths made library-relative (R379); `null` when a path lies outside
 * the library (it cannot run here: recorded failed as a missing input).
 */
async function legacyJob(row: LegacyRow, key: ProjectKey, root: string): Promise<StoredJob | null | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    return undefined;
  }
  if (parsed && typeof parsed === "object" && typeof (parsed as { sealed?: unknown }).sealed === "string") {
    if (!key) return undefined;
    const plain = await decryptBytes((id) => (id === key.keyId ? key.key : undefined), Buffer.from((parsed as { sealed: string }).sealed, "base64"));
    parsed = JSON.parse(plain.toString("utf8"));
  }
  const j = parsed as Partial<StoredJob> | null;
  if (!j || typeof j.type !== "string" || typeof j.input !== "string" || typeof j.output !== "string") return undefined;
  const input = j.type === "capture.download" ? j.input : toLibraryPath(root, j.input);
  const output = toLibraryPath(root, j.output);
  if (input === undefined || output === undefined) return null;
  return { ...(j as StoredJob), input, output, params: j.params ?? {} };
}

/**
 * Writes job rows that predate the journal into their projects' journals, once (R31 upgrade).
 * Idempotent: a row whose id is already in its journal is not written again, so a crash part-way
 * only leaves the rest for the next call. Rows of locked encrypted projects wait (their payload is
 * sealed); rows of projects that no longer exist are removed. When nothing waits, the database's
 * legacy mark is cleared and later calls return at once. Runs at a rebuild, at an unlock and when
 * jobs are resumed at launch. Writes files: call only for a read-write library.
 */
export async function upgradeLegacyJobs(db: IndexDb, root: string, keyRing: Pick<KeyRing, "get">): Promise<LegacyUpgrade> {
  const out: LegacyUpgrade = { migrated: 0, waiting: [], dropped: 0, errors: [] };
  if (getMeta(db, LEGACY_JOBS_META) === undefined) return out;
  const rows = db.prepare("SELECT id, project_id, kind, status, payload_json, created_at FROM jobs ORDER BY created_at, id").all() as LegacyRow[];
  const byProject = new Map<string, LegacyRow[]>();
  for (const r of rows) {
    const p = r.project_id ?? "";
    byProject.set(p, [...(byProject.get(p) ?? []), r]);
  }
  const entries = await listProjectEntries(root);
  for (const [projectId, list] of byProject) {
    const entry = entries.find((e) => e.data?.project.id === projectId);
    if (!entry?.data) {
      if (entries.some((e) => !e.data)) {
        out.waiting.push(...list); // an unreadable project.json may be this project: keep its rows
        continue;
      }
      db.transaction(() => {
        for (const r of list) db.prepare("DELETE FROM jobs WHERE id = ?").run(r.id);
      })();
      out.dropped += list.length;
      continue;
    }
    const k = projectKey(entry.data, keyRing as KeyRing); // reads only keyRing.get
    if (k === undefined) {
      out.waiting.push(...list);
      continue;
    }
    try {
      const journal = await readJobJournal(root, entry.rel, projectId, k);
      const recs: JobRecord[] = [];
      for (const r of list) {
        if (journal.records.has(r.id)) continue;
        const status = (STATUSES.has(r.status) ? r.status : "failed") as JobStatus;
        const job = UNFINISHED.has(status) ? await legacyJob(r, k, root).catch(() => undefined) : undefined;
        recs.push({
          v: 1,
          id: r.id,
          projectId,
          kind: r.kind,
          // An unfinished row whose job cannot be read can never run again: recorded as failed; one
          // whose paths lie outside this library (R379) fails as a missing input would.
          status: UNFINISHED.has(status) && !job ? "failed" : status,
          createdAt: r.created_at,
          updatedAt: r.created_at,
          ...(job ? { job } : {}),
          ...(UNFINISHED.has(status) && !job ? { error: job === null ? "INPUT_NOT_FOUND" : "UNRECOVERABLE" } : {}),
        });
      }
      await appendJobRecords(root, entry.rel, k, recs);
      out.migrated += recs.length;
      const after = await readJobJournal(root, entry.rel, projectId, k);
      // The rows become cache rows: no payload left in the database.
      db.transaction(() => {
        for (const r of list) {
          const rec = after.records.get(r.id);
          if (rec) upsertJobRow(db, rec);
        }
      })();
    } catch (err) {
      out.errors.push({ folder: `${entry.rel}/${JOBS_FILE}`, message: err instanceof Error ? err.message : String(err) });
      out.waiting.push(...list);
    }
  }
  if (out.waiting.length === 0) db.prepare("DELETE FROM meta WHERE key = ?").run(LEGACY_JOBS_META);
  return out;
}

/** Marks a database as holding legacy job rows (the rebuild keeps rows that still wait). */
export function markLegacyJobs(db: IndexDb): void {
  setMeta(db, LEGACY_JOBS_META, "1");
}
