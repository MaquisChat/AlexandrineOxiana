/**
 * Undo a whole import batch (spec 5.4 step 7, 3.8; R44, R45):
 *
 *   1. merges are reverted, newest first: each merged source gets back its pre-merge source.json
 *      from the batch's snapshot, and the files the merge copied in are removed;
 *   2. every source the batch created is deleted. They are found by their provenance
 *      `importBatchId` as well as by the batch record's `createdSourceIds` and the journal (R45),
 *      so a source created just before a crash is found too;
 *   3. the collections and tags the batch created are deleted (deepest collections first);
 *   4. a profile-capture batch's post ids are removed from the profile's `profile.json`
 *      (`knownPostIds`, `knownPosts`) and `archive.txt` (R44), so a later run may capture them again
 *      only if they are still listed (deliberately deleted posts are not brought back by undo);
 *   5. the batch's pending review entries are resolved, the record is marked `undone` and the
 *      undo is audited (`import.undo`).
 *
 * Every change is governed and audited. Only files inside the library are ever removed: source
 * folders (trashed through the repository) and the copies a merge added. Linked originals and the
 * user's files outside the library are never touched.
 */
import { appendLibraryEvent, importChange, projectReviewEntries, repoLibrary, type Repo } from "../../repo/repo.js";
import { NotFoundError } from "../../repo/errors.js";
import { encName, SourceFile } from "@ao/core";
import { decryptBytes, readMaybe } from "../../repo/io.js";
import { projectDataKey } from "../../repo/repo.js";
import { join } from "node:path";
import { BOOKKEEPING, PRIVATE_MODE, activeBatches, findBatch, readJournal, writeBatchRecord } from "./batch.js";
import { BatchRefusedError } from "./run.js";

const CREATED = new Set(["created", "needs-review", "incomplete"]);

async function readProjectRel(repo: Repo, projectId: string, rel: string): Promise<string | undefined> {
  const k = projectDataKey(repo, projectId);
  const raw = await readMaybe(join(repoLibrary(repo).root, ...(k ? encName(rel) : rel).split("/")));
  if (!raw) return undefined;
  if (!k) return raw.toString("utf8");
  return (await decryptBytes((id) => (id === k.keyId ? k.key : undefined), raw)).toString("utf8");
}

export async function undoBatch(repo: Repo, projectId: string, batchId: string): Promise<{ removedSources: number; revertedMerges: number }> {
  if (activeBatches.has(batchId)) throw new BatchRefusedError("This import is still running; cancel it first.");
  const rec = await findBatch(repo, projectId, batchId);
  if (!rec) throw new NotFoundError("Import batch", batchId);
  if (rec.state === "undone") throw new BatchRefusedError("This import has already been undone.");
  const projectRel = repo.getProject(projectId).folder;
  const journal = await readJournal(repo, projectId, rec.dir);

  // 1. Merges, newest first.
  let revertedMerges = 0;
  const live = () => new Set(repo.listSourceIds(projectId));
  for (const e of [...journal].reverse()) {
    if (!e.mergedInto || !e.snapshot) continue;
    if (!live().has(e.mergedInto)) continue;
    const text = await readProjectRel(repo, projectId, `${projectRel}/${e.snapshot}`);
    if (!text) continue;
    const snap = SourceFile.parse(JSON.parse(text));
    const cur = await repo.getSource(projectId, e.mergedInto);
    await importChange(
      repo,
      projectId,
      { action: "store", store: { identifiable: cur.source.provenance.identifiable, hasLocation: false, ...(cur.source.provenance.legal.basis ? { legalBasis: cur.source.provenance.legal.basis } : {}) } },
      async (ops) => {
        const now = await ops.readSource(e.mergedInto!);
        const keep = new Set(snap.assets.map((a) => a.id));
        for (const a of now.assets) if (!keep.has(a.id)) await ops.trashAssetFile(a);
        await ops.writeSource(now, snap);
      },
      { op: "import.undo.merge", entity: { type: "source", id: e.mergedInto } },
    );
    revertedMerges++;
  }

  // 2. Sources the batch created: by provenance, the record and the journal (R45).
  const ids = new Set<string>(rec.createdSourceIds);
  for (const e of journal) if (e.sourceId && CREATED.has(e.outcome)) ids.add(e.sourceId);
  for (const id of repo.listSourceIds(projectId)) {
    if (ids.has(id)) continue;
    try {
      if ((await repo.getSource(projectId, id)).source.provenance.importBatchId === batchId) ids.add(id);
    } catch {
      // unreadable: not provably this batch's
    }
  }
  let removedSources = 0;
  for (const id of ids) {
    if (!live().has(id)) continue;
    await repo.deleteSource(projectId, id);
    removedSources++;
  }

  // 3. Collections (deepest first: they were created parents first) and tags.
  for (const id of [...rec.createdCollectionIds].reverse()) {
    try {
      await repo.deleteCollection(projectId, id);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }
  if (rec.createdTagIds.length) {
    await importChange(repo, projectId, BOOKKEEPING, async (ops) => {
      for (const t of rec.createdTagIds) await ops.deleteTag(t, repo.listSourceIds(projectId));
    }, { op: "import.undo.tags" });
  }

  // 4. Profile capture: forget the batch's posts (R44).
  if (rec.source.kind === "profile-capture") {
    const keys = new Set(journal.filter((e) => CREATED.has(e.outcome) || e.outcome === "duplicate").filter((e) => !e.sourceId || ids.has(e.sourceId)).map((e) => e.key));
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

  // 5. Review entries, the record, the audit log.
  const pending = (await projectReviewEntries(repo, projectId)).filter((e) => e.status === "pending" && (e.batchId === batchId || (e.sourceId && ids.has(e.sourceId))));
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
    removedCollections: rec.createdCollectionIds.length,
    removedTags: rec.createdTagIds.length,
  });
  return { removedSources, revertedMerges };
}
