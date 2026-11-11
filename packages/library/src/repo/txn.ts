/**
 * Write-ahead transaction marker: `<Library>/.tmp/txn-<id>.json`.
 *
 * Before a mutation touches any final-name file, folder, change log or audit
 * segment, the step is added to the marker (rewritten atomically). Replaced
 * files are first copied to `.tmp/txn-<id>.orig-<n>` (keeping their mode). The
 * allow audit events carry `details.txn = <id>`; once they are all appended
 * (the commit point) the marker and its copies are deleted.
 *
 * A crash leaves the marker behind. On the next writable open,
 * `recoverTransactions` handles each marker:
 * - invalid (unparseable; projectId not the project at projectFolder; any path
 *   outside where this transaction may write, lexically or through a symbolic
 *   link; backups/trash not named for this transaction): nothing is touched, the
 *   marker is kept, reported 'invalid-txn-marker'. Both the project it names
 *   and the project at its projectFolder refuse writes until it is resolved;
 * - committed (every allow event with this txn id is in the audit log): only
 *   the marker, its backups and its trash are removed;
 * - audit unverifiable (the chain up to the transaction's start does not verify
 *   (its own tail, possibly torn by the crash, is not checked: the rollback
 *   truncates it), or the external anchor says
 *   events at or after this transaction's start were committed, which an
 *   uncommitted transaction cannot explain, or the recorded append offsets no
 *   longer mark where it began: an offset off a line boundary, or a different
 *   number of audit events before it than recorded, or later events not its
 *   own, R131 b): nothing is touched, the marker is
 *   kept, reported 'txn-recovery-skipped-audit-unverifiable';
 * - a choice the researcher recorded (R131 c): left to openRepo, which completes
 *   and audits it first (pending-writes.ts); if that failed, nothing is touched,
 *   reported 'incomplete-write-pending';
 * - otherwise every step is undone in reverse (including partially appended
 *   change log and audit lines), reported 'rolled-back-incomplete-write'. If an
 *   undo step fails the marker is kept for the next open.
 *
 * Paths in the marker are relative to the library root (`/` separators), so a
 * library moved between the crash and the next open still recovers.
 */
import * as fsp from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { LibraryRelativePath, isId, newId, verifyChain, type AuditEvent } from "@ao/core";
import { copyFileAtomic, renameWithRetry, writeFileAtomic, writeSmallFileAtomic } from "../fs/atomic.js";
import { AuditStore, auditSegments, type Head } from "./audit-store.js";
import { PathEscapeError } from "./errors.js";
import { shredPath } from "../fs/shred.js";
import { assertContained, exists, undoAppend, type AppendUndo } from "./io.js";
import { seams } from "./seams.js";

export type MarkerEntry =
  | { kind: "created"; path: string }
  | { kind: "replaced"; path: string; backup: string; mode: number }
  | { kind: "dir"; path: string }
  /** `shred`: destroyed, not deleted (R90 d): overwritten before it is removed once committed. */
  | { kind: "trashed"; from: string; to: string; shred?: boolean }
  | { kind: "append"; path: string; prevSize: number; created: boolean };

/**
 * The researcher's choice for an interrupted change (R27, R131 c), written into the marker before
 * anything is done, so that a crash or a failed audit append leaves it to be completed (and audited)
 * on the next open rather than done silently. `status` is what the marker showed when the choice was made.
 */
export interface ResolveRecord {
  choice: "keep" | "roll-back";
  status: "committed" | "uncommitted";
  at: string;
}

export interface TxnMarker {
  formatVersion: 1;
  txn: string;
  projectId: string;
  /** Library-relative project folder (where its audit log lives). */
  projectFolder: string;
  /** Number of allow audit events that make up the commit. */
  auditEvents: number;
  /** Audit head seq when the transaction started (0 for an empty log). */
  auditSeqBefore: number;
  entries: MarkerEntry[];
  /** Present once the researcher chose how to resolve it (R131 c). */
  resolve?: ResolveRecord;
}

const MARKER = /^txn-([0-9a-f-]+)\.json$/;
const BACKUP = /^txn-([0-9a-f-]+)\.orig-\d+$/;

export const toRel = (root: string, abs: string): string => relative(root, abs).split(sep).join("/");
export const fromRel = (root: string, rel: string): string => join(root, ...rel.split("/"));

export class TxnLog {
  readonly marker: TxnMarker;
  private backups = 0;
  /** Folders this transaction created: their contents go with them on undo. */
  private readonly newDirs: string[] = [];
  /** Files already appended to in this transaction: undo truncates them to the first recorded size. */
  private readonly appended = new Set<string>();
  private dirReady = false;

  constructor(
    private readonly root: string,
    projectId: string,
    projectFolder: string,
    auditEvents: number,
    auditSeqBefore: number,
  ) {
    this.marker = { formatVersion: 1, txn: newId(), projectId, projectFolder, auditEvents, auditSeqBefore, entries: [] };
  }

  get id(): string {
    return this.marker.txn;
  }

  private get dir(): string {
    return join(this.root, ".tmp");
  }

  get path(): string {
    return join(this.dir, `txn-${this.id}.json`);
  }

  /** Durably records a step before it is taken. */
  async add(entry: MarkerEntry): Promise<void> {
    this.marker.entries.push(entry);
    if (!this.dirReady) {
      await fsp.mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
    await writeSmallFileAtomic(this.path, JSON.stringify(this.marker));
  }

  /** Inside a folder this transaction created (undoing that folder removes it). */
  private inNewDir(rel: string): boolean {
    return this.newDirs.some((d) => rel.startsWith(`${d}/`));
  }

  async created(abs: string) {
    const rel = toRel(this.root, abs);
    // A file in a folder this transaction created needs no step of its own.
    if (this.inNewDir(rel)) return;
    await this.add({ kind: "created", path: rel });
  }

  /** Copies the current file aside (same mode, so 0600 stays 0600), then records it. */
  async replaced(abs: string, mode: number) {
    await fsp.mkdir(this.dir, { recursive: true });
    const backup = join(this.dir, `txn-${this.id}.orig-${this.backups++}`);
    await copyFileAtomic(abs, backup, { mode });
    await this.add({ kind: "replaced", path: toRel(this.root, abs), backup: toRel(this.root, backup), mode });
  }

  async createdDir(abs: string) {
    const rel = toRel(this.root, abs);
    if (this.inNewDir(rel)) return;
    this.newDirs.push(rel);
    await this.add({ kind: "dir", path: rel });
  }

  /**
   * Takes back the step just recorded for a folder the transaction then found already created by
   * someone else (an exclusive mkdir failed with EEXIST): it is not ours, so undo must not remove it.
   */
  async retractDir(abs: string) {
    const rel = toRel(this.root, abs);
    let i = this.marker.entries.length - 1;
    while (i >= 0 && !(this.marker.entries[i]!.kind === "dir" && (this.marker.entries[i] as { path: string }).path === rel)) i--;
    if (i < 0) return;
    this.marker.entries.splice(i, 1);
    const j = this.newDirs.lastIndexOf(rel);
    if (j >= 0) this.newDirs.splice(j, 1);
    await writeSmallFileAtomic(this.path, JSON.stringify(this.marker));
  }

  async trashed(from: string, to: string, shred = false) {
    const rel = toRel(this.root, from);
    // What was at or under `from` is gone: a later append or folder there is new and needs its own
    // step (else undo would truncate or remove the new file and leave the original in the trash).
    const covers = (p: string) => p === rel || p.startsWith(`${rel}/`);
    for (const p of [...this.appended]) if (covers(p)) this.appended.delete(p);
    for (let i = this.newDirs.length - 1; i >= 0; i--) if (covers(this.newDirs[i]!)) this.newDirs.splice(i, 1);
    await this.add({ kind: "trashed", from: rel, to: toRel(this.root, to), ...(shred ? { shred: true } : {}) });
  }

  async append(u: AppendUndo) {
    const rel = toRel(this.root, u.path);
    // A later append to the same file is covered by the first step (undo truncates to its size).
    if (this.appended.has(rel) || this.inNewDir(rel)) return;
    this.appended.add(rel);
    await this.add({ kind: "append", path: rel, prevSize: u.prevSize, created: u.created });
  }

  /** Undoes every recorded step in reverse. Returns false if any step failed. */
  undo(): Promise<boolean> {
    return undoEntries(this.root, this.marker.entries);
  }

  /** Removes the marker and its backup copies (after commit, or after a complete rollback). */
  async finish(): Promise<void> {
    await removeMarker(this.root, this.marker);
  }
}

/** Best effort: keeps going past failures, and reports whether every step succeeded. */
export async function undoEntries(root: string, entries: MarkerEntry[]): Promise<boolean> {
  let ok = true;
  for (const e of [...entries].reverse()) {
    try {
      if (seams.failUndo === e.kind) throw new Error(`simulated undo failure (${e.kind})`);
      if (e.kind === "created") await fsp.rm(fromRel(root, e.path), { force: true });
      else if (e.kind === "dir") await fsp.rm(fromRel(root, e.path), { recursive: true, force: true });
      else if (e.kind === "replaced") {
        const backup = fromRel(root, e.backup);
        if (await exists(backup)) await writeFileAtomic(fromRel(root, e.path), await fsp.readFile(backup), { mode: e.mode });
      } else if (e.kind === "trashed") {
        const to = fromRel(root, e.to);
        if ((await exists(to)) && !(await exists(fromRel(root, e.from)))) await renameWithRetry(to, fromRel(root, e.from));
      } else {
        // Nothing to undo when the file is gone or is not a regular file (the append never happened).
        const path = fromRel(root, e.path);
        const st = await fsp.lstat(path).catch(() => null);
        if (st?.isFile() && (e.created || st.size > e.prevSize)) await undoAppend({ path, prevSize: e.prevSize, created: e.created });
      }
    } catch {
      ok = false;
    }
  }
  return ok;
}

export async function removeMarker(root: string, m: TxnMarker): Promise<void> {
  for (const e of m.entries) {
    if (e.kind === "replaced") await fsp.rm(fromRel(root, e.backup), { force: true }).catch(() => {});
  }
  await fsp.rm(join(root, ".tmp", `txn-${m.txn}.json`), { force: true });
}

// ---- validation ----------------------------------------------------------------------

const isRel = (p: unknown): p is string => typeof p === "string" && LibraryRelativePath.safeParse(p).success && !p.split("/").includes(".");
const under = (p: unknown, folder: string): boolean => isRel(p) && p.startsWith(`${folder}/`);
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isBackupOf = (p: unknown, txn: string): boolean => isRel(p) && new RegExp(`^\\.tmp/txn-${esc(txn)}\\.orig-\\d+$`).test(p);
const isTrashOf = (p: unknown, txn: string): boolean => isRel(p) && new RegExp(`^\\.tmp/trash-${esc(txn)}-[0-9a-f]+$`).test(p);
const count = (n: unknown): boolean => Number.isSafeInteger(n) && (n as number) >= 0;

/**
 * Returns the reason a marker must not be acted on, or null when it is safe:
 * every path it would touch lies inside its own project folder, and backups
 * and trash lie directly in `.tmp/`.
 */
export function markerProblem(m: unknown, fileTxn: string): string | null {
  if (!m || typeof m !== "object") return "not an object";
  const x = m as Partial<TxnMarker>;
  if (x.formatVersion !== 1) return "unsupported formatVersion";
  if (typeof x.txn !== "string" || !isId(x.txn) || x.txn !== fileTxn) return "transaction id does not match the file name";
  if (typeof x.projectId !== "string" || !isId(x.projectId)) return "bad projectId";
  const pf = x.projectFolder;
  if (!isRel(pf) || !/^Projects\/[^/]+$/.test(pf) || pf.slice("Projects/".length).startsWith(".")) return "projectFolder is not Projects/<folder>";
  if (!count(x.auditEvents) || (x.auditEvents as number) < 1 || !count(x.auditSeqBefore)) return "bad audit counters";
  if (!Array.isArray(x.entries)) return "entries missing";
  if (x.resolve !== undefined) {
    const r = x.resolve as Partial<ResolveRecord> | null;
    if (!r || typeof r !== "object" || (r.choice !== "keep" && r.choice !== "roll-back") || (r.status !== "committed" && r.status !== "uncommitted") || typeof r.at !== "string") {
      return "bad resolve record";
    }
  }
  for (const e of x.entries as unknown[]) {
    const en = e as Partial<Record<string, unknown>> | null;
    if (!en || typeof en !== "object") return "bad entry";
    switch (en.kind) {
      case "created":
      case "dir":
        if (!under(en.path, pf)) return `${en.kind} path outside the project`;
        break;
      case "replaced":
        if (!under(en.path, pf)) return "replaced path outside the project";
        if (!isBackupOf(en.backup, x.txn)) return "backup is not this transaction's copy in .tmp";
        if (!count(en.mode) || (en.mode as number) > 0o777) return "bad mode";
        break;
      case "trashed":
        if (!under(en.from, pf)) return "trashed path outside the project";
        if (!isTrashOf(en.to, x.txn)) return "trash is not this transaction's folder in .tmp";
        if (en.shred !== undefined && typeof en.shred !== "boolean") return "bad trashed entry";
        break;
      case "append":
        if (!under(en.path, pf)) return "append path outside the project";
        if (!count(en.prevSize) || typeof en.created !== "boolean") return "bad append entry";
        break;
      default:
        return "unknown entry kind";
    }
  }
  return null;
}

/**
 * Checks against the file system, after markerProblem passed: the project at
 * `projectFolder` must be the marker's project, and no path may resolve
 * (through symbolic links) outside the project folder or `.tmp/`.
 */
async function unsafeOnDisk(root: string, m: TxnMarker): Promise<string | null> {
  const projectDir = fromRel(root, m.projectFolder);
  try {
    const pj = JSON.parse(await fsp.readFile(join(projectDir, "project.json"), "utf8")) as { project?: { id?: unknown } };
    if (pj.project?.id !== m.projectId) return "projectId does not match the project at projectFolder";
  } catch {
    return "projectFolder holds no readable project.json";
  }
  const tmpDir = join(root, ".tmp");
  try {
    for (const e of m.entries) {
      if (e.kind === "trashed") {
        await assertContained(projectDir, fromRel(root, e.from));
        await assertContained(tmpDir, fromRel(root, e.to));
      } else {
        await assertContained(projectDir, fromRel(root, e.path));
        if (e.kind === "replaced") await assertContained(tmpDir, fromRel(root, e.backup));
      }
    }
  } catch (err) {
    if (err instanceof PathEscapeError) return "a path resolves outside its folder through a symbolic link";
    throw err;
  }
  return null;
}

// ---- recovery ------------------------------------------------------------------------

export type RecoveryOutcome =
  | "committed"
  /** Committed, but files it destroyed could not be overwritten yet: marker and trash kept, retried (R94). */
  | "committed-destroy-pending"
  | "rolled-back"
  | "rollback-incomplete"
  | "invalid"
  | "skipped-audit-unverifiable"
  /** A choice the researcher recorded could not be completed yet (R131 c): the marker is kept, never acted on here. */
  | "resolve-incomplete";

export interface RecoveryResult {
  /** The marker's project id, or "*" when the marker cannot be read. */
  projectId: string;
  /** The marker's `projectFolder` as written, when it has one (it may be a different project's folder). */
  projectFolder?: string;
  txn: string;
  outcome: RecoveryOutcome;
  detail?: string;
}

async function listMarkers(root: string): Promise<string[]> {
  try {
    return (await fsp.readdir(join(root, ".tmp"))).filter((n) => MARKER.test(n)).sort();
  } catch {
    return [];
  }
}

/** Marker files present (used on read-only opens, where nothing may be recovered). */
export async function pendingMarkers(root: string): Promise<number> {
  return (await listMarkers(root)).length;
}

/**
 * What a marker says, decided without touching anything (R26 rules, shared by recovery on open and
 * by the researcher's manual resolution, R27):
 * - `invalid`: unreadable, or unsafe to act on (see markerProblem / unsafeOnDisk);
 * - `committed`: every allow audit event of the transaction is in the project's audit log;
 * - `unverifiable`: not committed by the log, but the log cannot be trusted to say so (its chain
 *   before the transaction does not verify, or the external anchor is past the transaction's start);
 * - `uncommitted`: not committed, and the log can be trusted to say so.
 */
export type MarkerStatus = "invalid" | "committed" | "unverifiable" | "uncommitted";

export interface MarkerInspection {
  txn: string;
  status: MarkerStatus;
  /** The marker's project id ("*" when it cannot be read or names none). */
  projectId: string;
  /** The marker's `projectFolder` as written, when it has one (it may be a different project's folder). */
  projectFolder?: string;
  detail?: string;
  /** The parsed marker, for every status but `invalid`. */
  marker?: TxnMarker;
  /** A choice is recorded in the marker and its `txn.resolve` audit event is already written: only the marker is left. */
  resolveAudited?: boolean;
}

/** Inspects one marker (`.tmp/txn-<fileTxn>.json`). Reads only. */
export async function inspectMarker(root: string, fileTxn: string, anchorOf: (projectId: string) => Head | undefined): Promise<MarkerInspection> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(join(root, ".tmp", `txn-${fileTxn}.json`), "utf8"));
  } catch {
    return { txn: fileTxn, status: "invalid", projectId: "*", detail: "unreadable" };
  }
  const problem = markerProblem(raw, fileTxn) ?? (await unsafeOnDisk(root, raw as TxnMarker));
  if (problem) {
    // An invalid marker may name one project and point into another: report both, so both are blocked.
    const { projectId: pid, projectFolder: pf } = (raw ?? {}) as { projectId?: unknown; projectFolder?: unknown };
    return {
      txn: fileTxn,
      status: "invalid",
      projectId: typeof pid === "string" && isId(pid) ? pid : "*",
      ...(typeof pf === "string" ? { projectFolder: pf } : {}),
      detail: problem,
    };
  }
  const m = raw as TxnMarker;
  const base = { txn: m.txn, projectId: m.projectId, projectFolder: m.projectFolder, marker: m };
  const events = await AuditStore.read(fromRel(root, `${m.projectFolder}/audit`));
  const ofThis = (e: AuditEvent | null): boolean => e !== null && (e.details as { txn?: unknown } | undefined)?.txn === m.txn;
  // A recorded choice whose audit event is written: carried out and recorded, only the marker is left (R131 c).
  if (m.resolve && events.some((e) => ofThis(e) && e!.action === "txn.resolve")) return { ...base, status: m.resolve.status, resolveAudited: true };
  const mine = events.filter((e) => ofThis(e) && e!.action !== "txn.resolve" && e!.decision?.result !== "deny").length;
  if (mine >= m.auditEvents) return { ...base, status: "committed" };
  // Rolling back is only safe when the audit log can be trusted to say "not committed".
  // Only the part of the log written before this transaction is checked: its own tail (possibly a
  // line torn by the crash) is exactly what the rollback truncates.
  const prefix = events.slice(0, m.auditSeqBefore);
  const verify = verifyChain(prefix as AuditEvent[]);
  const prefixOk = verify.ok && prefix.length === m.auditSeqBefore && (verify.head?.seq ?? 0) === m.auditSeqBefore;
  const anchor = anchorOf(m.projectId);
  if (!prefixOk || (anchor && anchor.seq > m.auditSeqBefore)) {
    return {
      ...base,
      status: "unverifiable",
      detail: !prefixOk
        ? "the audit record before this change does not verify, so it cannot show whether the change was finished"
        : `this computer recorded audit events up to event ${anchor!.seq}, later than this change's start (event ${m.auditSeqBefore}), so the change may have been finished`,
    };
  }
  // Undoing truncates appended files back to the recorded sizes: only safe while those sizes still
  // mark where the change began (R131 b).
  const offsets = await offsetProblem(root, m, events, ofThis);
  if (offsets) return { ...base, status: "unverifiable", detail: offsets };
  return { ...base, status: "uncommitted" };
}

/** Number of complete, non-empty lines in `buf` (a whole file, or a prefix of one ending at a line boundary). */
function countLines(buf: Buffer): number {
  const parts = buf.toString("utf8").split("\n");
  return parts.filter((l, i) => i < parts.length - 1 && l.trim() !== "").length;
}

/**
 * Why the marker's recorded append offsets cannot be trusted, or null (R131 b): every offset must
 * lie within its file and on a line boundary, the audit log must hold exactly `auditSeqBefore`
 * events before the transaction's first audit offset, and every event after that must be the
 * transaction's own. Reads only; the reason names no path.
 */
async function offsetProblem(root: string, m: TxnMarker, events: Array<AuditEvent | null>, ofThis: (e: AuditEvent | null) => boolean): Promise<string | null> {
  const auditPrefix = `${m.projectFolder}/audit/`;
  let auditStart: { segment: number; prevSize: number; created: boolean } | undefined;
  for (const e of m.entries) {
    if (e.kind !== "append") continue;
    if (e.path.startsWith(auditPrefix)) {
      const segment = Number.parseInt(e.path.slice(auditPrefix.length), 10);
      if (!auditStart || segment < auditStart.segment) auditStart = { segment, prevSize: e.prevSize, created: e.created };
    }
    if (e.created || e.prevSize === 0) continue; // the whole file is the transaction's
    const fh = await fsp.open(fromRel(root, e.path), "r").catch(() => null);
    if (!fh) continue; // nothing there to truncate
    try {
      if ((await fh.stat()).size < e.prevSize) return "a log file this change added to is now shorter than when the change began";
      const b = Buffer.alloc(1);
      await fh.read(b, 0, 1, e.prevSize - 1);
      if (b[0] !== 0x0a) return "a log file this change added to does not end a line where the change recorded it began";
    } finally {
      await fh.close();
    }
  }
  let before = events.length;
  if (auditStart) {
    before = 0;
    const dir = fromRel(root, `${m.projectFolder}/audit`);
    for (const name of await auditSegments(dir)) {
      const no = Number.parseInt(name, 10);
      if (no > auditStart.segment) break;
      const buf = await fsp.readFile(join(dir, name)).catch(() => null);
      if (!buf) continue;
      if (no < auditStart.segment) before += countLines(buf);
      else if (!auditStart.created) before += countLines(buf.subarray(0, auditStart.prevSize));
    }
  }
  if (before !== m.auditSeqBefore) return `the audit record holds ${before} event(s) where this change began, but the change recorded ${m.auditSeqBefore}`;
  if (events.slice(m.auditSeqBefore).some((e) => !ofThis(e))) return "the audit record holds events written after this change began";
  return null;
}

/** Every marker present, inspected (reads only). */
export async function inspectMarkers(root: string, anchorOf: (projectId: string) => Head | undefined): Promise<MarkerInspection[]> {
  const out: MarkerInspection[] = [];
  for (const name of await listMarkers(root)) out.push(await inspectMarker(root, MARKER.exec(name)![1]!, anchorOf));
  return out;
}

/**
 * Finishes a committed transaction: files it destroyed are overwritten (R90 d), its trash and
 * backups removed, then the marker. Returns false (marker and trash kept, retried later, R92/R94)
 * when a destroyed file could not be overwritten yet.
 */
export async function finishCommitted(root: string, m: TxnMarker): Promise<boolean> {
  if (!(await finishCommittedSteps(root, m))) return false;
  await removeMarker(root, m);
  return true;
}

/** finishCommitted without removing the marker; repeatable (a destroyed file already gone is skipped). */
export async function finishCommittedSteps(root: string, m: TxnMarker): Promise<boolean> {
  let shredded = true;
  for (const e of m.entries) {
    if (e.kind !== "trashed" || !e.shred) continue;
    try {
      await shredPath(fromRel(root, e.to));
    } catch {
      shredded = false;
    }
  }
  if (!shredded) return false;
  for (const e of m.entries) {
    if (e.kind === "trashed") await fsp.rm(fromRel(root, e.to), { recursive: true, force: true }).catch(() => {});
  }
  return true;
}

/** Records the researcher's choice in the marker (atomically) before it is carried out (R131 c). */
export async function recordResolve(root: string, m: TxnMarker, rec: ResolveRecord): Promise<void> {
  const next: TxnMarker = { ...m, resolve: rec };
  await writeSmallFileAtomic(join(root, ".tmp", `txn-${m.txn}.json`), JSON.stringify(next));
  m.resolve = rec;
}

/**
 * Undoes every step of an uncommitted transaction in reverse (partially appended change-log and
 * audit lines included), then removes the marker. Returns false, keeping the marker, when a step failed.
 */
export async function rollBackMarker(root: string, m: TxnMarker): Promise<boolean> {
  if (!(await undoEntries(root, m.entries))) return false;
  await removeMarker(root, m);
  return true;
}

/**
 * Finishes or rolls back every transaction marker left by a crash. Writable
 * libraries only. `anchorOf` returns the external audit anchor of a project.
 */
export async function recoverTransactions(
  root: string,
  anchorOf: (projectId: string) => Head | undefined,
): Promise<RecoveryResult[]> {
  const out: RecoveryResult[] = [];
  for (const name of await listMarkers(root)) {
    const i = await inspectMarker(root, MARKER.exec(name)![1]!, anchorOf);
    const where = { projectId: i.projectId, ...(i.projectFolder !== undefined ? { projectFolder: i.projectFolder } : {}), txn: i.txn };
    if (i.status === "invalid") {
      out.push({ ...where, outcome: "invalid", ...(i.detail ? { detail: i.detail } : {}) });
      continue;
    }
    const m = i.marker!;
    if (m.resolve) {
      // The researcher's recorded choice is completed, and audited, by openRepo (R131 c); never silently here.
      out.push({ ...where, outcome: "resolve-incomplete", detail: `the choice to ${m.resolve.choice === "keep" ? "keep" : "roll back"} it is recorded but could not be completed yet` });
      continue;
    }
    if (i.status === "committed") {
      // Destroyed files are overwritten before they go (R90 d): a crash after the commit finishes it
      // here. If that fails, the marker and the trash stay, and the next open tries again (R92).
      out.push({ projectId: m.projectId, txn: m.txn, outcome: (await finishCommitted(root, m)) ? "committed" : "committed-destroy-pending" });
      continue;
    }
    if (i.status === "unverifiable") {
      out.push({ ...where, outcome: "skipped-audit-unverifiable", ...(i.detail ? { detail: i.detail } : {}) });
      continue;
    }
    if (await rollBackMarker(root, m)) out.push({ projectId: m.projectId, txn: m.txn, outcome: "rolled-back" });
    else out.push({ ...where, outcome: "rollback-incomplete" });
  }
  return out;
}

/** True when `name` (in `.tmp/`) is a backup copy whose marker no longer exists. */
export async function isOrphanBackup(root: string, name: string): Promise<boolean> {
  const m = BACKUP.exec(name);
  return !!m && !(await exists(join(root, ".tmp", `txn-${m[1]}.json`)));
}
