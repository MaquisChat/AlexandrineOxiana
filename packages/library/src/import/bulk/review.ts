/**
 * The import review queue (spec 5.4 step 4; R31): items a batch created below the confidence
 * threshold, or that may duplicate an existing source, wait in `review/pending.jsonl` with the
 * batch id. Each decision and each bulk edit is one governed change (R26: txn, change log, audit;
 * ops `review.decide` / `review.bulk-edit`), and a decided entry gets a later `resolved` line.
 *
 *   accept            keep the source; with `draft`, its fields replace the source's (user evidence)
 *   accept-candidate  take the fields of candidate `index` (a lookup result) for the source
 *   merge             move the item's files and missing fields into `sourceId` (snapshotted first,
 *                     journaled in the batch so undo restores it) and remove the item's source
 *   skip              remove the item's source (its files were copies; linked originals are kept)
 *   keep-both         keep the source as it is
 */
import { join } from "node:path";
import { BIBLIO_FIELDS, biblioOf, newId, recheckSourceFile, type FieldEvidence, type LookupEvidence, type SourceDraft, type SourceFile, type SourceType } from "@ao/core";
import { NotFoundError } from "../../repo/errors.js";
import type { ReviewEntry } from "../../repo/review.js";
import { storeRequest } from "../../repo/sources.js";
import { importChange, projectCollectionsAndTags, projectReviewEntries, repoLibrary, type Repo } from "../../repo/repo.js";
import type { LookupResult } from "../../lookup/index.js";
import { PRIVATE_MODE, appendJournal, fileName, findBatch, readJournal, runListeners, type JournalEntry } from "./batch.js";
import { zoteroKeysOf } from "../../repo/tombstones.js";
import { applyMerge, missingFields } from "./merge.js";
import { BatchRefusedError } from "./run.js";

export type ReviewDecision =
  | { action: "accept"; draft?: SourceDraft }
  | { action: "accept-candidate"; index: number }
  | { action: "merge"; sourceId: string }
  | { action: "skip" }
  | { action: "keep-both" };

export interface ReviewPatch {
  type?: SourceType;
  tagIds?: string[];
  collectionId?: string;
}

/** Pending review entries of one batch. */
export async function listReview(repo: Repo, projectId: string, batchId: string): Promise<ReviewEntry[]> {
  return (await projectReviewEntries(repo, projectId)).filter((e) => e.batchId === batchId && e.status === "pending");
}

async function pendingEntry(repo: Repo, projectId: string, itemId: string): Promise<ReviewEntry & { sourceId: string }> {
  const e = (await projectReviewEntries(repo, projectId)).find((x) => x.id === itemId);
  if (!e || !e.sourceId) throw new NotFoundError("Review item", itemId);
  if (e.kind !== "import") throw new BatchRefusedError("This review entry is not an import item; it is reviewed with the source's verification.");
  if (e.status !== "pending") throw new BatchRefusedError("This item has already been reviewed.");
  return e as ReviewEntry & { sourceId: string };
}

const DRAFT_FIELDS = ["type", "title", "creators", "container", "publisher", ...BIBLIO_FIELDS, "issued", "identifiers"] as const;

/** Applies field values to a source, with evidence of `source` kind, and rechecks its verification. */
function applyFields(cur: SourceFile, fields: Partial<SourceDraft>, evidence: FieldEvidence["source"], at: string, actor: string, lookups: LookupEvidence[] = []): SourceFile {
  const patch: Record<string, unknown> = {};
  const ev: FieldEvidence[] = [];
  for (const k of DRAFT_FIELDS) {
    const v = fields[k];
    if (v === undefined) continue;
    patch[k] = v;
    if (k === "identifiers") {
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) if (iv !== undefined) ev.push({ field: `/identifiers/${ik}`, value: iv, source: evidence, at });
    } else ev.push({ field: `/${k}`, value: k === "title" || k === "container" ? (v as { variants: Array<{ value: string }> }).variants[0]?.value : v, source: evidence, at });
  }
  const next: SourceFile = {
    ...cur,
    source: { ...cur.source, ...patch, modifiedAt: at, modifiedBy: actor },
    fieldEvidence: [...cur.fieldEvidence, ...ev],
  };
  return recheckSourceFile(next, { lookups });
}

function fromCandidate(c: LookupResult): Partial<SourceDraft> {
  const mt = (value: string) => ({ variants: [{ lang: "und", kind: "original" as const, value }] });
  return {
    ...(c.type !== "other" ? { type: c.type } : {}),
    title: mt(c.title),
    ...(c.creators.length ? { creators: c.creators } : {}),
    ...(c.issued ? { issued: c.issued } : {}),
    ...(c.container ? { container: mt(c.container) } : {}),
    ...(c.publisher ? { publisher: c.publisher } : {}),
    ...biblioOf(c),
    identifiers: { ...(c.identifiers.doi ? { doi: c.identifiers.doi } : {}), ...(c.identifiers.isbn?.length ? { isbn: c.identifiers.isbn } : {}), ...(c.identifiers.issn ? { issn: c.identifiers.issn } : {}) },
  };
}

export async function decideReview(repo: Repo, projectId: string, itemId: string, d: ReviewDecision): Promise<void> {
  const entry = await pendingEntry(repo, projectId, itemId);
  const item = await repo.getSource(projectId, entry.sourceId);
  const reqs = [storeRequest(item.source.provenance)];
  let target: SourceFile | undefined;
  let batchDir: string | undefined;
  if (d.action === "merge") {
    if (d.sourceId === entry.sourceId) throw new BatchRefusedError("An item cannot be merged into itself.");
    target = await repo.getSource(projectId, d.sourceId);
    reqs.push(storeRequest(target.source.provenance));
  }
  batchDir = entry.batchId ? (await findBatch(repo, projectId, entry.batchId))?.dir : undefined;
  // The item's journal key, so the decision's line supersedes the run's outcome (counts stay in step).
  const itemKey = batchDir ? [...(await readJournal(repo, projectId, batchDir))].reverse().find((e) => e.sourceId === entry.sourceId && e.outcome === "needs-review")?.key : undefined;
  if (d.action === "accept-candidate") {
    const c = entry.candidates?.[d.index];
    if (!c) throw new BatchRefusedError("That candidate does not exist.");
  }
  const projectRel = repo.getProject(projectId).folder;
  const root = repoLibrary(repo).root;
  let journaled: JournalEntry | undefined;
  await importChange(
    repo,
    projectId,
    reqs,
    async (ops) => {
      const { tx } = ops;
      const cur = await ops.readSource(entry.sourceId);
      let line: Omit<JournalEntry, "key"> = { outcome: "created", sourceId: cur.source.id };
      if (d.action === "accept" && d.draft) {
        await ops.writeSource(cur, applyFields(cur, d.draft, { kind: "user" }, tx.at, tx.actor));
      } else if (d.action === "accept-candidate") {
        const c = entry.candidates![d.index] as LookupResult;
        const lookups: LookupEvidence[] = [{ provider: c.provider, title: c.title, ...(c.creators.length ? { creators: c.creators } : {}), ...(c.issued ? { issued: c.issued } : {}) }];
        await ops.writeSource(cur, applyFields(cur, fromCandidate(c), { kind: "lookup", provider: c.provider }, tx.at, tx.actor, lookups));
      } else if (d.action === "merge") {
        const tgt = await ops.readSource(d.sourceId);
        let snapshot: string | undefined;
        if (batchDir) {
          // The target as it was (kept with the batch for the record; undo reverts the merge record).
          snapshot = `${batchDir}/snapshots/${tgt.source.id}-${Date.now()}-review.json`;
          await tx.mkdir(`${projectRel}/${batchDir}/snapshots`);
          const name = fileName(snapshot.slice(snapshot.lastIndexOf("/") + 1), tx.encrypted);
          await tx.writeFile(`${projectRel}/${batchDir}/snapshots/${name}`, JSON.stringify(tgt), { encrypt: tx.encrypted, ...(tx.encrypted ? {} : { mode: PRIVATE_MODE }) });
        }
        const have = new Set(tgt.assets.map((a) => a.sha256));
        const added = [];
        const label = tx.at.slice(0, 16).replace("T", " ").replace(":", "");
        for (const a of cur.assets.filter((x) => x.role === "original")) {
          if (have.has(a.sha256)) continue;
          have.add(a.sha256);
          if (a.linked) {
            added.push({ ...a, id: newId(), sourceId: tgt.source.id });
            continue;
          }
          const ext = a.path.replace(/\.enc$/u, "").split(".").pop() ?? "bin";
          added.push(await ops.copyOriginal(tgt, { fromPath: join(root, ...a.path.split("/")), kind: a.kind, ext, mime: a.mime, label: `${a.kind} added ${label}`, ...(a.encrypted ? { fromEncrypted: true } : {}) }));
        }
        // The Zotero items the reviewed source stands for are remembered on the target (R74 M5).
        const merged = applyMerge(tgt, added, missingFields(tgt, cur.source as unknown as SourceDraft), cur.fieldEvidence, tx.at, tx.actor, [], zoteroKeysOf(cur));
        await ops.writeSource(tgt, merged.next);
        const { tombstoned } = await ops.deleteSource(cur.source.id);
        line = { outcome: "merged", sourceId: tgt.source.id, mergedInto: tgt.source.id, ...(snapshot ? { snapshot } : {}), merge: merged.record, ...(tombstoned.length ? { tombstoned } : {}) };
      } else if (d.action === "skip") {
        // A skip is the user's deletion: recorded (R73), and journaled so undo takes it back (R74 I3).
        const { tombstoned } = await ops.deleteSource(cur.source.id);
        line = { outcome: "skipped", sourceId: cur.source.id, ...(tombstoned.length ? { tombstoned } : {}) };
      }
      if (batchDir && itemKey) {
        journaled = { key: itemKey, ...line, decision: d.action };
        await appendJournal(tx, projectRel, batchDir, [journaled]);
      }
      await ops.updateReview({ ...entry, status: "resolved", resolvedAt: tx.at, decision: d.action });
    },
    { op: "review.decide", entity: { type: "source", id: entry.sourceId } },
  );
  // A run of this batch in progress: its counts follow the decision (the line is already journaled).
  if (journaled && entry.batchId) runListeners.get(entry.batchId)?.(journaled);
}

export async function bulkEditReview(repo: Repo, projectId: string, itemIds: string[], p: ReviewPatch): Promise<void> {
  const entries = await Promise.all(itemIds.map((id) => pendingEntry(repo, projectId, id)));
  const { collections, tags } = await projectCollectionsAndTags(repo, projectId);
  if (p.collectionId && !collections.some((c) => c.id === p.collectionId)) throw new NotFoundError("Collection", p.collectionId);
  const ws = await repo.listWorkspaceTags();
  for (const t of p.tagIds ?? []) if (!tags.some((x) => x.id === t) && !ws.some((x) => x.id === t)) throw new NotFoundError("Tag", t);
  for (const e of entries) {
    const sf = await repo.getSource(projectId, e.sourceId);
    await importChange(
      repo,
      projectId,
      storeRequest(sf.source.provenance),
      async (ops) => {
        const cur = await ops.readSource(e.sourceId);
        const s = cur.source;
        await ops.writeSource(cur, {
          ...cur,
          source: {
            ...s,
            ...(p.type ? { type: p.type } : {}),
            ...(p.tagIds ? { tagIds: [...new Set([...s.tagIds, ...p.tagIds])] } : {}),
            ...(p.collectionId ? { collectionIds: [...new Set([...s.collectionIds, p.collectionId])] } : {}),
            modifiedAt: ops.tx.at,
            modifiedBy: ops.tx.actor,
          },
        });
      },
      { op: "review.bulk-edit", entity: { type: "source", id: e.sourceId } },
    );
  }
}
