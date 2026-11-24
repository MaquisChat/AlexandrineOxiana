/**
 * Undo a whole import batch (spec 5.4 step 7, 3.8; R44, R45):
 *
 *   1. merges are reverted, newest first, from what each merge recorded (R61): the originals it
 *      added are removed and the fields it filled are cleared, unless the user changed them since
 *      (kept, and reported). Another batch's files are never touched; the pre-merge snapshot in
 *      the batch folder is kept as a record only;
 *   2. every source the batch created is deleted. They are found by their provenance
 *      `importBatchId` as well as by the batch record's `createdSourceIds` and the journal (R45),
 *      so a source created just before a crash is found too;
 *   3. the collections and tags the batch created are deleted (deepest collections first), unless a
 *      surviving source uses them or (collections) the user added a folder inside: those are kept
 *      and reported;
 *   4. a profile-capture batch's post ids whose sources this undo removed are taken out of the
 *      profile's `profile.json` (`knownPostIds`, `knownPosts`) and `archive.txt` (R44); a post whose
 *      source the user had already deleted stays known, so it is not captured again;
 *   5. the batch's pending review entries are resolved, the record is marked `undone` and the
 *      undo is audited (`import.undo`).
 *
 * Every change is governed and audited. Only files inside the library are ever removed: source
 * folders (trashed through the repository) and the copies a merge added. Linked originals and the
 * user's files outside the library are never touched.
 */
import { appendLibraryEvent, clearZoteroWebVersion, hasSource, importChange, mendFindQueue, projectCollectionsAndTags, projectReviewEntries, repoLibrary, type Repo } from "../../repo/repo.js";
import { NotFoundError } from "../../repo/errors.js";
import { encName } from "@ao/core";
import { decryptBytes, readMaybe } from "../../repo/io.js";
import { projectDataKey } from "../../repo/repo.js";
import { join } from "node:path";
import { zoteroKeysOf } from "../../repo/tombstones.js";
import type { ImportOps } from "../../repo/import-ops.js";
import { reviewCauseOf } from "../../repo/review.js";
import { BOOKKEEPING, PRIVATE_MODE, activeBatches, findBatch, readJournal, undoneBatchIds, writeBatchRecord } from "./batch.js";
import { getAt, revertMerge } from "./merge.js";
import { asEvidence } from "./update.js";
import { isDeepStrictEqual } from "node:util";
import { BatchRefusedError } from "./run.js";

const CREATED = new Set(["created", "needs-review", "incomplete"]);

async function readProjectRel(repo: Repo, projectId: string, rel: string): Promise<string | undefined> {
  const k = projectDataKey(repo, projectId);
  const raw = await readMaybe(join(repoLibrary(repo).root, ...(k ? encName(rel) : rel).split("/")));
  if (!raw) return undefined;
  if (!k) return raw.toString("utf8");
  return (await decryptBytes((id) => (id === k.keyId ? k.key : undefined), raw)).toString("utf8");
}

export interface UndoKept {
  /** `availability` (Z5): a source's availability changed after the batch marked it (or took its mark away); kept. */
  kind: "tag" | "collection" | "field" | "annotation" | "availability";
  /** The tag or collection id, or the field's JSON pointer. */
  id: string;
  /** For fields: the source. */
  sourceId?: string;
  reason: string;
}

export interface UndoResult {
  removedSources: number;
  revertedMerges: number;
  /**
   * Of `revertedMerges`, by what the batch had done (Z5, R224): merges restored, updates reverted (a back that also
   * updated the item among them), "gone from Zotero" marks taken off, and marks put back (a bare back undone).
   * Other changes taken back (a sort index filled in) are in `revertedMerges` only.
   */
  reverted: {
    merged: number;
    updated: number;
    unmarked: number;
    remarked: number;
    /**
     * Task Z6 (present only when not 0): sources whose conflict (a field changed in Zotero and here) this undo took off,
     * its review entry resolved "undone"; the researcher's value was never changed. An updated source that also had one
     * is counted in `updated` too.
     */
    conflicts?: number;
    /**
     * FR-467 (present only when not 0): sources whose "gone from Zotero" mark this undo replaced with the mark they had
     * before it (a deletion over a bin mark undone: the bin mark is back). Not counted in `unmarked`.
     */
    restoredMarks?: number;
  };
  /** What undo left in place because it is in use or was changed since (R61). */
  kept: UndoKept[];
  /** Z5: the Zotero library version this batch recorded was forgotten, so the next Web import is a full one. */
  libraryVersionReset?: true;
}

const UNSETTLED = new Set(["conflict", "unverified"]);

/**
 * Task Z6 (R177 c, R194): inside the undo's change of a source, the pending capture-conflict entries that list a field
 * whose conflict the undo took off, and none of whose listed fields is still in conflict or unverified in `verification`
 * (the report as the undo leaves it), are resolved "undone". No entry is left for a conflict that no longer exists.
 */
async function resolveUndoneConflicts(ops: ImportOps, sourceId: string, paths: string[], verification: Record<string, { status: string }>): Promise<void> {
  for (const en of await ops.reviewEntries()) {
    if (en.status !== "pending" || en.sourceId !== sourceId || reviewCauseOf(en)?.kind !== "capture-conflict") continue;
    const listed = Object.keys(en.fields ?? {});
    if (!listed.some((f) => paths.includes(f))) continue;
    if (listed.some((f) => UNSETTLED.has(verification[f]?.status ?? ""))) {
      // M2: an entry that still waits for another field no longer lists the one this undo took off (its reasons, which
      // name no field, are left as they are).
      const off = listed.filter((f) => paths.includes(f) && !UNSETTLED.has(verification[f]?.status ?? ""));
      if (off.length) await ops.updateReview({ ...en, fields: Object.fromEntries(Object.entries(en.fields).filter(([f]) => !off.includes(f))) });
      continue;
    }
    await ops.updateReview({ ...en, status: "resolved", resolvedAt: ops.tx.at, decision: "undone" });
  }
}


export async function undoBatch(repo: Repo, projectId: string, batchId: string): Promise<UndoResult> {
  // The batch's slot is taken before anything is awaited (R63): no resume, start or second undo meanwhile.
  if (activeBatches.has(batchId)) throw new BatchRefusedError("This import is running or being undone; try again when it has stopped.", false, "running");
  activeBatches.add(batchId);
  try {
    return await undoHeld(repo, projectId, batchId);
  } finally {
    activeBatches.delete(batchId);
  }
}

async function undoHeld(repo: Repo, projectId: string, batchId: string): Promise<UndoResult> {
  const rec = await findBatch(repo, projectId, batchId);
  if (!rec) throw new NotFoundError("Import batch", batchId);
  if (rec.state === "undone") throw new BatchRefusedError("This import has already been undone.", false, "finished");
  const projectRel = repo.getProject(projectId).folder;
  const journal = await readJournal(repo, projectId, rec.dir);
  const kept: UndoKept[] = [];

  // 1. Merges, newest first, exactly what each one added. Z5 (R224 b): a "gone from Zotero" mark whose own batch is
  //    undone is never put back; which batches are undone is read from their records (never their journals).
  const undone = journal.some((e) => e.merge?.availability?.marks?.length) ? await undoneBatchIds(repo, projectId) : new Set<string>();
  let revertedMerges = 0;
  const reverted: UndoResult["reverted"] = { merged: 0, updated: 0, unmarked: 0, remarked: 0 };
  for (const e of [...journal].reverse()) {
    if (!e.mergedInto || !e.merge || !hasSource(repo, projectId, e.mergedInto)) continue;
    const cur = await repo.getSource(projectId, e.mergedInto);
    const p = cur.source.provenance;
    let conflictsOff = false;
    let markLeft = false;
    const changed = await importChange(
      repo,
      projectId,
      { action: "store", store: { identifiable: p.identifiable, hasLocation: false, ...(p.legal.basis ? { legalBasis: p.legal.basis } : {}) } },
      async (ops) => {
        const now = await ops.readSource(e.mergedInto!);
        const r = revertMerge(now, e.merge!, ops.tx.at, ops.tx.actor, (id) => undone.has(id));
        for (const a of r.removed) await ops.trashAssetFile(a);
        for (const path of r.kept) kept.push({ kind: "field", id: path, sourceId: e.mergedInto!, reason: "changed after the import; kept" });
        // Z6 (R177 c): a conflict this batch raised and the undo took off: its pending capture entry is resolved
        // "undone" in this same change, once none of the fields it lists is left in conflict or unverified (an entry
        // that also lists another open field stays pending for that one). Resolved BEFORE the source is written, so
        // the write's own re-examination finds it decided and does not call it "rechecked".
        if (r.conflictsReverted.length) await resolveUndoneConflicts(ops, e.mergedInto!, r.conflictsReverted, r.next.verification);
        // One the researcher decided after the import is theirs: kept, with its evidence, and said.
        // I1 (R236 b): what they decided is said as it is — their own value kept, or Zotero's taken — by comparing the
        // field's value now with the Zotero value this batch asked about.
        for (const path of r.keptConflicts) {
          const decided = r.next.verification[path]?.status === "user-confirmed";
          const asked = e.merge!.conflicts?.find((c) => c.path === path)?.after.values?.[0]?.value;
          const tookZotero = asked !== undefined && isDeepStrictEqual(asEvidence(path, getAt(r.next.source, path)), asked);
          const reason = !decided
            ? "changed after the import; kept"
            : tookZotero
              ? "you chose Zotero's value after this import; your decision was kept"
              : "you kept your own value after this import; your decision was kept";
          kept.push({ kind: "field", id: path, sourceId: e.mergedInto!, reason });
        }
        conflictsOff = r.conflictsReverted.length > 0;
        for (const id of r.keptAnnotations) kept.push({ kind: "annotation", id, sourceId: e.mergedInto!, reason: "edited after the import; kept" });
        // Z5: an availability changed since this batch wrote it (a later batch, or the researcher) is left as it is.
        if (r.keptAvailability) kept.push({ kind: "availability", id: "/availability", sourceId: e.mergedInto!, reason: "its availability was changed after this import, so it was left as it is" });
        markLeft = r.next.source.availability.zotero !== undefined;
        if (r.changed) await ops.writeSource(now, r.next);
        return r.changed;
      },
      { op: "import.undo.merge", entity: { type: "source", id: e.mergedInto } },
    );
    if (changed) {
      revertedMerges++;
      if (e.outcome === "merged") reverted.merged++;
      else if (e.outcome === "updated" || (e.outcome === "zotero-back" && e.contentUpdated)) reverted.updated++;
      else if (e.outcome === "zotero-gone" && markLeft) reverted.restoredMarks = (reverted.restoredMarks ?? 0) + 1;
      else if (e.outcome === "zotero-gone") reverted.unmarked++;
      else if (e.outcome === "zotero-back") reverted.remarked++;
      if (conflictsOff) reverted.conflicts = (reverted.conflicts ?? 0) + 1;
    }
  }

  // 2. Sources the batch created: by provenance, the record and the journal (R45).
  const ids = new Set<string>(rec.createdSourceIds);
  for (const e of journal) if (e.sourceId && CREATED.has(e.outcome) && !e.mergedInto) ids.add(e.sourceId);
  for (const id of repo.listSourceIds(projectId)) {
    if (ids.has(id)) continue;
    try {
      if ((await repo.getSource(projectId, id)).source.provenance.importBatchId === batchId) ids.add(id);
    } catch {
      // unreadable: not provably this batch's
    }
  }
  const removed = new Set<string>();
  for (const id of ids) {
    if (!hasSource(repo, projectId, id)) continue;
    // Not the user's deletion: no deletion record, so a later run imports the item again (R73). Its
    // pending review entries are read and resolved ("undone") inside this same change (coordinator's
    // ruling 3; fix round 2, N3: an entry queued while the undo runs is not missed).
    // The removal may write a queue entry's line: a torn last line of the queue is cut first (R503 a, R505 b).
    await mendFindQueue(repo, projectId);
    await importChange(repo, projectId, { action: "delete" }, (ops) => ops.deleteSource(id, { undo: true }), { op: "source.delete", entity: { type: "source", id } });
    removed.add(id);
  }
  const removedSources = removed.size;

  // 3. Collections (deepest first: they were created parents first) and tags, unless still in use.
  if (rec.createdCollectionIds.length || rec.createdTagIds.length) {
    const usedCollections = new Set<string>();
    const usedTags = new Set<string>();
    for (const id of repo.listSourceIds(projectId)) {
      try {
        const s = (await repo.getSource(projectId, id)).source;
        s.collectionIds.forEach((c) => usedCollections.add(c));
        s.tagIds.forEach((t) => usedTags.add(t));
      } catch {
        // unreadable: cannot tell, so nothing it might use is removed below
        rec.createdCollectionIds.forEach((c) => usedCollections.add(c));
        rec.createdTagIds.forEach((t) => usedTags.add(t));
      }
    }
    for (const id of [...rec.createdCollectionIds].reverse()) {
      const { collections } = await projectCollectionsAndTags(repo, projectId);
      if (!collections.some((c) => c.id === id)) continue;
      if (usedCollections.has(id)) {
        kept.push({ kind: "collection", id, reason: "a source outside the import is in it; kept" });
        continue;
      }
      const children = collections.filter((c) => c.parentId === id);
      if (children.length) {
        const ours = children.every((c) => rec.createdCollectionIds.includes(c.id));
        kept.push({ kind: "collection", id, reason: ours ? "contains a collection that is still in use; kept" : "it holds a collection added after the import; kept" });
        continue;
      }
      await repo.deleteCollection(projectId, id);
    }
    const tagsToDelete: string[] = [];
    for (const t of rec.createdTagIds) {
      if (usedTags.has(t)) kept.push({ kind: "tag", id: t, reason: "a source outside the import has it; kept" });
      else tagsToDelete.push(t);
    }
    if (tagsToDelete.length) {
      await importChange(repo, projectId, BOOKKEEPING, async (ops) => {
        await ops.deleteTags(tagsToDelete, []);
      }, { op: "import.undo.tags" });
    }
  }

  // 3b. Deletion records (R74 I3): those the batch's review decisions wrote come off; those its
  //     includeDeleted run cleared go back.
  //     Each review deletion is taken back once (another deletion that recorded the same key keeps
  //     it, R77), and never for a key a surviving source still carries (zoteroKey or merged keys).
  const written = journal.flatMap((e) => e.tombstoned ?? []);
  const cleared = rec.clearedDeletions ?? [];
  if (written.length || cleared.length) {
    const carried = new Set<string>();
    if (written.length) {
      for (const id of repo.listSourceIds(projectId)) {
        try {
          for (const k of zoteroKeysOf(await repo.getSource(projectId, id))) carried.add(k);
        } catch {
          // unreadable: cannot tell what it carries
        }
      }
    }
    await importChange(
      repo,
      projectId,
      BOOKKEEPING,
      async (ops) => {
        for (const keys of journal.filter((e) => e.tombstoned?.length).map((e) => e.tombstoned!)) await ops.releaseDeletions(keys, carried);
        if (cleared.length) await ops.addDeletions(cleared);
      },
      { op: "import.undo.deleted-records" },
    );
  }

  // 4. Profile capture: forget the posts whose sources this undo removed (R44).
  if (rec.source.kind === "profile-capture") {
    const keys = new Set(journal.filter((e) => e.sourceId && removed.has(e.sourceId)).map((e) => e.key));
    const dir = `${projectRel}/${rec.source.location.replace(/^\/+|\/+$/gu, "")}`;
    if (keys.size && rec.source.location.startsWith("profiles/") && !rec.source.location.includes("..")) {
      const profileText = await readProjectRel(repo, projectId, `${dir}/profile.json`);
      const archiveText = await readProjectRel(repo, projectId, `${dir}/archive.txt`);
      await repo.mutate(
        projectId,
        BOOKKEEPING,
        async (tx) => {
          const o = { encrypt: tx.encrypted, ...(tx.encrypted ? {} : { mode: PRIVATE_MODE }) };
          const name = (n: string) => `${dir}/${tx.encrypted ? encName(n) : n}`;
          if (profileText) {
            const p = JSON.parse(profileText) as { knownPostIds?: string[]; knownPosts?: Record<string, unknown> };
            p.knownPostIds = (p.knownPostIds ?? []).filter((id) => !keys.has(id));
            if (p.knownPosts) p.knownPosts = Object.fromEntries(Object.entries(p.knownPosts).filter(([id]) => !keys.has(id)));
            await tx.writeFile(name("profile.json"), JSON.stringify(p, null, 2), o);
          }
          if (archiveText !== undefined) {
            const lines = archiveText.split("\n").filter((l) => l.trim() && !keys.has(l.trim().split(/\s+/u).pop()!));
            await tx.writeFile(name("archive.txt"), lines.map((l) => `${l}\n`).join(""), o);
          }
        },
        { op: "import.undo.profile" },
      );
    }
  }

  // 4b. Zotero Web (Z5, R206 4): a batch that recorded the library's version had it forgotten, so the next run is a
  //     full one and brings back what this undo took away. Before the record says undone: an undo that stops in
  //     between is done again, and forgetting twice changes nothing.
  let libraryVersionReset = false;
  if (rec.source.kind === "zotero-web" && rec.recordedLibraryVersion !== undefined && /^(user|group):\d{1,12}$/u.test(rec.source.location)) {
    await clearZoteroWebVersion(repo, projectId, rec.source.location);
    libraryVersionReset = true;
  }

  // 5. Review entries, the record, the audit log.
  const pending = (await projectReviewEntries(repo, projectId)).filter((e) => e.status === "pending" && (e.batchId === batchId || (e.sourceId && removed.has(e.sourceId))));
  rec.state = "undone";
  await importChange(
    repo,
    projectId,
    BOOKKEEPING,
    async (ops) => {
      for (const e of pending) await ops.updateReview({ ...e, status: "resolved", resolvedAt: ops.tx.at, decision: "undone" });
      await writeBatchRecord(ops.tx, projectRel, rec);
    },
    { op: "import.undo.record" },
  );
  await appendLibraryEvent(repo, projectId, "import.undo", {
    batchId,
    number: rec.number,
    kind: rec.source.kind,
    removedSources,
    revertedMerges,
    kept: kept.length,
    ...(libraryVersionReset ? { libraryVersionReset } : {}),
  });
  return { removedSources, revertedMerges, reverted, kept, ...(libraryVersionReset ? { libraryVersionReset: true as const } : {}) };
}
