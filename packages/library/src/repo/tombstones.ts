/**
 * Deletion records for imported items (R73, R74): when a source that came from an incremental
 * import (provenance `externalKeys.zoteroKey`, and the keys of Zotero items merged into it,
 * `zoteroMergedKeys`) is deleted in this app, the deletion is remembered, so a later Zotero run does
 * not bring it back. Batch undo is not a deletion and records nothing.
 *
 * `<Project>/imports/deleted-items.json` (`.enc`, sealed with the project key, in encrypted
 * projects; owner-only otherwise): a per-project random secret and, per kind, HMAC-SHA256(secret,
 * "zotero:" + item key) — never the key itself. Written inside the governed change that deletes the
 * source.
 *
 * Fail closed (R74 I2): a record that exists but cannot be read (truncated, damaged, sealed with
 * another key) is not "no deletions". A deletion then sets it aside
 * (`deleted-items.unreadable-<time>`), raises the project warning 'deleted-records-unreadable'
 * (`deleted-records-warning.json`, no content) and starts a new record; a Zotero import refuses
 * while the record is unreadable or the warning stands, until it is run with resetDeletedRecords.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { SourceFile } from "@ao/core";
import { isLockedRefusal } from "./errors.js";
import { decryptBytes, readMaybe } from "./io.js";
import type { Tx } from "./mutate.js";
import type { ProjectState, RepoCore } from "./state.js";

const NAME = "deleted-items.json";
const WARNING = "deleted-records-warning.json";
const MODE = 0o600;
export const DELETED_RECORDS_WARNING = "deleted-records-unreadable";

export interface Tombstones {
  secret: string;
  /** HMACs of Zotero item keys. */
  zotero: string[];
  /**
   * How many deletions recorded each HMAC (absent: 1). Undo releases only its own (R77): a record a
   * later deletion also made — e.g. of the source a key was merged into — stays.
   */
  counts?: Record<string, number>;
}

export type TombstoneRead = { status: "missing" } | { status: "unreadable" } | { status: "ok"; t: Tombstones };

const dir = (st: ProjectState) => `${st.rel}/imports`;
const rel = (st: ProjectState, encrypted: boolean) => `${dir(st)}/${encrypted ? `${NAME}.enc` : NAME}`;

export const tombstoneHash = (secret: string, key: string) => createHmac("sha256", Buffer.from(secret, "hex")).update(`zotero:${key}`, "utf8").digest("hex");

/** The Zotero item keys a source stands for: its own (provenance) and those merged into it (R74 M5, kept outside provenance, R76). */
export function zoteroKeysOf(sf: SourceFile): string[] {
  const keys = [sf.source.provenance.externalKeys?.zoteroKey ?? "", ...(sf.mergedExternalKeys?.zotero ?? [])].map((x) => x.trim()).filter(Boolean);
  return [...new Set(keys)];
}

/** The project's deletion records: missing, unreadable, or read. */
export async function readTombstones(core: RepoCore, st: ProjectState): Promise<TombstoneRead> {
  const encrypted = core.encrypted(st);
  const raw = await readMaybe(core.abs(rel(st, encrypted)));
  if (!raw) return { status: "missing" };
  try {
    let text: string;
    if (encrypted) {
      const { key, keyId } = core.key(st);
      text = (await decryptBytes((k) => (k === keyId ? key : undefined), raw)).toString("utf8");
    } else text = raw.toString("utf8");
    const t = JSON.parse(text) as Partial<Tombstones>;
    if (typeof t.secret !== "string" || !/^[0-9a-f]{64}$/u.test(t.secret) || !Array.isArray(t.zotero) || !t.zotero.every((h) => typeof h === "string")) {
      return { status: "unreadable" };
    }
    const counts: Record<string, number> = Object.create(null) as Record<string, number>;
    if (t.counts !== undefined) {
      if (!t.counts || typeof t.counts !== "object" || Array.isArray(t.counts)) return { status: "unreadable" };
      for (const [h, n] of Object.entries(t.counts)) {
        if (!Number.isInteger(n) || n < 1) return { status: "unreadable" };
        counts[h] = n;
      }
    }
    return { status: "ok", t: { secret: t.secret, zotero: t.zotero, counts } };
  } catch (err) {
    if (isLockedRefusal(err)) throw err; // a key a lock wiped mid-read: locked, never "unreadable" (R404)
    return { status: "unreadable" };
  }
}

/** Whether the project warning 'deleted-records-unreadable' stands. */
export async function deletedRecordsWarning(core: RepoCore, st: ProjectState): Promise<boolean> {
  return (await readMaybe(core.abs(`${dir(st)}/${WARNING}`))) !== null;
}

async function write(tx: Tx, t: Tombstones): Promise<void> {
  await tx.mkdir(dir(tx.state));
  await tx.writeFile(rel(tx.state, tx.encrypted), JSON.stringify(t), { encrypt: tx.encrypted, ...(tx.encrypted ? {} : { mode: MODE }) });
}

/** Sets an unreadable record aside (kept, never read again) and returns a new, empty one. */
async function setAside(core: RepoCore, tx: Tx): Promise<Tombstones> {
  const from = rel(tx.state, tx.encrypted);
  const stamp = tx.at.replace(/[:.]/gu, "-");
  await tx.copyFile(core.abs(from), `${dir(tx.state)}/deleted-items.unreadable-${stamp}${tx.encrypted ? ".enc" : ""}`, { mode: MODE });
  await tx.trash(from);
  return { secret: randomBytes(32).toString("hex"), zotero: [] };
}

/** Records, adds or clears deletion records inside a running change; an unreadable record is set aside first (with the warning). */
async function load(core: RepoCore, tx: Tx, raiseWarning: boolean): Promise<Tombstones> {
  const r = await readTombstones(core, tx.state);
  if (r.status === "ok") return r.t;
  if (r.status === "missing") return { secret: randomBytes(32).toString("hex"), zotero: [] };
  const fresh = await setAside(core, tx);
  if (raiseWarning) {
    await tx.writeFile(`${dir(tx.state)}/${WARNING}`, JSON.stringify({ kind: DELETED_RECORDS_WARNING, at: tx.at }), { mode: MODE });
    tx.onCommit(() => {
      core.integrityWarnings.push({
        projectId: tx.projectId,
        kind: DELETED_RECORDS_WARNING,
        detail: "The record of sources deleted here could not be read; it was set aside and a new one started.",
      });
    });
  }
  return fresh;
}

/** Inside a deletion: records the source's Zotero item keys; returns the keys it recorded (counted). */
export async function recordDeletion(core: RepoCore, tx: Tx, sf: SourceFile): Promise<string[]> {
  return addDeletions(core, tx, zoteroKeysOf(sf));
}

/** Records these Zotero item keys as deleted here (one more deletion each); returns them. */
export async function addDeletions(core: RepoCore, tx: Tx, keys: string[]): Promise<string[]> {
  const unique = [...new Set(keys)];
  if (!unique.length) return [];
  const t = await load(core, tx, true);
  const counts = { ...(t.counts ?? {}) };
  for (const key of unique) {
    const h = tombstoneHash(t.secret, key);
    if (t.zotero.includes(h)) counts[h] = (counts[h] ?? 1) + 1;
    else {
      t.zotero.push(h);
      counts[h] = 1;
    }
  }
  await write(tx, { ...t, counts });
  return unique;
}

/**
 * Undo (R74 I3, R77): takes back one deletion each for these keys — the record goes when no other
 * deletion made it too — except for keys in `keep` (a surviving source still carries them).
 */
export async function releaseDeletions(core: RepoCore, tx: Tx, keys: string[], keep: ReadonlySet<string>): Promise<void> {
  const r = await readTombstones(core, tx.state);
  if (r.status !== "ok") return;
  const t = r.t;
  const counts = { ...(t.counts ?? {}) };
  let zotero = t.zotero;
  let changed = false;
  for (const key of new Set(keys)) {
    if (keep.has(key)) continue;
    const h = tombstoneHash(t.secret, key);
    if (!zotero.includes(h)) continue;
    const n = (counts[h] ?? 1) - 1;
    changed = true;
    if (n >= 1) counts[h] = n;
    else {
      delete counts[h];
      zotero = zotero.filter((x) => x !== h);
    }
  }
  if (changed) await write(tx, { ...t, zotero, counts });
}

/** Clears the records of these Zotero item keys; returns those that were recorded. */
export async function clearDeletions(core: RepoCore, tx: Tx, keys: string[]): Promise<string[]> {
  const r = await readTombstones(core, tx.state);
  if (r.status !== "ok" || !keys.length) return [];
  const t = r.t;
  const cleared = keys.filter((k) => t.zotero.includes(tombstoneHash(t.secret, k)));
  if (!cleared.length) return [];
  const drop = new Set(cleared.map((k) => tombstoneHash(t.secret, k)));
  const counts = Object.fromEntries(Object.entries(t.counts ?? {}).filter(([h]) => !drop.has(h)));
  await write(tx, { ...t, zotero: t.zotero.filter((h) => !drop.has(h)), counts });
  return cleared;
}

/**
 * The reset (resetDeletedRecords): an unreadable record is set aside and a new one started, and
 * the warning is cleared. Returns whether anything was reset.
 */
export async function resetDeletions(core: RepoCore, tx: Tx): Promise<boolean> {
  let changed = false;
  if ((await readTombstones(core, tx.state)).status === "unreadable") {
    await write(tx, await setAside(core, tx));
    changed = true;
  }
  const warning = `${dir(tx.state)}/${WARNING}`;
  if (await tx.exists(warning)) {
    await tx.trash(warning);
    changed = true;
  }
  if (changed) {
    tx.onCommit(() => {
      const ws = core.integrityWarnings;
      for (let i = ws.length - 1; i >= 0; i--) if (ws[i]!.projectId === tx.projectId && ws[i]!.kind === DELETED_RECORDS_WARNING) ws.splice(i, 1);
    });
  }
  return changed;
}
