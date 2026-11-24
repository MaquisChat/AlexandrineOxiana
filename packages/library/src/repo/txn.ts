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
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { LibraryRelativePath, isId, newId, verifyChain, type AuditEvent } from "@ao/core";
import { copyFileAtomic, renameWithRetry, writeFileAtomic, writeSmallFileAtomic } from "../fs/atomic.js";
import { AuditStore, auditSegments, type Head } from "./audit-store.js";
import { PathEscapeError } from "./errors.js";
import { shredPath } from "../fs/shred.js";
import { assertContained, exists, readMaybe, undoAppend, type AppendUndo } from "./io.js";
import { seams, type IdentityLookAt } from "./seams.js";

/**
 * `sha256` (created, replaced): of the bytes the change wrote there, when it wrote them itself: a roll-back that finds
 * the file neither so nor as before the change leaves it as it is and is incomplete (R519, R525).
 */
export type MarkerEntry =
  /**
   * `complete` (R503 c 1, R519 (2)): a completion line, written once the file's bytes are durable, for a file written by
   * copying or inside a folder the change created; `sha256` is of the bytes as stored. It is a second "created" line for
   * the path, not a kind of its own: the reader of an older build refuses a marker with a kind it does not know, ignores
   * a field it does not know, and undoes a second "created" line exactly as the first.
   */
  | { kind: "created"; path: string; sha256?: string; complete?: true }
  | { kind: "replaced"; path: string; backup: string; mode: number; sha256?: string }
  /**
   * `ino`, `birthtimeNs` (R526 M2): a completion line, a second "dir" line for the path written once the folder is made,
   * with its identity (only where the file system gives a time of birth). The undo removes the folder only when what is
   * at the path has that identity: one a person made again after an earlier undo removed the change's is left. An older
   * reader ignores the fields and undoes the second line as the first (`rm -r`, the second finding nothing).
   */
  | { kind: "dir"; path: string; ino?: string; birthtimeNs?: string }
  /**
   * `shred`: destroyed, not deleted (R90 d): overwritten before it is removed once committed. `ino`, `birthtimeNs`
   * (R519 (3) as corrected by R526): the original's identity when it was trashed, its file number and its time of birth
   * in nanoseconds (decimal strings), for a file or a folder; a rename keeps both, and an edit in place or a file added
   * inside a folder changes neither: where the trash copy is gone, what has this identity at the path is the original,
   * put back. Recorded only where it is seen to hold: with no time of birth, the line has none; where the look after the
   * rename finds it not kept, a second "trashed" line for the same `from` and `to` says `noIdentity` (an older reader
   * ignores the field and undoes that line as the first), and the first line is then judged as an older build's.
   */
  | { kind: "trashed"; from: string; to: string; shred?: boolean; ino?: string; birthtimeNs?: string; noIdentity?: true }
  | { kind: "append"; path: string; prevSize: number; created: boolean };

/** The identity a "trashed" line records of its original (R519 (3), R526): its file number and time of birth. */
export interface FileIdentity {
  ino: string;
  birthtimeNs: string;
}

/**
 * The identity of what is at `abs` (not following a link), as the file system gives it (R526), or undefined when it
 * gives no time of birth (zero): then no identity can be recorded. Throws when it cannot look (ENOENT included).
 */
export async function identityOf(abs: string, at: IdentityLookAt): Promise<FileIdentity | undefined> {
  const st = await fsp.lstat(abs, { bigint: true });
  let id = { ino: st.ino, birthtimeNs: st.birthtimeNs };
  if (process.env.NODE_ENV === "test" && seams.identityLook) id = seams.identityLook(at, id);
  return id.birthtimeNs === 0n ? undefined : { ino: id.ino.toString(), birthtimeNs: id.birthtimeNs.toString() };
}

/**
 * The researcher's choice for an interrupted change (R27, R131 c), written into the marker before
 * anything is done, so that a crash or a failed audit append leaves it to be completed (and audited)
 * on the next open rather than done silently. `status` is what the marker showed when the choice was made.
 */
export interface ResolveRecord {
  choice: "keep" | "roll-back";
  status: "committed" | "uncommitted";
  at: string;
  /**
   * R509: the researcher chose to close the change as it is (its undo can never complete). Recorded as a roll-back
   * with this field, which an older build ignores (it reads, and retries, a roll-back), never as a choice of its own.
   */
  close?: true;
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

/** R503 a: the programming error of a transaction asked to both append to a file and rewrite it (its words name no ruling, R509). */
export const MIXED_WRITE =
  "A change must not both append to a file and rewrite that same file: if it were interrupted, it could not always be undone. Cut a torn last line in a change of its own, then append in the next.";

export const toRel = (root: string, abs: string): string => relative(root, abs).split(sep).join("/");
export const fromRel = (root: string, rel: string): string => join(root, ...rel.split("/"));

export class TxnLog {
  readonly marker: TxnMarker;
  private backups = 0;
  /** Folders this transaction created: their contents go with them on undo. */
  private readonly newDirs: string[] = [];
  /** Files already appended to in this transaction: undo truncates them to the first recorded size. */
  private readonly appended = new Set<string>();
  /** R503 a: every file this transaction appended to, and every file it wrote whole (created or replaced), trash or not. */
  private readonly appendedEver = new Set<string>();
  private readonly rewritten = new Set<string>();
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

  /**
   * R503 a: a transaction never both appends to a file and rewrites that same file, in either order (with or without a
   * trash between): its undo could not always tell where the append began, so a crash would leave a change that is
   * refused at every opening. A programming error, thrown before the offending step records or writes anything.
   */
  private refuseMixed(rel: string, as: "append" | "rewrite"): void {
    if ((as === "append" ? this.rewritten : this.appendedEver).has(rel)) throw new Error(MIXED_WRITE);
    (as === "append" ? this.appendedEver : this.rewritten).add(rel);
  }

  async created(abs: string, sha256?: string) {
    const rel = toRel(this.root, abs);
    this.refuseMixed(rel, "rewrite");
    // A file in a folder this transaction created needs no step of its own.
    if (this.inNewDir(rel)) return;
    await this.add({ kind: "created", path: rel, ...(sha256 ? { sha256 } : {}) });
  }

  /** Copies the current file aside (same mode, so 0600 stays 0600), then records it. */
  async replaced(abs: string, mode: number, sha256?: string) {
    this.refuseMixed(toRel(this.root, abs), "rewrite");
    await fsp.mkdir(this.dir, { recursive: true });
    const backup = join(this.dir, `txn-${this.id}.orig-${this.backups++}`);
    await copyFileAtomic(abs, backup, { mode });
    await this.add({ kind: "replaced", path: toRel(this.root, abs), backup: toRel(this.root, backup), mode, ...(sha256 ? { sha256 } : {}) });
  }

  /** Whether `abs` lies inside a folder this transaction created (a file written there has no line before its write). */
  inCreatedDir(abs: string): boolean {
    return this.inNewDir(toRel(this.root, abs));
  }

  /**
   * The completion line of a file just written whole and made durable (R503 c 1, R519 (2)): a second "created" line for
   * the path with the hash of its bytes as stored. Recorded after the write, so a file with no such line is the
   * change's own half-written one. Not a second write of the file (R503 a's rule is not asked again).
   */
  async completed(abs: string, sha256: string) {
    await this.add({ kind: "created", path: toRel(this.root, abs), sha256, complete: true });
  }

  /** The completion line of a folder this transaction just made (R526 M2): its identity, when there is one to record. */
  async dirMade(abs: string) {
    const identity = await identityOf(abs, "dir-made").catch(() => undefined);
    if (identity) await this.add({ kind: "dir", path: toRel(this.root, abs), ...identity });
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

  async trashed(from: string, to: string, shred = false, identity?: FileIdentity) {
    const rel = toRel(this.root, from);
    // What was at or under `from` is gone: a later append or folder there is new and needs its own
    // step (else undo would truncate or remove the new file and leave the original in the trash).
    const covers = (p: string) => p === rel || p.startsWith(`${rel}/`);
    for (const p of [...this.appended]) if (covers(p)) this.appended.delete(p);
    for (let i = this.newDirs.length - 1; i >= 0; i--) if (covers(this.newDirs[i]!)) this.newDirs.splice(i, 1);
    await this.add({ kind: "trashed", from: rel, to: toRel(this.root, to), ...(shred ? { shred: true } : {}), ...(identity ?? {}) });
  }

  /**
   * R526: the look after the rename found the identity recorded on the "trashed" line not kept (or could not look): a
   * second line for the same move says so, and that line is judged as an older build's. Written after the first line and
   * the rename, as a completion line is: a marker cut between the two keeps an identity that may not hold (see undoEntries).
   */
  async identityNotKept(from: string, to: string) {
    await this.add({ kind: "trashed", from: toRel(this.root, from), to: toRel(this.root, to), noIdentity: true });
  }

  async append(u: AppendUndo) {
    const rel = toRel(this.root, u.path);
    this.refuseMixed(rel, "append");
    // A later append to the same file is covered by the first step (undo truncates to its size).
    if (this.appended.has(rel) || this.inNewDir(rel)) return;
    this.appended.add(rel);
    await this.add({ kind: "append", path: rel, prevSize: u.prevSize, created: u.created });
  }

  /** Undoes every recorded step in reverse; `ok` is false if any step failed or was left (R519). */
  undo(): Promise<UndoResult> {
    return undoEntries(this.root, this.marker.entries);
  }

  /** Removes the marker and its backup copies (after commit, or after a complete rollback). */
  async finish(): Promise<void> {
    await removeMarker(this.root, this.marker);
  }
}

/** Why a roll-back left a path as it found it (R519): a cause and the library-relative path, for the words shown. */
export type UndoCauseKind =
  /**
   * A file the change wrote (created or replaced) holds bytes that are none of the change's own, a folder stands where it
   * wrote a file, or a folder it made is there with another identity (R527): changed or put there by hand, or not known
   * to be the change's own.
   */
  | "hand-changed-file"
  /** A trashed original cannot be put back: something not of the change stands at its path (only there, R527). */
  | "path-occupied"
  /** The copy the app kept of a trashed original is gone, and the original is not at its path: it cannot be put back. */
  | "kept-copy-gone"
  /** What is at the path could not be looked at (permission, I/O): nothing there was touched. */
  | "could-not-look";
export interface UndoCause {
  kind: UndoCauseKind;
  path: string;
  /**
   * `kept-copy-gone` only (R527): something stands at the place, which the undo cannot confirm is the file the change
   * removed (the words then never say that file is lost). Absent: nothing is there, and the file is lost.
   */
  somethingThere?: true;
  /**
   * `could-not-look` only (R532 M1): the place of a file the change removed, whose kept copy is gone, could not be looked
   * at: that file may be lost, so the state speaks of the loss first (never "nothing was lost"); the list names the
   * place as one the app could not read, and says nothing of what is there.
   */
  copyGone?: true;
  /**
   * `could-not-look` only (R533 (1)): what could not be read is the copy the app kept of the file the change removed from
   * the place (not the place itself); the list says so, and sends the researcher to the library's work folder.
   */
  copyUnread?: true;
}
/** `ok`: every step undone (or already undone); `causes`: what kept a path from being undone, when known. */
export interface UndoResult {
  ok: boolean;
  causes: UndoCause[];
  /** A step failed for no cause the undo can name (FR-736: such a roll-back may complete when tried again). */
  stepFailed?: true;
}

/** What is at a path: nothing, a regular file (with the hash of its bytes), a folder, or something else. Throws when it cannot be looked at. */
type Look = { at: "nothing" } | { at: "file"; sha256: string } | { at: "folder" } | { at: "other" };
async function look(root: string, rel: string): Promise<Look> {
  if (process.env.NODE_ENV === "test" && seams.failLook === rel) throw new Error("simulated read failure");
  const st = await fsp.lstat(fromRel(root, rel)).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  });
  if (!st) return { at: "nothing" };
  if (st.isDirectory()) return { at: "folder" };
  if (!st.isFile()) return { at: "other" };
  const sha256 = await sha256File(fromRel(root, rel));
  return sha256 === null ? { at: "nothing" } : { at: "file", sha256 };
}

/**
 * What a "trashed" line `i` moved, by the lines before it: "the original" when no earlier line of the change is at,
 * under or above its path; "the change's" when an earlier line made it (created or replaced it whole, made the folder
 * or one above it, or created it by appending): then nothing of the researcher's is in that copy (a replaced file's
 * original is in its backup); "changed by the change" when the change only added to it (an append, or lines under a
 * folder): the original with the change's additions. The first and the last are judged alike by the original's
 * identity, which the undo of those additions in place keeps (R526).
 */
function trashedContent(entries: MarkerEntry[], i: number): "the original" | "the change's" | "changed by the change" {
  const from = (entries[i] as Extract<MarkerEntry, { kind: "trashed" }>).from;
  let changed = false;
  for (let j = 0; j < i; j++) {
    const x = entries[j]!;
    const p = x.kind === "trashed" ? x.from : x.path;
    if (from.startsWith(`${p}/`) && x.kind === "dir") return "the change's";
    if (p === from) {
      if (x.kind === "created" || x.kind === "replaced" || x.kind === "dir" || (x.kind === "append" && x.created)) return "the change's";
      changed = true;
    } else if (p.startsWith(`${from}/`)) changed = true;
  }
  return changed ? "changed by the change" : "the original";
}

/**
 * The identity "trashed" line `i` recorded of its original, or undefined: none recorded (an older build's line, or no
 * time of birth), or a later line for the same move says it was not kept by the rename (R526).
 */
function trashedIdentity(entries: MarkerEntry[], i: number): FileIdentity | undefined {
  const e = entries[i] as Extract<MarkerEntry, { kind: "trashed" }>;
  if (e.ino === undefined || e.birthtimeNs === undefined) return undefined;
  const lost = entries.some((x, j) => j > i && x.kind === "trashed" && x.noIdentity === true && x.from === e.from && x.to === e.to);
  return lost ? undefined : { ino: e.ino, birthtimeNs: e.birthtimeNs };
}

/**
 * What is at `rel` against `id` (R519 (3), R526): nothing; "it", the same file number and time of birth, which a rename
 * inside the volume, an edit in place and a file added inside a folder all keep (a file made after another was deleted
 * may get its number, never its time of birth); or something "other". Throws when it cannot look.
 */
async function identityAt(root: string, rel: string, id: FileIdentity): Promise<"nothing" | "it" | "other"> {
  if (process.env.NODE_ENV === "test" && seams.failLook === rel) throw new Error("simulated read failure");
  const st = await fsp.lstat(fromRel(root, rel), { bigint: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  });
  if (st === null) return "nothing";
  return st.ino.toString() === id.ino && st.birthtimeNs.toString() === id.birthtimeNs ? "it" : "other";
}

/** Whether a "trashed" line after line `i` moves the path of "dir" line `i`, or a folder above it, away. */
const dirTrashedLater = (entries: MarkerEntry[], i: number): boolean => {
  const p = (entries[i] as Extract<MarkerEntry, { kind: "dir" }>).path;
  return entries.some((x, j) => j > i && x.kind === "trashed" && (p === x.from || p.startsWith(`${x.from}/`)));
};

/**
 * The identity the completion line of "dir" line `i` recorded of the folder the change made (R526 M2): the next "dir"
 * line at that path, before a trash at or above it; undefined when there is none (an older build's line, no time of
 * birth, or a crash between the folder and its completion line).
 */
function dirIdentity(entries: MarkerEntry[], i: number): FileIdentity | undefined {
  const e = entries[i] as Extract<MarkerEntry, { kind: "dir" }>;
  for (let j = i + 1; j < entries.length; j++) {
    const x = entries[j]!;
    if (x.kind === "dir" && x.path === e.path) return x.ino !== undefined && x.birthtimeNs !== undefined ? { ino: x.ino, birthtimeNs: x.birthtimeNs } : undefined;
    if (x.kind === "trashed" && (e.path === x.from || e.path.startsWith(`${x.from}/`))) return undefined;
  }
  return undefined;
}

/** The hashes the change recorded for what it wrote at `rel` ("created", completion and "replaced" lines). */
const writeHashes = (entries: MarkerEntry[], rel: string): string[] =>
  entries.flatMap((x) => ((x.kind === "created" || x.kind === "replaced") && x.path === rel && x.sha256 ? [x.sha256] : []));

/** Whether the regular file at `rel` holds bytes one of `later` ("created"/"replaced" lines at that path) wrote. */
async function ownBytesAt(root: string, rel: string, later: MarkerEntry[]): Promise<boolean> {
  const hashes = writeHashes(later, rel);
  if (!hashes.length) return false;
  const now = await look(root, rel);
  return now.at === "file" && hashes.includes(now.sha256);
}

/**
 * Whether the change knows the bytes of the file "created" line `i` wrote: the line's own hash (a file written whole,
 * atomically) or its completion line's (R519 (2)), the next completion line at that path before anything else of the
 * change at or above it. A created line with neither is a copy cut off: whatever is at the path is the change's own.
 */
function knowsBytes(entries: MarkerEntry[], i: number): boolean {
  const e = entries[i] as Extract<MarkerEntry, { kind: "created" }>;
  if (e.sha256) return true;
  for (let j = i + 1; j < entries.length; j++) {
    const x = entries[j]!;
    if (x.kind === "created" && x.path === e.path) return x.complete === true;
    if (x.kind === "trashed" && (e.path === x.from || e.path.startsWith(`${x.from}/`))) return false;
    if (x.kind !== "trashed" && x.path === e.path) return false;
  }
  return false;
}

/**
 * Best effort: keeps going past failures, and reports whether every step succeeded, with the causes it knows. Repeatable
 * (R493): a step already undone is never undone again. A "trashed" line whose trash copy is gone was put back by an
 * earlier run of this roll-back (every step is recorded before it is taken, so a copy never made means the change
 * stopped there, with no later line), and every later line of the marker at or under that path (R503 b 1) was undone
 * before it: those lines are skipped, since undoing one again could only remove or overwrite the original put back.
 * Unless the change's own bytes are still at that path (R503 b 2): then the copy was deleted outside the app, not put
 * back; the lines are skipped all the same (nothing is deleted) and the roll-back is not complete.
 *
 * R519: never deletes, overwrites or moves a file it can tell is not the change's own. A "created" line's file is
 * removed only when it holds bytes the change recorded at that path, or when the change recorded none for it (its copy
 * was cut off: a half-written file of its own); a "replaced" line's backup is put back only over nothing, over bytes the
 * change wrote at that path, or over bytes it kept aside there (put back already). Otherwise the file stays as it is,
 * the path is "blocked": no earlier line at, under or above it is undone either (each would remove or overwrite it),
 * and the roll-back is incomplete with the cause and the path. Moved away by the researcher, the next run completes.
 */
export async function undoEntries(root: string, entries: MarkerEntry[]): Promise<UndoResult> {
  let ok = true;
  const causes: UndoCause[] = [];
  let stepFailed = false;
  const because = (kind: UndoCauseKind, path: string, somethingThere = false, copyGone = false, copyUnread = false) => {
    ok = false;
    if (!causes.some((c) => c.kind === kind && c.path === path)) {
      causes.push({
        kind,
        path,
        ...(somethingThere ? { somethingThere: true as const } : {}),
        ...(copyGone ? { copyGone: true as const } : {}),
        ...(copyUnread ? { copyUnread: true as const } : {}),
      });
    }
  };
  const done = new Set<number>();
  /** Paths where something not of the change, or not known to be, was left as it is (R519). */
  const blocked: string[] = [];
  for (const [i, e] of entries.entries()) {
    // A line that says the identity was not kept is no step of its own: its first line's move (R526).
    if (e.kind !== "trashed" || e.noIdentity) continue;
    let putBack: boolean;
    let copyUnread = false;
    try {
      // The look seam (R47, "test" only) reaches the look at the kept copy too (R532 M1).
      if (process.env.NODE_ENV === "test" && seams.failLook === e.to) throw new Error("simulated read failure");
      putBack = !(await exists(fromRel(root, e.to)));
    } catch {
      // Not known whether it was put back: nothing at that path is undone again, and the roll-back is not complete.
      putBack = true;
      copyUnread = true;
      because("could-not-look", e.from, false, false, true);
    }
    if (!putBack) continue;
    const earlier = trashedContent(entries, i);
    const id = trashedIdentity(entries, i);
    if (copyUnread) {
      // R532 M1: not known whether the kept copy is there: it is never said to be gone, and nothing at, under or above
      // the place is undone (each would remove or overwrite what may be the original, or what the copy must go back to).
      blocked.push(e.from);
    } else if (id === undefined) {
      // An older build's line (no identity), judged as before. R503 b 2: a copy gone while the change's own bytes (a
      // later line's hash) are still at the path was not put back: it was deleted outside the app. The roll-back is
      // then not complete (the marker is kept); nothing is deleted.
      try {
        if (await ownBytesAt(root, e.from, entries.slice(i + 1))) because("kept-copy-gone", e.from, true);
      } catch {
        // R532 M1: the copy is gone and the place could not be looked at: the file may be lost.
        because("could-not-look", e.from, false, true);
      }
    } else if (earlier !== "the change's") {
      // R519 (3), R526: the line knows the original's identity (file number, time of birth). What has it at the path IS
      // the original, put back (or never moved: a crash between the line and its rename), whatever its bytes or its
      // times now (R509 M1; edited in place, a file added inside the folder, the change's additions undone in place).
      // The change's own file, anything else (a reused file number included: born later), or nothing there: the
      // original was not put back and cannot be, the copy being gone (R509 M2). Nothing at the path is deleted, cut or
      // moved, and no line at or under it is undone. A marker cut between the line and the one saying the identity was
      // not kept holds an identity that may not hold: an original put back then does not match, and the roll-back is
      // incomplete (kept-copy-gone), closable: the safe side; what matches is the original (a rename that does not keep
      // the time of birth gives the original a new one, never another file the recorded one).
      try {
        const there = await identityAt(root, e.from, id);
        if (there !== "it") {
          because("kept-copy-gone", e.from, there === "other");
          blocked.push(e.from);
        }
      } catch {
        // R532 M1: the copy is gone and the place could not be looked at: the file may be lost (the loss leads).
        because("could-not-look", e.from, false, true);
        blocked.push(e.from);
      }
    }
    // Else the copy held only what the change itself had made (an earlier line made it whole): put back or deleted by
    // hand, nothing of the researcher's is lost with it, and the earlier lines' undo (which removes or overwrites only
    // the change's own bytes) brings the path back to its state before the change. The later lines are skipped (R493).
    for (let j = i + 1; j < entries.length; j++) {
      const x = entries[j]!;
      // R503 b 1: at or under the path (a file inside a folder the change trashed and made again).
      const p = x.kind === "trashed" ? x.from : x.path;
      if (p === e.from || p.startsWith(`${e.from}/`)) done.add(j);
    }
  }
  const block = (kind: UndoCauseKind, path: string) => {
    because(kind, path);
    blocked.push(path);
  };
  // R527: a folder the change made, found at its path with ANOTHER identity, cannot be told from the change's own folder
  // under a new identity (the library copied or restored between the crash and the reopening changes every identity) or
  // from one a person made again: the undo removes nothing at, under or above it and is NOT done (hand-changed-file, the
  // folder's path); moved out of the library by the researcher, the roll-back completes. Decided before any line is
  // undone, so that no file of the change inside it is removed either: nothing is left half-removed. A folder a later
  // line moves away (a trash at or above it) is judged when its line is reached, once that trash is undone.
  for (const [i, e] of entries.entries()) {
    if (e.kind !== "dir" || e.ino !== undefined || done.has(i) || dirTrashedLater(entries, i)) continue;
    const id = dirIdentity(entries, i);
    if (id === undefined) continue;
    try {
      if ((await identityAt(root, e.path, id)) === "other") block("hand-changed-file", e.path);
    } catch {
      block("could-not-look", e.path);
    }
  }
  const isBlocked = (p: string) => blocked.some((b) => p === b || p.startsWith(`${b}/`) || b.startsWith(`${p}/`));
  let steps = 0;
  /** Test seam (R47): the roll-back is cut off here, as by a crash. */
  const cut = (): boolean => {
    if (process.env.NODE_ENV !== "test" || seams.stopUndoAfter !== steps) return false;
    seams.stopUndoAfter = undefined;
    return true;
  };
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (cut()) return { ok: false, causes };
    steps++;
    if (done.has(i)) continue;
    if (e.kind === "trashed" && e.noIdentity) continue; // its first line undoes the move (R526)
    if (e.kind === "dir" && e.ino !== undefined) continue; // a completion line: its first line removes the folder (R526 M2)
    const at = e.kind === "trashed" ? e.from : e.path;
    if (isBlocked(at)) continue; // left for the researcher, with the line that found it (the roll-back is not complete)
    try {
      if (seams.failUndo === e.kind) throw new Error(`simulated undo failure (${e.kind})`);
      if (e.kind === "created") {
        let now: Look;
        try {
          now = await look(root, e.path);
        } catch {
          block("could-not-look", e.path);
          continue;
        }
        if (now.at === "nothing") continue;
        // R526 M4 (R527: changed or put there outside the app): a folder stands where the change wrote a file: never the
        // change's own; named, nothing removed.
        if (now.at === "folder") {
          block("hand-changed-file", e.path);
          continue;
        }
        if (knowsBytes(entries, i) && !(now.at === "file" && writeHashes(entries, e.path).includes(now.sha256))) {
          block("hand-changed-file", e.path);
          continue;
        }
        await fsp.rm(fromRel(root, e.path), { force: true });
      } else if (e.kind === "dir") {
        // R526 M2 as R527 rules it: with a recorded identity, the folder is removed only when it is the change's own.
        // Nothing there: done. Anything else (a folder a person made again, or the change's own under a new identity):
        // left exactly as it is, and NOT done (hand-changed-file). Without an identity: as before.
        const id = dirIdentity(entries, i);
        if (id !== undefined) {
          let there: "nothing" | "it" | "other";
          try {
            there = await identityAt(root, e.path, id);
          } catch {
            block("could-not-look", e.path);
            continue;
          }
          if (there === "nothing") continue;
          if (there === "other") {
            block("hand-changed-file", e.path);
            continue;
          }
        }
        await fsp.rm(fromRel(root, e.path), { recursive: true, force: true });
      }
      else if (e.kind === "replaced") {
        const backup = fromRel(root, e.backup);
        if (!(await exists(backup))) continue;
        if (e.sha256) {
          // A line of an older build carries no hash: judged as before (put back).
          let now: Look;
          let kept: string[];
          try {
            now = await look(root, e.path);
            kept = [];
            for (const x of entries) {
              if (x.kind !== "replaced" || x.path !== e.path) continue;
              const h = await sha256File(fromRel(root, x.backup));
              if (h !== null) kept.push(h);
            }
          } catch {
            block("could-not-look", e.path);
            continue;
          }
          if (now.at === "other" || now.at === "folder" || (now.at === "file" && !writeHashes(entries, e.path).includes(now.sha256) && !kept.includes(now.sha256))) {
            block("hand-changed-file", e.path);
            continue;
          }
        }
        await writeFileAtomic(fromRel(root, e.path), await fsp.readFile(backup), { mode: e.mode });
      } else if (e.kind === "trashed") {
        const to = fromRel(root, e.to);
        if (await exists(to)) {
          // Steps after it are undone first, so something at the path now is the change's own only when a later undo
          // failed (R519 (1)): its bytes, by a later line's hash, are removed as that line's undo does, then the
          // original is put back. Anything else is never overwritten or removed: the step is not done, so the marker,
          // and with it the trash copy, is kept for the researcher to move it away (R491 C a, R519: path-occupied).
          let occupied: boolean;
          try {
            occupied = (await look(root, e.from)).at !== "nothing";
            if (occupied && (await ownBytesAt(root, e.from, entries.slice(i + 1)))) {
              await fsp.rm(fromRel(root, e.from), { force: true });
              occupied = false;
            }
          } catch {
            block("could-not-look", e.from);
            continue;
          }
          if (occupied) block("path-occupied", e.from);
          else await renameWithRetry(to, fromRel(root, e.from));
        }
      } else {
        // Nothing to undo when the file is gone or is not a regular file (the append never happened).
        const path = fromRel(root, e.path);
        const st = await fsp.lstat(path).catch(() => null);
        if (st?.isFile() && (e.created || st.size > e.prevSize)) await undoAppend({ path, prevSize: e.prevSize, created: e.created });
      }
    } catch {
      ok = false;
      stepFailed = true;
    }
  }
  if (cut()) return { ok: false, causes };
  return { ok, causes, ...(stepFailed ? { stepFailed: true as const } : {}) };
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
    if (
      !r ||
      typeof r !== "object" ||
      (r.choice !== "keep" && r.choice !== "roll-back") ||
      (r.status !== "committed" && r.status !== "uncommitted") ||
      typeof r.at !== "string" ||
      (r.close !== undefined && (r.close !== true || r.choice !== "roll-back"))
    ) {
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
        // A folder's identity (R526 M2): whole or absent, on a "dir" line only.
        if (en.ino !== undefined || en.birthtimeNs !== undefined) {
          if (en.kind !== "dir" || !isDigits(en.ino) || !isDigits(en.birthtimeNs)) return "bad entry";
        }
        if (en.sha256 !== undefined && (en.kind === "dir" || !isSha(en.sha256))) return "bad entry";
        if (en.complete !== undefined && (en.kind === "dir" || en.complete !== true || en.sha256 === undefined)) return "bad entry";
        break;
      case "replaced":
        if (!under(en.path, pf)) return "replaced path outside the project";
        if (en.sha256 !== undefined && !isSha(en.sha256)) return "bad entry";
        if (!isBackupOf(en.backup, x.txn)) return "backup is not this transaction's copy in .tmp";
        if (!count(en.mode) || (en.mode as number) > 0o777) return "bad mode";
        break;
      case "trashed":
        if (!under(en.from, pf)) return "trashed path outside the project";
        if (!isTrashOf(en.to, x.txn)) return "trash is not this transaction's folder in .tmp";
        if (en.shred !== undefined && typeof en.shred !== "boolean") return "bad trashed entry";
        // The identity is whole or absent (an older build's line): never judged on part of it (R526: number and birth).
        if (en.ino !== undefined || en.birthtimeNs !== undefined) {
          if (!isDigits(en.ino) || !isDigits(en.birthtimeNs)) return "bad trashed entry";
        }
        // A line saying the identity was not kept carries none itself.
        if (en.noIdentity !== undefined && (en.noIdentity !== true || en.ino !== undefined)) return "bad trashed entry";
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
  /** Not finished or rolled back: the paths the (readable) marker names, which stay half changed until it is (R473 I1). */
  paths?: string[];
  /** Not completely rolled back: what kept each path from being undone, when known (R519). */
  causes?: UndoCause[];
  /** Not completely rolled back: a step failed for no cause the undo could name (FR-736). */
  stepFailed?: true;
  /** Not completely rolled back: a copy of the change is still kept, where that chooses its state (R528, `copyKeptOf`). */
  copyKept?: true;
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
 * audit lines included), then removes the marker. Not ok, keeping the marker, when a step failed or was left (R519).
 */
export async function rollBackMarker(root: string, m: TxnMarker): Promise<UndoResult> {
  const r = await undoEntries(root, m.entries);
  if (r.ok) await removeMarker(root, m);
  return r;
}

/**
 * R528 M8: what stands at a place now, for the close's question: "nothing" only when the app looked and found nothing
 * there; a look that failed (a permission or I/O error) is "could-not-look", never "nothing". The roll-back's look seam
 * (`seams.failLook`, honoured only when NODE_ENV is "test", R47) reaches it.
 */
export async function lookNow(root: string, rel: string): Promise<"nothing" | "a file" | "something else" | "could-not-look"> {
  try {
    if (process.env.NODE_ENV === "test" && seams.failLook === rel) throw new Error("simulated read failure");
    const s = await fsp.lstat(fromRel(root, rel));
    return s.isFile() ? "a file" : "something else";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "nothing" : "could-not-look";
  }
}

/**
 * R532 I1, R533 (4): whether the backup of "replaced" line `i` may hold bytes that are not the change's own. It holds
 * only the change's own bytes where the nearest earlier line of the change at its path shows the change wrote the file
 * there from bytes of its own making: an earlier "replaced" line at the path (the backup holds that rewrite's bytes), a
 * "created" line with a hash of its own and no completion mark (a file written whole), or a file the change created by
 * appending. Every other origin counts as holding the researcher's bytes (the safe side): the path was there before the
 * change; the change created it BY COPYING a file (a "created" line with no hash of its own, whose completion line
 * carries the hash as stored); or it lies in a folder the change made, where a copy and a write leave the same line.
 */
function backupHoldsOriginal(entries: MarkerEntry[], i: number): boolean {
  const path = (entries[i] as Extract<MarkerEntry, { kind: "replaced" }>).path;
  for (let j = i - 1; j >= 0; j--) {
    const x = entries[j]!;
    if (x.kind === "trashed" || x.kind === "dir" || x.path !== path) continue;
    if (x.kind === "replaced" || (x.kind === "append" && x.created)) return false;
    if (x.kind === "created" && x.complete !== true) return x.sha256 === undefined;
  }
  return true;
}

/**
 * Whether the app still keeps a copy of something of the researcher's that is not back in its place: a trash copy, or
 * the backup of a replaced file that holds bytes not the change's own (`backupHoldsOriginal`) and whose bytes are not
 * at its path. Removing the marker lets such a copy go (its backups are deleted with it, and the next opening sweeps the
 * trash): closing must delete nothing (R509), so it waits; where nothing else stops the undo and its own copy is gone,
 * nothing the researcher can do in the app remains (R528 M2). The change's own intermediate bytes do not hold it (R532);
 * a copy the change made of a file of the library does (R533 (4)).
 */
export async function keptCopiesLeft(root: string, m: Pick<TxnMarker, "entries">): Promise<boolean> {
  for (const [i, e] of m.entries.entries()) {
    if (e.kind === "trashed" && (await exists(fromRel(root, e.to)))) return true;
    if (e.kind === "replaced" && backupHoldsOriginal(m.entries, i)) {
      const backup = await readMaybe(fromRel(root, e.backup));
      if (backup === null) continue;
      const now = await readMaybe(fromRel(root, e.path)).catch(() => null);
      if (now === null || !now.equals(backup)) return true;
    }
  }
  return false;
}

/**
 * R528: whether an incomplete undo's state must know that a copy is still kept (`keptCopiesLeft`): only where a copy is
 * gone and nothing else stops the undo (it then tells "lost" from "lost-copy-stuck"). A look that fails counts as kept
 * (the safe side: no close is offered).
 */
export async function copyKeptOf(root: string, m: Pick<TxnMarker, "entries">, r: Pick<UndoResult, "causes" | "stepFailed">): Promise<boolean> {
  if (r.stepFailed || r.causes.length === 0 || !r.causes.every((c) => c.kind === "kept-copy-gone")) return false;
  return keptCopiesLeft(root, m).catch(() => true);
}

/** The library-relative paths a marker names (the files and folders its change touched). */
export function markerPaths(m: Pick<TxnMarker, "entries">): string[] {
  return m.entries.map((e) => (e.kind === "trashed" ? e.from : e.path));
}

const isDigits = (x: unknown): boolean => typeof x === "string" && /^\d{1,30}$/u.test(x);
const isSha = (x: unknown): boolean => typeof x === "string" && /^[0-9a-f]{64}$/u.test(x);
const sha256File = async (abs: string): Promise<string | null> => {
  try {
    return createHash("sha256").update(await fsp.readFile(abs)).digest("hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw err;
  }
};

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
      out.push({ ...where, paths: markerPaths(m), outcome: "resolve-incomplete", detail: `the choice to ${m.resolve.choice === "keep" ? "keep" : "roll back"} it is recorded but could not be completed yet` });
      continue;
    }
    if (i.status === "committed") {
      // Destroyed files are overwritten before they go (R90 d): a crash after the commit finishes it
      // here. If that fails, the marker and the trash stay, and the next open tries again (R92).
      out.push({ projectId: m.projectId, txn: m.txn, outcome: (await finishCommitted(root, m)) ? "committed" : "committed-destroy-pending" });
      continue;
    }
    if (i.status === "unverifiable") {
      out.push({ ...where, paths: markerPaths(m), outcome: "skipped-audit-unverifiable", ...(i.detail ? { detail: i.detail } : {}) });
      continue;
    }
    // R519: a file found changed outside the app is never put back over (it is left, with its cause), so nothing of an
    // outside change is lost silently: there is no "changed outside, not kept" to report any more.
    const r = await rollBackMarker(root, m);
    if (r.ok) out.push({ projectId: m.projectId, txn: m.txn, outcome: "rolled-back" });
    else {
      const copyKept = await copyKeptOf(root, m, r);
      out.push({
        ...where,
        paths: markerPaths(m),
        outcome: "rollback-incomplete",
        ...(r.causes.length ? { causes: r.causes } : {}),
        ...(r.stepFailed ? { stepFailed: true as const } : {}),
        ...(copyKept ? { copyKept: true as const } : {}),
      });
    }
  }
  return out;
}

/** True when `name` (in `.tmp/`) is a backup copy whose marker no longer exists. */
export async function isOrphanBackup(root: string, name: string): Promise<boolean> {
  const m = BACKUP.exec(name);
  return !!m && !(await exists(join(root, ".tmp", `txn-${m[1]}.json`)));
}
