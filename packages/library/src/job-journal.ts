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
 * such row into its project's journal once (migration 0002 marks a database that had rows).
 */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { EntityType } from "@ao/core";
import { writeFileAtomic } from "./fs/atomic.js";
import type { KeyRing } from "./crypto/keys.js";
import { getMeta, setMeta, type IndexDb } from "./index/db.js";
import { listProjectEntries, projectKey } from "./index/changes.js";
import { appendDurable, assertContained, decryptBytes, incompleteTail, openLine, readMaybe, sealLine, truncateDurable } from "./repo/io.js";

export const JOBS_FILE = "jobs/journal.jsonl";
const PURPOSE = "ao-jobs";
const FILE_MODE = 0o600;
/** Meta key set (by migration 0002) while job rows written before the journal existed await `upgradeLegacyJobs`. */
export const LEGACY_JOBS_META = "jobsLegacy";

export type WorkerJobType = "audio.transcribe" | "capture.download" | "image.proxy" | "video.proxy" | "pdf.ocr";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
const STATUSES: ReadonlySet<string> = new Set(["queued", "running", "done", "failed", "cancelled"]);
export const UNFINISHED: ReadonlySet<JobStatus> = new Set(["queued", "running"]);

/** What is needed to submit the job again. */
export interface StoredJob {
  type: WorkerJobType;
  input: string;
  inputEncrypted?: boolean;
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
  /** Present while the job is unfinished (queued, running): what resubmitting it needs. */
  job?: StoredJob;
  /** Failed or cancelled jobs: a fixed error code (never a message, which may quote paths). */
  error?: string;
}

export type ProjectKey = { key: Uint8Array; keyId: string } | null;

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
}

/** Parses a journal's text. `key` opens sealed lines (encrypted projects). */
export function parseJobJournal(text: string, projectId: string, key: Uint8Array | null): ParsedJournal {
  const out: ParsedJournal = { records: new Map(), latestLines: new Map(), unreadable: [], lines: 0, torn: false };
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
    } catch {
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
  const text = recs.map((r) => `${encode(r, key)}\n`).join("");
  const path = journalPath(root, projectRel);
  await serialize(path, async () => {
    await prepare(root, projectRel);
    const torn = await incompleteTail(path);
    if (torn) await truncateDurable(path, torn.keep);
    await appendDurable(path, text, FILE_MODE);
  });
}

/** Lines beyond which a journal is compacted, when most of them are superseded. */
const COMPACT_MIN_LINES = 64;

/**
 * Rewrites the journal (atomically: temp file, fsync, rename) with only the newest line per job
 * plus any unreadable lines, when at least half its lines are superseded and it has more than
 * `minLines` lines. Returns true when it was rewritten. Bound: after compaction one line per job
 * ever recorded; between compactions at most three more lines per job (queued, running, final).
 */
export async function compactJobJournal(
  root: string,
  projectRel: string,
  projectId: string,
  key: ProjectKey,
  minLines = COMPACT_MIN_LINES,
): Promise<boolean> {
  const path = journalPath(root, projectRel);
  return serialize(path, async () => {
    const raw = await readMaybe(path);
    if (!raw) return false;
    const parsed = parseJobJournal(raw.toString("utf8"), projectId, key ? key.key : null);
    const kept = parsed.latestLines.size + parsed.unreadable.length;
    if (parsed.lines <= minLines || kept * 2 > parsed.lines) return false;
    await prepare(root, projectRel);
    const text = [...parsed.unreadable, ...parsed.latestLines.values()].map((l) => `${l}\n`).join("");
    await writeFileAtomic(path, text, { mode: FILE_MODE });
    return true;
  });
}

// ---- the cache -----------------------------------------------------------------------------------

/** Writes a job's cache row from its record (nothing identifying: see the module comment). */
export function upsertJobRow(db: IndexDb, rec: JobRecord): void {
  db.prepare(
    `INSERT INTO jobs (id, project_id, kind, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, kind = excluded.kind, status = excluded.status,
       payload_json = excluded.payload_json, created_at = excluded.created_at`,
  ).run(rec.id, rec.projectId, rec.kind, rec.status, rec.error ? JSON.stringify({ error: rec.error }) : "{}", rec.createdAt);
}

/** Makes the project's job rows match its journal (the file wins). */
export function syncJobRows(db: IndexDb, projectId: string, records: Iterable<JobRecord>): void {
  db.transaction(() => {
    const seen = new Set<string>();
    for (const r of records) {
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

async function legacyJob(row: LegacyRow, key: ProjectKey): Promise<StoredJob | undefined> {
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
  return { ...(j as StoredJob), params: j.params ?? {} };
}

/**
 * Writes job rows that predate the journal into their projects' journals, once (R31 upgrade).
 * Idempotent: a row whose id is already in its journal is not written again, so a crash part-way
 * only leaves the rest for the next call. Rows of locked encrypted projects wait (their payload is
 * sealed); rows of projects that no longer exist are removed. When nothing waits, the database's
 * legacy mark is cleared and later calls return at once. `onlyProject` limits the work to one
 * project (an unlock). Writes files: call only for a read-write library.
 */
export async function upgradeLegacyJobs(db: IndexDb, root: string, keyRing: KeyRing, onlyProject?: string): Promise<LegacyUpgrade> {
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
    if (onlyProject !== undefined && projectId !== onlyProject) {
      out.waiting.push(...list);
      continue;
    }
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
    const k = projectKey(entry.data, keyRing);
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
        const job = UNFINISHED.has(status) ? await legacyJob(r, k).catch(() => undefined) : undefined;
        recs.push({
          v: 1,
          id: r.id,
          projectId,
          kind: r.kind,
          // An unfinished row whose job cannot be read can never run again: recorded as failed.
          status: UNFINISHED.has(status) && !job ? "failed" : status,
          createdAt: r.created_at,
          updatedAt: r.created_at,
          ...(job ? { job } : {}),
          ...(UNFINISHED.has(status) && !job ? { error: "UNRECOVERABLE" } : {}),
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
