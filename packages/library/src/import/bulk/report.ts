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
import { appendLibraryEvent, projectReviewEntries, type Repo } from "../../repo/repo.js";
import { NotFoundError } from "../../repo/errors.js";
import { createHash } from "node:crypto";
import { BOOKKEEPING, activeBatches, itemKeyHash, PRIVATE_MODE, countOutcomes, fileName, findBatch, latestByKey, readJournal, type GovernanceNote, type ShownState } from "./batch.js";

export interface ImportReport {
  batchId: string;
  number: number;
  kind: string;
  state: ShownState;
  startedAt: string;
  finishedAt?: string;
  counts: { items: number; created: number; needsReview: number; duplicates: number; merged: number; failed: number };
  failures: Array<{ item: string; reason: string }>;
  /** Items imported without some of their linked files (e.g. "attached file not found"); never a path (R66). */
  fileNotes: Array<{ item: string; note: string }>;
  pendingReview: Array<{ reviewId: string; sourceId?: string; reasons: string[] }>;
  governance: GovernanceNote[];
  notes: string[];
}

/** An item key safe to show: an absolute path (from a foreign adapter) is cut to its last part. */
function itemLabel(key: string): string {
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(key)) return key.split(/[\\/]/u).filter(Boolean).pop() ?? "item";
  return key;
}

/** Export and Calibre keys: `<file or folder name>@<12 hex>#<citation key | @n | book-id>`. */
const EXPORT_KEY = /@[0-9a-f]{12}#(.*)$/su;

/**
 * The name an item has in a report (R68). Export and Calibre items: the citation key (or "item N",
 * "book-N") with the first 8 hex of the item's HMAC (the provenance `import-item` value), never the
 * export's name or path hash. Other items: their key (a path relative to the import's root).
 */
export function reportLabel(key: string, secret: string | undefined): string {
  const m = EXPORT_KEY.exec(key);
  if (!m) return itemLabel(key);
  const tail = m[1] ?? "";
  const name = !tail ? "export" : tail.startsWith("@") ? `item ${tail.slice(1).split("~")[0]}` : tail;
  const tag = (secret ? itemKeyHash(secret, key) : createHash("sha256").update(key).digest("hex")).slice(0, 8);
  return `${name} (${tag})`;
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
    `- Failed: ${r.counts.failed}`,
    "",
  ];
  if (r.failures.length) {
    lines.push("## Failures", "");
    for (const f of r.failures) lines.push(`- ${f.item}: ${f.reason}`);
    lines.push("");
  }
  if (r.fileNotes.length) {
    lines.push("## Files not attached", "");
    for (const f of r.fileNotes) lines.push(`- ${f.item}: ${f.note}`);
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
  if (r.notes.length) {
    lines.push("## Notes", "");
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** The batch's report as it stands, from its record, journal and the review queue. Writes nothing. */
export async function batchReport(repo: Repo, projectId: string, batchId: string): Promise<ImportReport> {
  const rec = await findBatch(repo, projectId, batchId);
  if (!rec) throw new NotFoundError("Import batch", batchId);
  const journal = await readJournal(repo, projectId, rec.dir);
  const latest = latestByKey(journal);
  // File notes from any line of the item (a later review decision's line does not repeat them).
  const notesByKey = new Map<string, string[]>();
  for (const e of journal) if (e.notes?.length && !notesByKey.has(e.key)) notesByKey.set(e.key, e.notes);
  const c = countOutcomes(latest.values());
  const pending = (await projectReviewEntries(repo, projectId)).filter((e) => e.batchId === batchId && e.status === "pending");
  const report: ImportReport = {
    batchId,
    number: rec.number,
    kind: rec.source.kind,
    state: rec.state === "running" && !activeBatches.has(batchId) ? "interrupted" : rec.state,
    startedAt: rec.startedAt,
    ...(rec.finishedAt ? { finishedAt: rec.finishedAt } : {}),
    counts: c,
    failures: [...latest.values()].filter((e) => e.outcome === "failed").map((e) => ({ item: reportLabel(e.key, rec.secret), reason: e.reason ?? "The item could not be imported." })),
    fileNotes: [...notesByKey].flatMap(([key, notes]) => notes.map((note) => ({ item: reportLabel(key, rec.secret), note }))),
    pendingReview: pending.map((e) => ({ reviewId: e.id, ...(e.sourceId ? { sourceId: e.sourceId } : {}), reasons: e.reasons })),
    governance: rec.governance,
    notes: rec.notes,
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
