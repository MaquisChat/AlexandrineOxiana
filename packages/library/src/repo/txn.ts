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
 *   uncommitted transaction cannot explain): nothing is touched, the marker is
 *   kept, reported 'txn-recovery-skipped-audit-unverifiable';
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
import { AuditStore, type Head } from "./audit-store.js";
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
async function undoEntries(root: string, entries: MarkerEntry[]): Promise<boolean> {
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

async function removeMarker(root: string, m: TxnMarker): Promise<void> {
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
  | "rolled-back"
  | "rollback-incomplete"
  | "invalid"
  | "skipped-audit-unverifiable";

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
 * Finishes or rolls back every transaction marker left by a crash. Writable
 * libraries only. `anchorOf` returns the external audit anchor of a project.
 */
export async function recoverTransactions(
  root: string,
  anchorOf: (projectId: string) => Head | undefined,
): Promise<RecoveryResult[]> {
  const out: RecoveryResult[] = [];
  for (const name of await listMarkers(root)) {
    const fileTxn = MARKER.exec(name)![1]!;
    let raw: unknown;
    try {
      raw = JSON.parse(await fsp.readFile(join(root, ".tmp", name), "utf8"));
    } catch {
      out.push({ projectId: "*", txn: fileTxn, outcome: "invalid", detail: "unreadable" });
      continue;
    }
    const problem = markerProblem(raw, fileTxn) ?? (await unsafeOnDisk(root, raw as TxnMarker));
    if (problem) {
      // An invalid marker may name one project and point into another: report both, so both are blocked.
      const { projectId: pid, projectFolder: pf } = (raw ?? {}) as { projectId?: unknown; projectFolder?: unknown };
      out.push({
        projectId: typeof pid === "string" && isId(pid) ? pid : "*",
        ...(typeof pf === "string" ? { projectFolder: pf } : {}),
        txn: fileTxn,
        outcome: "invalid",
        detail: problem,
      });
      continue;
    }
    const m = raw as TxnMarker;
    const events = await AuditStore.read(fromRel(root, `${m.projectFolder}/audit`));
    const mine = events.filter(
      (e) => e !== null && e.decision?.result !== "deny" && (e.details as { txn?: unknown } | undefined)?.txn === m.txn,
    ).length;
    if (mine >= m.auditEvents) {
      // Destroyed files are overwritten before they go (R90 d): a crash after the commit finishes it
      // here. If that fails, the marker and the trash stay, and the next open tries again (R92).
      let shredded = true;
      for (const e of m.entries) {
        if (e.kind !== "trashed" || !e.shred) continue;
        try {
          await shredPath(fromRel(root, e.to));
        } catch {
          shredded = false;
        }
      }
      if (!shredded) {
        out.push({ projectId: m.projectId, txn: m.txn, outcome: "committed", detail: "destroyed files could not be overwritten yet; retried on the next open" });
        continue;
      }
      for (const e of m.entries) {
        if (e.kind === "trashed") await fsp.rm(fromRel(root, e.to), { recursive: true, force: true }).catch(() => {});
      }
      await removeMarker(root, m);
      out.push({ projectId: m.projectId, txn: m.txn, outcome: "committed" });
      continue;
    }
    // Rolling back is only safe when the audit log can be trusted to say "not committed".
    // Only the part of the log written before this transaction is checked: its own tail (possibly a
    // line torn by the crash) is exactly what the rollback truncates.
    const prefix = events.slice(0, m.auditSeqBefore);
    const verify = verifyChain(prefix as AuditEvent[]);
    const prefixOk = verify.ok && prefix.length === m.auditSeqBefore && (verify.head?.seq ?? 0) === m.auditSeqBefore;
    const anchor = anchorOf(m.projectId);
    if (!prefixOk || (anchor && anchor.seq > m.auditSeqBefore)) {
      out.push({
        projectId: m.projectId,
        projectFolder: m.projectFolder,
        txn: m.txn,
        outcome: "skipped-audit-unverifiable",
        detail: !prefixOk ? "the audit chain before this change does not verify" : `the audit anchor (event ${anchor!.seq}) is past this transaction's start (event ${m.auditSeqBefore})`,
      });
      continue;
    }
    if (await undoEntries(root, m.entries)) {
      await removeMarker(root, m);
      out.push({ projectId: m.projectId, txn: m.txn, outcome: "rolled-back" });
    } else {
      out.push({ projectId: m.projectId, projectFolder: m.projectFolder, txn: m.txn, outcome: "rollback-incomplete" });
    }
  }
  return out;
}

/** True when `name` (in `.tmp/`) is a backup copy whose marker no longer exists. */
export async function isOrphanBackup(root: string, name: string): Promise<boolean> {
  const m = BACKUP.exec(name);
  return !!m && !(await exists(join(root, ".tmp", `txn-${m[1]}.json`)));
}
