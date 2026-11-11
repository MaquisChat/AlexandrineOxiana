/**
 * Resolving an interrupted change by hand (R27). Recovery on open (txn.ts) settles what it safely
 * can; a marker it cannot settle stays, and its project refuses changes. The researcher sees each
 * marker here and chooses:
 * - keep: only when the marker shows the change committed (every allow audit event of the
 *   transaction is in the audit log): the change is finished (destroyed files overwritten, trash and
 *   backups removed) and the marker removed;
 * - roll back: only when the change is not committed and the marker is valid (every path it names
 *   lies in its own project): every step is undone in reverse (partial change-log and audit lines
 *   truncated), then the marker removed. This overrides recovery's caution when the audit log could
 *   not be trusted to say "not committed" (the researcher decides, and it is recorded);
 * - an invalid marker offers neither: nothing it names may be touched.
 * A half-written change is therefore never kept. The choice is recorded as a `txn.resolve` audit
 * event in the project, after the marker is gone (the rollback truncates the audit log back to
 * where the transaction began, so recording it earlier would undo the record). Runs serialised
 * with every other write, so no marker of a change in progress is ever listed or touched.
 */
import { posix } from "node:path";
import type { Head } from "./audit-store.js";
import { NotFoundError, PendingWriteChoiceError } from "./errors.js";
import { loadProjectFolder, type ProjectState, type RepoCore } from "./state.js";
import { finishCommitted, inspectMarker, inspectMarkers, rollBackMarker, type MarkerInspection, type MarkerStatus } from "./txn.js";

export type PendingWriteChoice = "roll-back" | "keep";

export interface PendingWrite {
  txn: string;
  /** The project the marker names, or "*" when it cannot be read. */
  projectId: string;
  status: MarkerStatus;
  canKeep: boolean;
  canRollBack: boolean;
  /** Why it was not settled automatically (no paths). */
  detail?: string;
  /** Steps the marker records. */
  steps: number;
}

const allowed = (i: MarkerInspection): PendingWriteChoice[] =>
  i.status === "committed" ? ["keep"] : i.status === "uncommitted" || i.status === "unverifiable" ? ["roll-back"] : [];

async function anchorsOf(core: RepoCore): Promise<(projectId: string) => Head | undefined> {
  const all = await core.anchors.readAll().catch(() => ({}) as Record<string, Head>);
  return (pid) => (all as Record<string, Head>)[core.anchorKey(pid)];
}

function view(i: MarkerInspection): PendingWrite {
  const a = allowed(i);
  return {
    txn: i.txn,
    projectId: i.projectId,
    status: i.status,
    canKeep: a.includes("keep"),
    canRollBack: a.includes("roll-back"),
    ...(i.detail ? { detail: i.detail } : {}),
    steps: i.marker?.entries.length ?? 0,
  };
}

/** Every unresolved interrupted change, with the choices it allows. Reads only (read-only libraries too). */
export function pendingWrites(core: RepoCore): Promise<PendingWrite[]> {
  return core.serial(async () => (await inspectMarkers(core.root, await anchorsOf(core))).map(view));
}

const folderOf = (rel: string) => posix.normalize(rel.replaceAll("\\", "/")).toLowerCase();

/** Whether any marker still names this project (by id or by folder). */
function namesProject(i: MarkerInspection, st: ProjectState): boolean {
  return i.projectId === st.project.id || (i.projectFolder !== undefined && folderOf(i.projectFolder) === folderOf(st.rel));
}

const TXN = /^[0-9a-f-]{36}$/;

export async function resolvePendingWrite(core: RepoCore, txn: string, choice: PendingWriteChoice): Promise<{ txn: string; choice: PendingWriteChoice; projectId: string }> {
  core.assertWritable();
  if (choice !== "roll-back" && choice !== "keep") throw new PendingWriteChoiceError(txn, [], 'The choice must be "roll-back" or "keep".');
  return core.serial(async () => {
    core.assertWritable();
    if (typeof txn !== "string" || !TXN.test(txn)) throw new NotFoundError("Interrupted change", String(txn));
    const present = (await inspectMarkers(core.root, () => undefined)).some((i) => i.txn === txn);
    if (!present) throw new NotFoundError("Interrupted change", txn);
    const i = await inspectMarker(core.root, txn, await anchorsOf(core));
    const ok = allowed(i);
    if (!ok.includes(choice)) {
      const why =
        i.status === "invalid"
          ? "Its record cannot be read safely, so nothing it names can be undone or kept."
          : choice === "keep"
            ? "It was not completed, so keeping it would keep a half-written change; it can only be rolled back."
            : "It was completed (its audit record is complete), so it can only be kept.";
      throw new PendingWriteChoiceError(txn, ok, why);
    }
    const m = i.marker!;
    const st = core.projects.get(m.projectId);
    if (!st) throw new NotFoundError("Project", m.projectId);
    const done = choice === "keep" ? await finishCommitted(core.root, m) : await rollBackMarker(core.root, m);
    if (!done) {
      throw new Error(
        choice === "keep"
          ? "The change could not be finished: files it destroyed could not be overwritten yet. Nothing else was changed; try again."
          : "The change could not be undone completely: a step failed. The record of it is kept; try again.",
      );
    }
    // What is in memory was read with the change half there: read the project again from disk (its
    // sources, project data and audit log, which a rollback truncates back to the change's start).
    const fresh = await loadProjectFolder(core, st.rel.slice("Projects/".length));
    if (fresh) Object.assign(st, { project: fresh.st.project, data: fresh.st.data, audit: fresh.st.audit, sources: fresh.st.sources, manifest: fresh.st.manifest });
    // Its warnings are settled.
    for (let k = core.integrityWarnings.length - 1; k >= 0; k--) if (core.integrityWarnings[k]!.detail.includes(`transaction ${txn}`)) core.integrityWarnings.splice(k, 1);
    const at = core.clock().toISOString();
    await core.auditNow(st, {
      ...core.auditBase(st, at),
      action: "txn.resolve",
      entity: { type: "project", id: st.project.id },
      details: { txn, choice, status: i.status, steps: m.entries.length, ...(i.detail ? { reason: i.detail } : {}) },
    });
    // Writes resume unless something else still holds the project.
    const others = (await inspectMarkers(core.root, () => undefined)).some((x) => namesProject(x, st));
    const otherBlocks = core.integrityWarnings.some(
      (w) => w.projectId === st.project.id && (w.kind === "incomplete-audit-line-pending" || w.kind === "audit-append-failed-at-open"),
    );
    if (!others && !otherBlocks) st.recoveryPending = false;
    return { txn, choice, projectId: st.project.id };
  });
}
