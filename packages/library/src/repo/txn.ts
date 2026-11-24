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
import { assertContained, exists, undoAppend, type AppendUndo } from "./io.js";
import { seams } from "./seams.js";

/**
 * `sha256` (created, replaced): of the bytes the change wrote there, when it wrote them itself (R473 I1 3): a
 * roll-back that finds the file neither so nor as before the change records that it was changed outside the app.
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
  | { kind: "dir"; path: string }
  /**
   * `shred`: destroyed, not deleted (R90 d): overwritten before it is removed once committed. `ino`, `size`, `mtimeNs`
   * (R519 (3)): the original's identity when it was trashed (the file number and the time of last modification in
   * nanoseconds as decimal strings), which a rename keeps: where the trash copy is gone, a file with this identity at
   * the path is the original, put back.
   */
  | { kind: "trashed"; from: string; to: string; shred?: boolean; ino?: string; size?: number; mtimeNs?: string }
  | { kind: "append"; path: string; prevSize: number; created: boolean };

/** The identity a "trashed" line records of its original (R519 (3)). */
export interface FileIdentity {
  ino: string;
  size: number;
  mtimeNs: string;
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
  /** A file the change wrote (created or replaced) holds bytes that are none of the change's own: changed or put there by hand. */
  | "hand-changed-file"
  /** A trashed original cannot be put back: something not of the change stands at its path. */
  | "path-occupied"
  /** The copy the app kept of a trashed original is gone, and the original is not at its path: it cannot be put back. */
  | "kept-copy-gone"
  /** What is at the path could not be looked at (permission, I/O): nothing there was touched. */
  | "could-not-look";
export interface UndoCause {
  kind: UndoCauseKind;
  path: string;
}
/** `ok`: every step undone (or already undone); `causes`: what kept a path from being undone, when known. */
export interface UndoResult {
  ok: boolean;
  causes: UndoCause[];
}

/** What is at a path: nothing, a regular file (with the hash of its bytes), or something else. Throws when it cannot be looked at. */
type Look = { at: "nothing" } | { at: "file"; sha256: string } | { at: "other" };
async function look(root: string, rel: string): Promise<Look> {
  if (process.env.NODE_ENV === "test" && seams.failLook === rel) throw new Error("simulated read failure");
  const st = await fsp.lstat(fromRel(root, rel)).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  });
  if (!st) return { at: "nothing" };
  if (!st.isFile()) return { at: "other" };
  const sha256 = await sha256File(fromRel(root, rel));
  return sha256 === null ? { at: "nothing" } : { at: "file", sha256 };
}

/**
 * What a "trashed" line `i` moved, by the lines before it: "the original" when no earlier line of the change is at,
 * under or above its path; "the change's" when an earlier line made it (created or replaced it whole, made the folder
 * or one above it, or created it by appending): then nothing of the researcher's is in that copy (a replaced file's
 * original is in its backup); "changed by the change" when the change only added to it (an append, or lines under a
 * folder): the original with the change's additions, whose undo after it is put back changes its size and time.
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
 * Whether what is at a "trashed" line's path has the identity the line recorded of its original (R519 (3)): the same
 * file number, size and time of last modification, which a rename inside the volume keeps; the file number alone when
 * the change had added to it (`numberOnly`: undoing that addition in place keeps the number, not the size or time).
 * Throws when it cannot look.
 */
async function isOriginal(root: string, e: Extract<MarkerEntry, { kind: "trashed" }>, numberOnly: boolean): Promise<boolean> {
  if (process.env.NODE_ENV === "test" && seams.failLook === e.from) throw new Error("simulated read failure");
  const st = await fsp.lstat(fromRel(root, e.from), { bigint: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  });
  if (st === null || st.ino.toString() !== e.ino) return false;
  return numberOnly || (Number(st.size) === e.size && st.mtimeNs.toString() === e.mtimeNs);
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
  const because = (kind: UndoCauseKind, path: string) => {
    ok = false;
    if (!causes.some((c) => c.kind === kind && c.path === path)) causes.push({ kind, path });
  };
  const done = new Set<number>();
  /** Paths where something not of the change, or not known to be, was left as it is (R519). */
  const blocked: string[] = [];
  for (const [i, e] of entries.entries()) {
    if (e.kind !== "trashed") continue;
    let putBack: boolean;
    try {
      putBack = !(await exists(fromRel(root, e.to)));
    } catch {
      // Not known whether it was put back: nothing at that path is undone again, and the roll-back is not complete.
      putBack = true;
      because("could-not-look", e.from);
    }
    if (!putBack) continue;
    const earlier = trashedContent(entries, i);
    if (e.ino !== undefined && earlier !== "the change's") {
      // R519 (3): the line knows the original's identity. A file with it at the path IS the original, put back (or never
      // moved: a crash between the line and its rename), whatever its bytes equal (R509 M1). The change's own file,
      // anything else, or nothing there: the original was not put back and cannot be, the copy being gone (R509 M2).
      // Nothing at the path is deleted or moved, and no line at or under it is undone.
      try {
        if (!(await isOriginal(root, e, earlier === "changed by the change"))) {
          because("kept-copy-gone", e.from);
          blocked.push(e.from);
        }
      } catch {
        because("could-not-look", e.from);
        blocked.push(e.from);
      }
    } else {
      // An older build's line (no identity), or a copy of what the change itself had made (it holds nothing of the
      // researcher's, and once the earlier lines are undone nothing at the path has its identity), judged as before.
      // R503 b 2: a copy gone while the change's own bytes (a later line's hash) are still at the path was not put
      // back: it was deleted outside the app. The roll-back is then not complete (the marker is kept); nothing is deleted.
      try {
        if (await ownBytesAt(root, e.from, entries.slice(i + 1))) because("kept-copy-gone", e.from);
      } catch {
        because("could-not-look", e.from);
      }
    }
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
        if (knowsBytes(entries, i) && !(now.at === "file" && writeHashes(entries, e.path).includes(now.sha256))) {
          block("hand-changed-file", e.path);
          continue;
        }
        await fsp.rm(fromRel(root, e.path), { force: true });
      } else if (e.kind === "dir") await fsp.rm(fromRel(root, e.path), { recursive: true, force: true });
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
          if (now.at === "other" || (now.at === "file" && !writeHashes(entries, e.path).includes(now.sha256) && !kept.includes(now.sha256))) {
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
    }
  }
  if (cut()) return { ok: false, causes };
  return { ok, causes };
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
        // The identity is whole or absent (an older build's line): never judged on part of it.
        if (en.ino !== undefined || en.size !== undefined || en.mtimeNs !== undefined) {
          if (!isDigits(en.ino) || !count(en.size) || !isDigits(en.mtimeNs)) return "bad trashed entry";
        }
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
    else out.push({ ...where, paths: markerPaths(m), outcome: "rollback-incomplete", ...(r.causes.length ? { causes: r.causes } : {}) });
  }
  return out;
}

/** True when `name` (in `.tmp/`) is a backup copy whose marker no longer exists. */
export async function isOrphanBackup(root: string, name: string): Promise<boolean> {
  const m = BACKUP.exec(name);
  return !!m && !(await exists(join(root, ".tmp", `txn-${m[1]}.json`)));
}
