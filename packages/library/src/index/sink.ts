/** The IndexSink over the index, and loading an unlocked encrypted project into memory (R30). */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { KeyRing } from "../crypto/keys.js";
import type { IndexSink, ProjectJson } from "../repo/state.js";
import { computeStamps, listProjectEntries, newestChangeId, projectKey, stampFor, type Stamps } from "./changes.js";
import {
  getMeta, indexProject, indexProjectEntities, indexSource, purgeProject, removeSource, setMeta, upsertReviewItem, type IndexDb, type IndexHandle,
} from "./db.js";
import { readExtractedText, readSource, withAnnotations } from "./load.js";

/**
 * (Re)loads an unlocked encrypted project's content into the in-memory TEMP schema: every source
 * (with extracted text from its derived assets) and its collections, tags and fieldwork records.
 * No-op when the project is not encrypted or its key is not in the ring.
 */
export async function indexUnlockedProject(
  db: IndexDb,
  root: string,
  keyRing: KeyRing,
  projectId: string,
  /** Test seam: runs after each source file is read (a lock may happen here). */
  hooks: { afterRead?: () => void | Promise<void> } = {},
): Promise<{ indexed: number; errors: Array<{ folder: string; message: string }> }> {
  const out = { indexed: 0, errors: [] as Array<{ folder: string; message: string }> };
  const entry = (await listProjectEntries(root)).find((e) => e.data?.project.id === projectId);
  if (!entry?.data) return out;
  const k = projectKey(entry.data, keyRing);
  if (!k) return out;
  // The project can be locked while we await file reads: check the key before every insert.
  const still = () => keyRing.has(k.keyId);
  purgeProject(db, projectId);
  indexProject(db, { ...entry.data.project, folder: entry.rel });
  if (still()) indexProjectEntities(db, entry.data, true);
  let names: string[] = [];
  try {
    names = await fsp.readdir(join(root, entry.rel, "Sources"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const folder = `${entry.rel}/Sources/${name}`;
    try {
      const sf = await readSource(join(root, folder), k);
      await hooks.afterRead?.();
      if (!sf) continue;
      const text = await readExtractedText(root, sf, k);
      if (!still()) break; // locked meanwhile: insert nothing more
      indexSource(db, sf, text, { protected: true });
      out.indexed++;
    } catch (err) {
      out.errors.push({ folder, message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!still()) purgeProject(db, projectId); // locked during the load: nothing may stay in memory
  return out;
}

/** Records the newest change id (`lastChangeId`) and per-project stamps for the whole library. */
export async function recordStamps(db: IndexDb, root: string, keyRing: KeyRing): Promise<void> {
  const stamps = await computeStamps(root, keyRing);
  writeStamps(db, stamps);
}

function writeStamps(db: IndexDb, stamps: Stamps): void {
  setMeta(db, "projectStamps", JSON.stringify(stamps));
  setMeta(db, "lastChangeId", newestChangeId(stamps) ?? "");
}

/** Updates the stamp of one project (reads only that project's change log). */
async function recordProjectStamp(db: IndexDb, root: string, keyRing: KeyRing, rel: string, data: ProjectJson): Promise<void> {
  const prev = getMeta(db, "projectStamps");
  const stamps: Stamps = prev ? (JSON.parse(prev) as Stamps) : {};
  if (!prev) {
    // nothing recorded yet: do the full computation once
    writeStamps(db, await computeStamps(root, keyRing));
    return;
  }
  stamps[data.project.id] = await stampFor(root, rel, data, keyRing);
  writeStamps(db, stamps);
}

async function readProjectJson(root: string, rel: string): Promise<ProjectJson | undefined> {
  const entries = await listProjectEntries(root);
  return entries.find((e) => e.rel === rel)?.data;
}

/**
 * An {@link IndexSink} over the index handle (always writes to the handle's current connection).
 * Pass `ctx` (library root and key ring) to also read extracted text, keep stamps fresh
 * incrementally (only the affected project), and index encrypted projects' content in memory only.
 * Without `ctx`, a source of an unknown project is treated as protected (kept in memory only).
 */
export function createIndexSink(
  handle: IndexHandle,
  ctx?: { root: string; keyRing: KeyRing },
  opts: {
    /**
     * While true, writes do not record change stamps (M6): set from the open until the staleness
     * check has run, so a write made before it cannot refresh a project's stamp and hide a change
     * made outside the app. The written rows are indexed as usual.
     */
    holdStamps?: () => boolean;
  } = {},
): IndexSink {
  /** Looks up where a project lives and whether it is encrypted (project.json read once per call). */
  async function info(projectId: string) {
    const row = handle.db.prepare("SELECT folder, encrypted FROM projects WHERE id = ?").get(projectId) as
      | { folder: string; encrypted: number }
      | undefined;
    if (!ctx) return { prot: row ? row.encrypted === 1 : true, rel: row?.folder, data: undefined, k: undefined };
    let rel = row?.folder;
    let data: ProjectJson | undefined;
    if (rel) data = await readProjectJson(ctx.root, rel);
    if (!data) {
      const e = (await listProjectEntries(ctx.root)).find((x) => x.data?.project.id === projectId);
      rel = e?.rel;
      data = e?.data;
    }
    if (!data) return { prot: true, rel, data, k: undefined };
    return { prot: data.project.encryption.enabled, rel, data, k: projectKey(data, ctx.keyRing) };
  }
  async function stamp(i: { rel?: string | undefined; data?: ProjectJson | undefined }) {
    if (!ctx || opts.holdStamps?.()) return;
    if (i.rel && i.data) await recordProjectStamp(handle.db, ctx.root, ctx.keyRing, i.rel, i.data);
    else await recordStamps(handle.db, ctx.root, ctx.keyRing);
  }
  return {
    async indexSource(sf, extractedText) {
      const i = await info(sf.source.projectIds[0] ?? "");
      const text = extractedText ?? (ctx ? await readExtractedText(ctx.root, sf, i.k) : undefined);
      // A source passed without its annotations loaded (source.json lists only their count): they
      // are read from the folder, as written by the change that just committed.
      const full = ctx ? await withAnnotations(join(ctx.root, sf.source.folder), sf, i.k) : sf;
      indexSource(handle.db, full, text, { protected: i.prot });
      await stamp(i);
    },
    async removeSource(id) {
      const row = handle.db.prepare("SELECT project_id FROM sources WHERE id = ?").get(id) as { project_id: string } | undefined;
      removeSource(handle.db, id);
      if (ctx) await stamp(await info(row?.project_id ?? ""));
    },
    async indexProject(p) {
      indexProject(handle.db, p);
      if (ctx) await stamp(await info(p.id));
    },
    purgeProject(projectId) {
      purgeProject(handle.db, projectId);
    },
    indexReviewItem(row) {
      upsertReviewItem(handle.db, row);
    },
    async projectUnlocked(projectId) {
      if (!ctx) return;
      await indexUnlockedProject(handle.db, ctx.root, ctx.keyRing, projectId);
      await stamp(await info(projectId));
    },
  };
}
