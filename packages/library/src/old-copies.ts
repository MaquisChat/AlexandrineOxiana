/**
 * Old copies left behind by library moves, waiting for the user to confirm
 * their deletion. Kept in the app config folder (outside every library, like
 * the registry), so the offer survives an app restart:
 * `<appConfigDir>/pending-old-copies.json` plus, per record, the list of
 * verified file hashes in `<appConfigDir>/old-copies/<id>.json`.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { Deps } from "./deps.js";
import { writeFileAtomic } from "./fs/atomic.js";

export const OLD_COPY_TTL_MS = 24 * 3600_000;

export interface PendingOldCopy {
  id: string;
  /** Absolute path of the old copy (on this device). */
  oldRoot: string;
  newRoot: string;
  libraryId: string;
  /** Absolute path of the verified-hash list in the app config folder. */
  verifiedHashesFile: string;
  createdAt: string;
  /** True when the old folder kept excluded projects and is now a separate library. */
  split: boolean;
  movedFolders: string[];
  movedProjectIds: string[];
  /** `Projects/<n>` folders of the old copy already moved away earlier (not part of this move; never deleted by it). */
  movedAway?: string[];
  moveId: string;
  /** False while the move's switch has not finished. */
  complete: boolean;
}

export interface VerifiedHashes {
  /** Library-relative path → SHA-256 of the verified file. */
  files: Record<string, string>;
  dirs: string[];
}

type CfgDeps = Pick<Deps, "appConfigDir" | "clock">;
const listFile = (d: CfgDeps) => join(d.appConfigDir, "pending-old-copies.json");

async function load(deps: CfgDeps): Promise<PendingOldCopy[]> {
  try {
    const v = JSON.parse(await fsp.readFile(listFile(deps), "utf8")) as { records?: unknown };
    return Array.isArray(v.records) ? (v.records as PendingOldCopy[]).filter((r) => typeof r?.id === "string" && typeof r.oldRoot === "string") : [];
  } catch {
    return [];
  }
}

async function save(deps: CfgDeps, records: PendingOldCopy[]): Promise<void> {
  await fsp.mkdir(deps.appConfigDir, { recursive: true });
  await writeFileAtomic(listFile(deps), JSON.stringify({ formatVersion: 1, records }, null, 2), { mode: 0o600 });
}

/** Records a pending old copy (complete: false) with its verified hashes. */
export async function addPendingOldCopy(
  deps: CfgDeps,
  rec: Omit<PendingOldCopy, "id" | "verifiedHashesFile" | "createdAt" | "complete">,
  hashes: VerifiedHashes,
): Promise<PendingOldCopy> {
  const id = randomBytes(12).toString("hex");
  const dir = join(deps.appConfigDir, "old-copies");
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fsp.chmod(dir, 0o700);
  const verifiedHashesFile = join(dir, `${id}.json`);
  await writeFileAtomic(verifiedHashesFile, JSON.stringify(hashes), { mode: 0o600 });
  const full: PendingOldCopy = { ...rec, id, verifiedHashesFile, createdAt: deps.clock().toISOString(), complete: false };
  await save(deps, [...(await load(deps)), full]);
  return full;
}

/**
 * Moves whose switch has started but not finished (e.g. the app crashed): the
 * old copy may already be read-only. Finish each with `completeMove(newRoot, …)`.
 */
export async function listUnfinishedMoves(
  deps: CfgDeps,
): Promise<Array<{ libraryId: string; oldRoot: string; newRoot: string; moveId: string; startedAt: string }>> {
  return (await load(deps))
    .filter((r) => !r.complete)
    .map((r) => ({ libraryId: r.libraryId, oldRoot: r.oldRoot, newRoot: r.newRoot, moveId: r.moveId, startedAt: r.createdAt }));
}

/** Where the library at `oldRoot` was moved, from this device's records (newest first). */
export async function movedToFor(deps: CfgDeps, oldRoot: string, libraryId: string): Promise<{ newRoot: string; unfinished: boolean } | undefined> {
  const r = (await load(deps))
    .filter((x) => x.oldRoot === oldRoot && x.libraryId === libraryId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return r ? { newRoot: r.newRoot, unfinished: !r.complete } : undefined;
}

export async function getPendingOldCopy(deps: CfgDeps, id: string): Promise<PendingOldCopy | undefined> {
  return (await load(deps)).find((r) => r.id === id);
}

export async function markPendingComplete(deps: CfgDeps, id: string): Promise<void> {
  const all = await load(deps);
  const r = all.find((x) => x.id === id);
  if (!r || r.complete) return;
  r.complete = true;
  await save(deps, all);
}

export async function removePendingOldCopy(deps: CfgDeps, id: string): Promise<void> {
  const all = await load(deps);
  const r = all.find((x) => x.id === id);
  if (!r) return;
  await save(deps, all.filter((x) => x.id !== id));
  await fsp.rm(r.verifiedHashesFile, { force: true });
}

export async function readVerifiedHashes(rec: PendingOldCopy): Promise<VerifiedHashes> {
  return JSON.parse(await fsp.readFile(rec.verifiedHashesFile, "utf8")) as VerifiedHashes;
}

export const isExpired = (rec: PendingOldCopy, deps: Pick<Deps, "clock">) => deps.clock().getTime() > Date.parse(rec.createdAt) + OLD_COPY_TTL_MS;

/** Old copies of finished moves that can still be deleted with `deleteOldCopy(oldRoot, { confirm: true })`. */
export async function listPendingOldCopies(deps: CfgDeps): Promise<Array<PendingOldCopy & { expiresAt: string; expired: boolean }>> {
  return (await load(deps))
    .filter((r) => r.complete)
    .map((r) => ({ ...r, expiresAt: new Date(Date.parse(r.createdAt) + OLD_COPY_TTL_MS).toISOString(), expired: isExpired(r, deps) }));
}
