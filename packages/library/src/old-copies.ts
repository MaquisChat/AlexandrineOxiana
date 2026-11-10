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
  await fsp.mkdir(dir, { recursive: true });
  const verifiedHashesFile = join(dir, `${id}.json`);
  await writeFileAtomic(verifiedHashesFile, JSON.stringify(hashes), { mode: 0o600 });
  const full: PendingOldCopy = { ...rec, id, verifiedHashesFile, createdAt: deps.clock().toISOString(), complete: false };
  await save(deps, [...(await load(deps)), full]);
  return full;
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
