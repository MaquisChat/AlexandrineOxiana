/**
 * Write-ahead transaction marker: `<Library>/.tmp/txn-<id>.json`.
 *
 * Before a mutation touches any final-name file, folder, change log or audit
 * segment, the step is added to the marker (rewritten atomically). Replaced
 * files are first copied to `.tmp/txn-<id>.orig-<n>`. The allow audit events
 * carry `details.txn = <id>`; once they are all appended (the commit point) the
 * marker and its copies are deleted.
 *
 * A crash leaves the marker behind. On the next writable open,
 * `recoverTransactions` checks the project's audit log: if every allow event of
 * the transaction is there it was committed and only the marker is removed;
 * otherwise every step is undone in reverse (including partially appended
 * change log and audit lines) and the caller records a warning.
 *
 * Paths in the marker are relative to the library root (`/` separators), so a
 * library moved between the crash and the next open still recovers.
 */
import * as fsp from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { newId } from "@ao/core";
import { copyFileAtomic, renameWithRetry, writeFileAtomic } from "../fs/atomic.js";
import { AuditStore } from "./audit-store.js";
import { exists, undoAppend, type AppendUndo } from "./io.js";

export type MarkerEntry =
  | { kind: "created"; path: string }
  | { kind: "replaced"; path: string; backup: string; mode: number }
  | { kind: "dir"; path: string }
  | { kind: "trashed"; from: string; to: string }
  | { kind: "append"; path: string; prevSize: number; created: boolean };

export interface TxnMarker {
  formatVersion: 1;
  txn: string;
  projectId: string;
  /** Library-relative project folder (where its audit log lives). */
  projectFolder: string;
  /** Number of allow audit events that make up the commit. */
  auditEvents: number;
  entries: MarkerEntry[];
}

const MARKER = /^txn-([0-9a-f-]+)\.json$/;

export const toRel = (root: string, abs: string): string => relative(root, abs).split(sep).join("/");
export const fromRel = (root: string, rel: string): string => join(root, ...rel.split("/"));

export class TxnLog {
  readonly marker: TxnMarker;
  private backups = 0;

  constructor(
    private readonly root: string,
    projectId: string,
    projectFolder: string,
    auditEvents: number,
  ) {
    this.marker = { formatVersion: 1, txn: newId(), projectId, projectFolder, auditEvents, entries: [] };
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
    await fsp.mkdir(this.dir, { recursive: true });
    await writeFileAtomic(this.path, JSON.stringify(this.marker));
  }

  async created(abs: string) {
    await this.add({ kind: "created", path: toRel(this.root, abs) });
  }

  /** Copies the current file aside, then records it, so a crash can restore it. */
  async replaced(abs: string, mode: number) {
    await fsp.mkdir(this.dir, { recursive: true });
    const backup = join(this.dir, `txn-${this.id}.orig-${this.backups++}`);
    await copyFileAtomic(abs, backup);
    await this.add({ kind: "replaced", path: toRel(this.root, abs), backup: toRel(this.root, backup), mode });
  }

  async createdDir(abs: string) {
    await this.add({ kind: "dir", path: toRel(this.root, abs) });
  }

  async trashed(from: string, to: string) {
    await this.add({ kind: "trashed", from: toRel(this.root, from), to: toRel(this.root, to) });
  }

  async append(u: AppendUndo) {
    await this.add({ kind: "append", path: toRel(this.root, u.path), prevSize: u.prevSize, created: u.created });
  }

  /** Undoes every recorded step in reverse. Best effort: keeps going past individual failures. */
  async undo(): Promise<void> {
    await undoEntries(this.root, this.marker.entries);
  }

  /** Removes the marker and its backup copies (after commit, or after rollback). */
  async finish(): Promise<void> {
    await removeMarker(this.root, this.marker);
  }
}

async function undoEntries(root: string, entries: MarkerEntry[]): Promise<void> {
  for (const e of [...entries].reverse()) {
    try {
      if (e.kind === "created") await fsp.rm(fromRel(root, e.path), { force: true });
      else if (e.kind === "dir") await fsp.rm(fromRel(root, e.path), { recursive: true, force: true });
      else if (e.kind === "replaced") {
        const backup = fromRel(root, e.backup);
        if (await exists(backup)) await writeFileAtomic(fromRel(root, e.path), await fsp.readFile(backup), { mode: e.mode });
      } else if (e.kind === "trashed") {
        const to = fromRel(root, e.to);
        if ((await exists(to)) && !(await exists(fromRel(root, e.from)))) await renameWithRetry(to, fromRel(root, e.from));
      } else {
        const path = fromRel(root, e.path);
        if (await exists(path)) await undoAppend({ path, prevSize: e.prevSize, created: e.created });
      }
    } catch {
      // continue: restore as much as possible
    }
  }
}

async function removeMarker(root: string, m: TxnMarker): Promise<void> {
  for (const e of m.entries) {
    if (e.kind === "replaced") await fsp.rm(fromRel(root, e.backup), { force: true }).catch(() => {});
  }
  await fsp.rm(join(root, ".tmp", `txn-${m.txn}.json`), { force: true });
}

export interface RecoveryResult {
  projectId: string;
  txn: string;
  rolledBack: boolean;
}

/** Finishes or rolls back every transaction marker left by a crash. Writable libraries only. */
export async function recoverTransactions(root: string): Promise<RecoveryResult[]> {
  const dir = join(root, ".tmp");
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: RecoveryResult[] = [];
  for (const name of names.sort()) {
    if (!MARKER.test(name)) continue;
    let m: TxnMarker;
    try {
      m = JSON.parse(await fsp.readFile(join(dir, name), "utf8")) as TxnMarker;
      if (m.formatVersion !== 1 || !Array.isArray(m.entries)) throw new Error("bad marker");
    } catch {
      // A torn marker cannot happen (atomic writes); an unreadable one is kept for inspection.
      continue;
    }
    const events = await AuditStore.read(fromRel(root, `${m.projectFolder}/audit`));
    const committed =
      events.filter(
        (e) => e !== null && e.decision?.result !== "deny" && (e.details as { txn?: unknown } | undefined)?.txn === m.txn,
      ).length >= m.auditEvents;
    if (!committed) await undoEntries(root, m.entries);
    // Committed: the trash of a delete may still be there.
    else for (const e of m.entries) if (e.kind === "trashed") await fsp.rm(fromRel(root, e.to), { recursive: true, force: true }).catch(() => {});
    await removeMarker(root, m);
    out.push({ projectId: m.projectId, txn: m.txn, rolledBack: !committed });
  }
  return out;
}
