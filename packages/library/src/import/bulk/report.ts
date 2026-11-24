/**
 * The import report (spec 5.4 step 7): counts by outcome, failures with their reasons, items still
 * waiting for review, the governance decisions applied, and notes (e.g. a file-name pattern that was
 * switched off by the watchdog). Written to `imports/batch-<NNNN>/report.md` and `report.json`
 * (encrypted in encrypted projects) and recorded in the audit log as `import.batch` (counts only).
 *
 * Items are named by their key: a path relative to the import's root (never an absolute path), or
 * the source's own key (e.g. a post id); export and Calibre items by citation key (or "item N")
 * plus an 8-hex HMAC (reportLabel). Reasons and file notes are fixed sentences or the policy's own
 * reason, never a path.
 */
import { ZOTERO_REPORT_ROWS } from "@ao/shared";
import { appendLibraryEvent, projectReviewEntries, type Repo } from "../../repo/repo.js";
import { NotFoundError } from "../../repo/errors.js";
import { markUndoTarget } from "./merge.js";
import { createHash } from "node:crypto";
import { BOOKKEEPING, activeBatches, unsavedStops, itemKeyHash, PRIVATE_MODE, countOutcomes, fileName, findBatch, latestByKey, readJournal, undoneBatchIds, type GovernanceNote, type ShownState } from "./batch.js";

export interface ImportReport {
  batchId: string;
  number: number;
  kind: string;
  state: ShownState;
  startedAt: string;
  finishedAt?: string;
  counts: {
    items: number;
    created: number;
    needsReview: number;
    duplicates: number;
    merged: number;
    updated: number;
    unchanged: number;
    deletedHere: number;
    failed: number;
    /**
     * Task Z5 (absent in reports written before it; R224): sources this batch marked gone from Zotero (of them in
     * its bin), sources already marked so by an earlier batch, sources back (of them also updated, which are in
     * `updated` too), and items gone with no source of their own here.
     */
    goneInZotero?: number;
    goneInZoteroBin?: number;
    goneAlready?: number;
    backInZotero?: number;
    backInZoteroUpdated?: number;
    goneNotMarked?: number;
    /**
     * R474 M7 (present only when not 0): of `goneInZotero`, the sources whose undo would put back the mark an earlier
     * batch still standing gave them (a deletion over a bin mark), not take the mark off. Counted when the report is read.
     */
    goneInZoteroMarkBefore?: number;
    /**
     * Task Z6 (absent in reports written before it): items with a field changed in Zotero and here, waiting for the
     * researcher (an item that also took in other changes is in `updated` too); collections renamed in Zotero that
     * arrived under their new name, the old one kept.
     */
    conflicts?: number;
    collectionsRenamed?: number;
    /** R236 a: items with a field Zotero cleared that keeps its value here. */
    clearedInZoteroKept?: number;
  };
  /** Files this import stored: copied into the library, and left as links where they were (R136). Always given. */
  files: { copied: number; linked: number };
  failures: Array<{ item: string; reason: string }>;
  /** Items imported without some of their linked files (e.g. "attached file not found"); never a path (R66). */
  fileNotes: Array<{ item: string; note: string }>;
  pendingReview: Array<{ reviewId: string; sourceId?: string; reasons: string[] }>;
  /** Re-imports (R72): fields not updated because they were changed after the last import (JSON pointers). */
  keptFields: Array<{ item: string; fields: string[] }>;
  /** Annotations the researcher deleted here that Zotero still has: not imported again (counted over the newest line of each item). */
  annotationsDeletedHere: number;
  governance: GovernanceNote[];
  notes: string[];
  /**
   * The collections and tags this batch created (R118), by id, in the order it made them. An undo
   * removes the ones nobody else used, so some may no longer exist.
   */
  created: { collectionIds: string[]; tagIds: string[] };
}

/** An item key safe to show: an absolute path (from a foreign adapter) is cut to its last part. */
function itemLabel(key: string): string {
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(key)) return key.split(/[\\/]/u).filter(Boolean).pop() ?? "item";
  return key;
}

/** Export and Calibre keys: `<file or folder name>@<12 hex>#<citation key | @n | book-id>`. */
const EXPORT_KEY_MARK = /@[0-9a-f]{12}#/gu;

/**
 * The name an item has in a report (R68). Export and Calibre items: the citation key (or "item N",
 * "book-N") after the LAST `@<12 hex>#` (a file name containing that pattern cannot inject a label,
 * R70), with the first 8 hex of the item's HMAC (the provenance `import-item` value); never the
 * export's name or path hash. `secret` null: no tag (the dry run, which has no batch secret yet).
 * Other items: their key (a path relative to the import's root).
 */
export function reportLabel(key: string, secret: string | null | undefined): string {
  let end = -1;
  for (const m of key.matchAll(EXPORT_KEY_MARK)) end = m.index + m[0].length;
  if (end < 0) return itemLabel(key);
  const tail = key.slice(end);
  const name = !tail ? "export" : tail.startsWith("@") ? `item ${tail.slice(1).split("~")[0]}` : tail;
  if (secret === null) return name;
  const tag = (secret ? itemKeyHash(secret, key) : createHash("sha256").update(key).digest("hex")).slice(0, 8);
  return `${name} (${tag})`;
}

/** Annotations left out over the per-source caps (R74 I4), as a report note. */
const droppedNote = (n: number): string[] =>
  n ? [`${n.toLocaleString("en-US")} ${n === 1 ? "annotation" : "annotations"} over the per-source limit (10,000 annotations or 16 MB of text) ${n === 1 ? "was" : "were"} not imported.`] : [];

/** FR-463: sources back in Zotero that were also updated are counted in both rows (R224 a), and this says so. */
const backUpdatedNote = (n: number): string[] =>
  n ? [`${n.toLocaleString("en-US")} ${n === 1 ? "source back in Zotero was" : "sources back in Zotero were"} also updated, so ${n === 1 ? "it is" : "they are"} counted twice: as back in Zotero and as updated.`] : [];

/** R393: failures by reason, in the order each reason first occurs, with their items in order. */
export function failureGroups(failures: ImportReport["failures"]): Array<{ reason: string; items: string[] }> {
  const groups = new Map<string, string[]>();
  for (const f of failures) {
    const items = groups.get(f.reason);
    if (items) items.push(f.item);
    else groups.set(f.reason, [f.item]);
  }
  return [...groups].map(([reason, items]) => ({ reason, items }));
}

function markdown(r: ImportReport): string {
  const lines = [
    `# Import report: batch ${r.number}`,
    "",
    `Source: ${r.kind}. State: ${r.state}. Started ${r.startedAt}${r.finishedAt ? `, finished ${r.finishedAt}` : ""}.`,
    "",
    "## Counts",
    "",
    `- Items: ${r.counts.items}`,
    `- Created: ${r.counts.created}`,
    `- Waiting for review: ${r.counts.needsReview}`,
    `- Duplicates (not imported again): ${r.counts.duplicates}`,
    `- Merged into existing sources: ${r.counts.merged}`,
    ...(r.counts.updated || r.counts.unchanged ? [`- Updated from a newer version: ${r.counts.updated}`, `- Unchanged since the last import: ${r.counts.unchanged}`] : []),
    ...(r.counts.deletedHere ? [`- Deleted here — not re-imported: ${r.counts.deletedHere}`] : []),
    // Task Z5: kept here and marked, never deleted.
    ...((r.counts.goneInZotero ?? 0) - (r.counts.goneInZoteroBin ?? 0) > 0 ? [`- Marked as no longer in Zotero: ${(r.counts.goneInZotero ?? 0) - (r.counts.goneInZoteroBin ?? 0)}`] : []),
    ...(r.counts.goneInZoteroBin ? [`- In the Zotero bin: ${r.counts.goneInZoteroBin}`] : []),
    ...(r.counts.goneAlready ? [`- Still gone from Zotero (marked earlier): ${r.counts.goneAlready}`] : []),
    ...(r.counts.backInZotero ? [`- Back in Zotero: ${r.counts.backInZotero}`] : []),
    // Task Z6: the researcher's value was kept; Zotero's waits beside it in the review queue.
    ...(r.counts.conflicts ? [`- ${ZOTERO_REPORT_ROWS.conflicts}: ${r.counts.conflicts}`] : []),
    ...(r.counts.clearedInZoteroKept ? [`- ${ZOTERO_REPORT_ROWS.clearedInZoteroKept}: ${r.counts.clearedInZoteroKept}`] : []),
    ...(r.counts.collectionsRenamed ? [`- Collections renamed in Zotero arrive under their new name; the old one is kept here: ${r.counts.collectionsRenamed}`] : []),
    ...(r.annotationsDeletedHere ? [`- Annotations deleted here — not re-imported: ${r.annotationsDeletedHere}`] : []),
    `- Failed: ${r.counts.failed}`,
    `- Files copied into the library: ${r.files.copied}`,
    `- Files left as links: ${r.files.linked}`,
    "",
  ];
  // R393: the notes (where a stopped batch says why) right under the counts, so that they cannot be missed.
  if (r.notes.length) {
    lines.push("## Notes", "");
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  // R393: failures that share a reason are one entry, with their number and the items under it.
  if (r.failures.length) {
    lines.push("## Failures", "");
    for (const g of failureGroups(r.failures)) {
      lines.push(`- ${g.reason} (${g.items.length} ${g.items.length === 1 ? "item" : "items"})`);
      for (const item of g.items) lines.push(`  - ${item}`);
    }
    lines.push("");
  }
  if (r.fileNotes.length) {
    lines.push("## Files not attached", "");
    for (const f of r.fileNotes) lines.push(`- ${f.item}: ${f.note}`);
    lines.push("");
  }
  if (r.keptFields.length) {
    lines.push("## Fields kept because they were edited after the last import", "");
    for (const k of r.keptFields) lines.push(`- ${k.item}: ${k.fields.join(", ")}`);
    lines.push("");
  }
  if (r.pendingReview.length) {
    lines.push("## Still waiting for review", "", `${r.pendingReview.length} item(s) are in the review queue.`, "");
  }
  if (r.governance.length) {
    lines.push("## Governance decisions", "");
    for (const g of r.governance) {
      const what = g.result === "deny" ? `denied${g.reason ? ` (${g.reason})` : ""}` : g.result === "allow_with_conditions" ? "allowed with conditions" : "allowed";
      lines.push(`- ${g.action}: ${what}${g.items !== undefined ? ` for ${g.items} item(s)` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** The batch's report as it stands, from its record, journal and the review queue. Writes nothing. */
/** The stopping note of a batch not running whose record could not be saved (unsavedStops), unless the record has it. */
function unsavedNote(notes: string[], batchId: string): string[] {
  const n = unsavedStops.get(batchId);
  return n && !activeBatches.has(batchId) && !notes.includes(n) ? [n] : [];
}

export async function batchReport(repo: Repo, projectId: string, batchId: string): Promise<ImportReport> {
  const rec = await findBatch(repo, projectId, batchId);
  if (!rec) throw new NotFoundError("Import batch", batchId);
  const journal = await readJournal(repo, projectId, rec.dir);
  const latest = latestByKey(journal);
  // File notes from any line of the item (a later review decision's line does not repeat them).
  const notesByKey = new Map<string, string[]>();
  for (const e of journal) if (e.notes?.length && !notesByKey.has(e.key)) notesByKey.set(e.key, e.notes);
  const c = countOutcomes(latest.values());
  // R474 M7: the marks whose undo puts an earlier mark back (as undo does: the newest mark whose batch still stands).
  const marked = [...latest.values()].filter((e) => e.outcome === "zotero-gone" && e.merge?.availability);
  const undone = marked.some((e) => e.merge!.availability!.marks?.length) ? await undoneBatchIds(repo, projectId) : new Set<string>();
  const markBefore = marked.filter((e) => markUndoTarget(e.merge!.availability!, (id) => undone.has(id)).zotero !== undefined).length;
  // Files stored, by item (its first line that stored any); an item that failed or was skipped in review keeps none.
  const filesByKey = new Map<string, { copied: number; linked: number }>();
  for (const e of journal) if (e.files && !filesByKey.has(e.key)) filesByKey.set(e.key, e.files);
  const files = { copied: 0, linked: 0 };
  for (const [key, f] of filesByKey) {
    const last = latest.get(key)?.outcome;
    if (last === "failed" || last === "skipped") continue;
    files.copied += f.copied;
    files.linked += f.linked;
  }
  const pending = (await projectReviewEntries(repo, projectId)).filter((e) => e.batchId === batchId && e.status === "pending");
  const report: ImportReport = {
    batchId,
    number: rec.number,
    kind: rec.source.kind,
    state: rec.state === "running" && !activeBatches.has(batchId) ? "interrupted" : rec.state,
    startedAt: rec.startedAt,
    ...(rec.finishedAt ? { finishedAt: rec.finishedAt } : {}),
    counts: { ...c, ...(markBefore ? { goneInZoteroMarkBefore: markBefore } : {}) },
    files,
    failures: [...latest.values()].filter((e) => e.outcome === "failed").map((e) => ({ item: reportLabel(e.key, rec.secret), reason: e.reason ?? "The item could not be imported." })),
    fileNotes: [...notesByKey].flatMap(([key, notes]) => notes.map((note) => ({ item: reportLabel(key, rec.secret), note }))),
    pendingReview: pending.map((e) => ({ reviewId: e.id, ...(e.sourceId ? { sourceId: e.sourceId } : {}), reasons: e.reasons })),
    keptFields: [...latest.values()].filter((e) => e.merge?.kept?.length).map((e) => ({ item: reportLabel(e.key, rec.secret), fields: e.merge!.kept! })),
    annotationsDeletedHere: [...latest.values()].reduce((n, e) => n + (e.annotationsDeletedHere ?? 0), 0),
    governance: rec.governance,
    // R413 b, c: a stop whose record could not be saved still says why.
    notes: [...rec.notes, ...unsavedNote(rec.notes, batchId), ...droppedNote([...latest.values()].reduce((n, e) => n + (e.annotationsDropped ?? 0), 0)), ...backUpdatedNote(c.backInZoteroUpdated)],
    created: { collectionIds: [...rec.createdCollectionIds], tagIds: [...rec.createdTagIds] },
  };
  return report;
}

/**
 * When a run ends: writes report.md and report.json into the batch folder (encrypted in encrypted
 * projects) and records `import.batch` in the audit log (counts only). Viewing a report does not.
 */
export async function writeBatchReport(repo: Repo, projectId: string, batchId: string): Promise<ImportReport> {
  const report = await batchReport(repo, projectId, batchId);
  const rec = (await findBatch(repo, projectId, batchId))!;
  const projectRel = repo.getProject(projectId).folder;
  await repo.mutate(
    projectId,
    BOOKKEEPING,
    async (tx) => {
      const dir = `${projectRel}/${rec.dir}`;
      await tx.mkdir(dir);
      const o = { encrypt: tx.encrypted, ...(tx.encrypted ? {} : { mode: PRIVATE_MODE }) };
      await tx.writeFile(`${dir}/${fileName("report.json", tx.encrypted)}`, JSON.stringify(report, null, 2), o);
      await tx.writeFile(`${dir}/${fileName("report.md", tx.encrypted)}`, markdown(report), o);
    },
    { op: "import.report" },
  );
  await appendLibraryEvent(repo, projectId, "import.batch", {
    batchId,
    number: rec.number,
    kind: rec.source.kind,
    state: report.state,
    ...report.counts,
    pendingReview: report.pendingReview.length,
    governanceDenies: rec.governance.filter((g) => g.result === "deny").reduce((n, g) => n + (g.items ?? 1), 0),
    notes: report.notes.length,
  });
  return report;
}
