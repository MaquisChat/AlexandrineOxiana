/**
 * Resolving an interrupted change by hand (R27, R118 g, R131). Recovery on open (txn.ts) settles what
 * it safely can; a marker it cannot settle stays, and its project refuses changes. The researcher
 * sees each marker here and chooses:
 * - keep: only when the marker shows the change committed (every allow audit event of the
 *   transaction is in the audit log): the change is finished (destroyed files overwritten, trash and
 *   backups removed) and the marker removed;
 * - roll back: only when the marker is valid, the change is not committed, and the audit log can be
 *   trusted to say so: its chain before the change verifies, no later event exists (the anchor is
 *   not past the change's start, the log holds exactly the recorded number of events where the
 *   change began) and every recorded append offset lands on a line boundary. Every step is then
 *   undone in reverse (partial change-log and audit lines truncated) and the marker removed;
 * - an invalid or unverifiable marker offers neither: nothing it names is touched (R131 a). Acting on
 *   offsets the audit record cannot back would destroy committed history.
 * The resolve is durable before it acts (R131 c): the choice is first written into the marker; the
 * action is repeatable; the `txn.resolve` audit event is appended after the action (a rollback
 * truncates the audit log back to where the change began) and the marker goes only after that
 * event is written. A choice left recorded by a crash or a failed append is completed, and audited,
 * on the next open (`completeRecordedResolves`) or by resolving again. A resolve never moves the
 * device's audit anchor past a mismatch (R131 d): the project then waits for the next open, which
 * records the mismatch first. Runs serialised with every other write, so no marker of a change in
 * progress is ever listed or touched.
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join, posix } from "node:path";
import { evaluate, parseGovernance, verifyChain, type AuditEvent } from "@ao/core";
import { ROLLBACK_INCOMPLETE_ANSWER, incompleteRollbackOf, type IncompleteRollback } from "@ao/shared";
import { AuditStore, auditSegments, checkAnchor, type Head } from "./audit-store.js";
import { assertContained, exists, incompleteTail, readMaybe, truncateDurable } from "./io.js";
import { NotFoundError, PendingWriteChoiceError, PendingWriteIncompleteError, PolicyDeniedError } from "./errors.js";
import { appendLibraryAudit } from "./library-audit.js";
import { keepWarning } from "./kept-warnings.js";
import { scanIncompleteLines } from "./incomplete-lines.js";
import { SimulatedCrash, maybeCrash } from "./seams.js";
import { loadProjectFolder, type ProjectState, type RepoCore } from "./state.js";
import {
  finishCommittedSteps,
  fromRel,
  inspectMarker,
  inspectMarkers,
  markerPaths,
  recordResolve,
  removeMarker,
  undoEntries,
  type MarkerInspection,
  type MarkerStatus,
  type TxnMarker,
  type UndoCause,
} from "./txn.js";

export type PendingWriteChoice = "roll-back" | "keep";

export interface PendingWrite {
  txn: string;
  /** The project the marker names, or "*" when it cannot be read. */
  projectId: string;
  status: MarkerStatus;
  canKeep: boolean;
  canRollBack: boolean;
  /** Why it was not settled automatically, or why no choice is offered (plain words, no paths). */
  detail?: string;
  /** Steps the marker records. */
  steps: number;
  /**
   * FR-736: the latest attempt to undo it was not complete: its state, and what kept each path from being undone with
   * the library-relative path (R503 d: shown in this list only, for the researcher to find the file).
   */
  rollback?: IncompleteRollback;
  causes?: UndoCause[];
  /** R509: it can be closed as it is (its undo can never complete); `lost` says what closing leaves lost. */
  canClose: boolean;
  /** Each path whose original cannot be put back: what stands there now, and the source it belongs to when known. */
  lost?: Array<{ path: string; now: "nothing" | "a file" | "something else"; sourceId?: string }>;
}

/** The choices a marker allows (R131 a, b): none for an invalid or unverifiable marker. */
function allowed(i: MarkerInspection): PendingWriteChoice[] {
  if (i.status !== "committed" && i.status !== "uncommitted") return [];
  const natural: PendingWriteChoice = i.status === "committed" ? "keep" : "roll-back";
  // A recorded choice can only be completed, never changed.
  const recorded = i.marker?.resolve?.choice;
  return recorded === undefined || recorded === natural ? [natural] : [];
}

async function anchorsOf(core: RepoCore): Promise<(projectId: string) => Head | undefined> {
  const all = await core.anchors.readAll().catch(() => ({}) as Record<string, Head>);
  return (pid) => (all as Record<string, Head>)[core.anchorKey(pid)];
}

const NO_CHOICE =
  "The app cannot confirm whether this change was finished, so it will change nothing itself. Restoring the project from a backup made before the change is the safe way on.";

async function view(core: RepoCore, i: MarkerInspection, writable: boolean): Promise<PendingWrite> {
  const a = writable ? allowed(i) : [];
  const detail = !writable
    ? `${i.detail ? `${i.detail}; ` : ""}this library is open read-only here, so nothing can be resolved (the change may still be in progress on the computer that has the library open)`
    : i.status === "unverifiable"
      ? `${i.detail ? `${i.detail}. ` : ""}${NO_CHOICE}`
      : i.detail;
  return {
    txn: i.txn,
    projectId: i.projectId,
    status: i.status,
    canKeep: a.includes("keep"),
    canRollBack: a.includes("roll-back"),
    ...(detail ? { detail } : {}),
    steps: i.marker?.entries.length ?? 0,
    ...incompleteOf(core, i.txn),
    ...(await closeOf(core, i, writable)),
  };
}

/** R509: whether it can be closed as it is here, and what that leaves lost. */
async function closeOf(core: RepoCore, i: MarkerInspection, writable: boolean): Promise<Pick<PendingWrite, "canClose" | "lost">> {
  if (!writable || !closable(core, i)) return { canClose: false };
  const lost = await lostOf(core, i);
  return { canClose: !(await keptCopiesLeft(core, i.marker!)), lost };
}

/** FR-736: the state and causes of the latest incomplete attempt to undo `txn`, when there was one. */
function incompleteOf(core: RepoCore, txn: string): Pick<PendingWrite, "rollback" | "causes"> {
  const a = core.rollbackAttempts.get(txn);
  return a ? { rollback: incompleteRollbackOf(a.causes, a.stepFailed), causes: a.causes } : {};
}

/** Every unresolved interrupted change, with the choices it allows. Reads only (read-only libraries too, with no choices). */
export function pendingWrites(core: RepoCore): Promise<PendingWrite[]> {
  const writable = core.library.mode === "read-write";
  return core.serial(async () => {
    const out: PendingWrite[] = [];
    for (const i of await inspectMarkers(core.root, await anchorsOf(core))) out.push(await view(core, i, writable));
    return out;
  });
}

const folderOf = (rel: string) => posix.normalize(rel.replaceAll("\\", "/")).toLowerCase();

/** Whether any marker still names this project (by id or by folder). */
function namesProject(i: MarkerInspection, st: ProjectState): boolean {
  return i.projectId === st.project.id || (i.projectFolder !== undefined && folderOf(i.projectFolder) === folderOf(st.rel));
}

const TXN = /^[0-9a-f-]{36}$/;

function whyNot(i: MarkerInspection, choice: PendingWriteChoice): string {
  if (i.status === "invalid") return "Its record cannot be read safely, so nothing it names can be undone or kept.";
  if (i.status === "unverifiable") return `${i.detail ? `${i.detail[0]!.toUpperCase()}${i.detail.slice(1)}. ` : ""}${NO_CHOICE}`;
  if (i.marker?.resolve && i.marker.resolve.choice !== choice) return `The choice to ${i.marker.resolve.choice === "keep" ? "keep" : "roll back"} this change is already recorded; it can only be completed.`;
  return choice === "keep"
    ? "It was not completed, so keeping it would keep a half-written change; it can only be rolled back."
    : "It was completed (its audit record is complete), so it can only be kept.";
}

/**
 * Cuts an incomplete last line off the project's last audit segment (41a N1). While a marker holds
 * the project nothing else appends to its audit log, so such a line is a `txn.resolve` event torn by
 * an earlier attempt (or a line cut off before the marker, which is never a committed record
 * either, R28). Returns its size and hash, recorded in the `txn.resolve` event.
 */
async function trimTornAuditLine(core: RepoCore, projectFolder: string): Promise<{ bytes: number; sha256: string } | undefined> {
  const dir = core.abs(`${projectFolder}/audit`);
  const last = (await auditSegments(dir)).at(-1);
  if (!last) return undefined;
  const path = join(dir, last);
  await assertContained(core.abs(projectFolder), path);
  const found = await incompleteTail(path);
  if (!found) return undefined;
  await truncateDurable(path, found.keep);
  return { bytes: found.tail.length, sha256: createHash("sha256").update(found.tail).digest("hex") };
}

/**
 * Carries out a choice, durably (R131 c): records it in the marker, does it (repeatably), appends
 * the `txn.resolve` event through `audit`, then removes the marker. A recorded choice whose event is
 * already written only has its marker removed. Throws PendingWriteIncompleteError when a step failed
 * (the marker keeps the choice).
 */
async function carryOut(
  core: RepoCore,
  i: MarkerInspection,
  choice: PendingWriteChoice,
  audit: (details: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const m = i.marker!;
  if (!m.resolve) await recordResolve(core.root, m, { choice, status: i.status === "committed" ? "committed" : "uncommitted", at: core.clock().toISOString() });
  const rec = m.resolve!;
  if (!i.resolveAudited) {
    maybeCrash("before-changes");
    const undone = choice === "keep" ? { ok: await finishCommittedSteps(core.root, m), causes: [] } : await undoEntries(core.root, m.entries);
    if (!undone.ok) {
      // FR-736: the answer says the state of the undo; the list says what is in the way, from this attempt.
      const attempt = { causes: undone.causes, stepFailed: "stepFailed" in undone && undone.stepFailed === true };
      if (choice === "roll-back") core.rollbackAttempts.set(m.txn, attempt);
      throw new PendingWriteIncompleteError(
        m.txn,
        choice === "keep"
          ? "The change could not be finished: files it destroyed could not be overwritten yet. The choice is recorded; try again, or reopen the library."
          : ROLLBACK_INCOMPLETE_ANSWER[incompleteRollbackOf(attempt.causes, attempt.stepFailed)],
        undone.causes,
      );
    }
    core.rollbackAttempts.delete(m.txn);
    maybeCrash("before-audit");
    // A txn.resolve line torn by an earlier attempt would refuse every append after it (41a N1).
    const trimmed = await trimTornAuditLine(core, m.projectFolder);
    await audit({ txn: m.txn, choice, status: rec.status, steps: m.entries.length, ...(trimmed ? { trimmedIncompleteLine: trimmed } : {}) });
    maybeCrash("before-marker-delete");
  }
  await removeMarker(core.root, m);
}

export async function resolvePendingWrite(core: RepoCore, txn: string, choice: PendingWriteChoice): Promise<{ txn: string; choice: PendingWriteChoice; projectId: string }> {
  core.assertWritable();
  if (choice !== "roll-back" && choice !== "keep") throw new PendingWriteChoiceError(txn, [], 'The choice must be "roll-back" or "keep".');
  return core.serial(async () => {
    core.assertWritable();
    if (typeof txn !== "string" || !TXN.test(txn)) throw new NotFoundError("Interrupted change", String(txn));
    const present = (await inspectMarkers(core.root, () => undefined)).some((i) => i.txn === txn);
    if (!present) throw new NotFoundError("Interrupted change", txn);
    const anchorOf = await anchorsOf(core);
    const i = await inspectMarker(core.root, txn, anchorOf);
    const ok = allowed(i);
    if (!ok.includes(choice)) throw new PendingWriteChoiceError(txn, ok, whyNot(i, choice));
    const m = i.marker!;
    const st = core.projects.get(m.projectId);
    if (!st) throw new NotFoundError("Project", m.projectId);
    // Set inside the audit step (a closure), so declared without narrowing.
    let held = undefined as ReturnType<typeof checkAnchor> | undefined;
    await carryOut(core, i, choice, async (details) => {
      held = await appendResolve(core, st, anchorOf, details);
    });
    await afterResolved(core, st, txn, held);
    return { txn, choice, projectId: st.project.id };
  });
}

/**
 * The `txn.resolve` event in the project's log, once the change is resolved on disk: what is in memory was read with
 * the change half there, so the project is read again from disk first (its sources, data and audit log, which a
 * rollback truncates back to the change's start). Returns the anchor problem that holds the anchor (R131 d), if any.
 */
async function appendResolve(
  core: RepoCore,
  st: ProjectState,
  anchorOf: (projectId: string) => Head | undefined,
  details: Record<string, unknown>,
  decision?: { result: "allow" },
): Promise<ReturnType<typeof checkAnchor> | undefined> {
  const fresh = await loadProjectFolder(core, st.rel.slice("Projects/".length));
  if (fresh) Object.assign(st, { project: fresh.st.project, data: fresh.st.data, audit: fresh.st.audit, sources: fresh.st.sources, manifest: fresh.st.manifest });
  const events = fresh?.events ?? (await AuditStore.read(st.audit.dir));
  const problem = checkAnchor(events, verifyChain(events as AuditEvent[]), anchorOf(st.project.id), core.device);
  const at = core.clock().toISOString();
  await st.audit.append({ ...core.auditBase(st, at), action: "txn.resolve", entity: { type: "project", id: st.project.id }, ...(decision ? { decision } : {}), details });
  // Never past a mismatch (R131 d): the next open records it first, then anchors again.
  if (problem) return problem;
  await core.updateAnchor(st, at);
  return undefined;
}

/** After a change is resolved (or closed): its warnings are settled, and writes resume unless something else holds the project. */
async function afterResolved(core: RepoCore, st: ProjectState, txn: string, held: ReturnType<typeof checkAnchor> | undefined): Promise<void> {
  core.rollbackAttempts.delete(txn);
  // Its warnings are settled.
  for (let k = core.integrityWarnings.length - 1; k >= 0; k--) if (core.integrityWarnings[k]!.detail.includes(`transaction ${txn}`)) core.integrityWarnings.splice(k, 1);
  // An incomplete line the rollback removed no longer holds the project (M1).
  const stillIncomplete = new Set((await scanIncompleteLines(core.root, st.rel, false)).map((l) => l.file));
  for (let k = core.integrityWarnings.length - 1; k >= 0; k--) {
    const w = core.integrityWarnings[k]!;
    if (w.projectId === st.project.id && w.kind === "incomplete-audit-line-pending" && w.file !== undefined && !stillIncomplete.has(w.file)) core.integrityWarnings.splice(k, 1);
  }
  if (held) {
    core.integrityWarnings.push({
      projectId: st.project.id,
      kind: held.kind,
      detail: `${held.detail}; the interrupted change was resolved, and this project takes changes again once the library is reopened, which records this first`,
    });
  }
  // Writes resume unless something else still holds the project.
  const left = (await inspectMarkers(core.root, () => undefined)).filter((x) => namesProject(x, st));
  const others = left.length > 0;
  // Only what the markers still pending name stays half changed; the rest is said no more (R473 I1).
  st.unfinished = new Set(left.flatMap((x) => (x.marker ? markerPaths(x.marker) : [])));
  for (let k = core.integrityWarnings.length - 1; k >= 0; k--) {
    const w = core.integrityWarnings[k]!;
    const folder = w.file;
    if (w.projectId === st.project.id && w.kind.startsWith("source-change-unfinished") && folder !== undefined && ![...st.unfinished].some((p) => p === folder || p.startsWith(`${folder}/`))) {
      core.integrityWarnings.splice(k, 1);
    }
  }
  const otherBlocks = core.integrityWarnings.some(
    (w) => w.projectId === st.project.id && (w.kind === "incomplete-audit-line-pending" || w.kind === "audit-append-failed-at-open"),
  );
  if (!others && !otherBlocks && !held) st.recoveryPending = false;
}

/** R509: why a change cannot be closed as it is (plain words). */
const NOT_CLOSABLE = "Only a change that can never be undone completely can be closed as it is; this one can still be rolled back.";
const COPIES_LEFT =
  "This change cannot be closed yet: the app still keeps a copy of a file it could not put back, and closing would let that copy go. Choose “Roll it back” to try again.";

/**
 * Whether the app still keeps a copy of something of this change that is not back in its place: a trash copy, or a
 * backup of a replaced file whose bytes are not at its path. Closing removes the marker, after which such a copy is
 * swept: closing must delete nothing (R509), so it waits.
 */
async function keptCopiesLeft(core: RepoCore, m: TxnMarker): Promise<boolean> {
  for (const e of m.entries) {
    if (e.kind === "trashed" && (await exists(fromRel(core.root, e.to)))) return true;
    if (e.kind === "replaced") {
      const backup = await readMaybe(fromRel(core.root, e.backup));
      if (backup === null) continue;
      const now = await readMaybe(fromRel(core.root, e.path)).catch(() => null);
      if (now === null || !now.equals(backup)) return true;
    }
  }
  return false;
}

/**
 * R509: whether the list offers to close this change as it is: an uncommitted change (no other choice recorded) whose
 * latest undo was incomplete ONLY for causes that can never pass (the kept copy of a removed file is gone).
 */
function closable(core: RepoCore, i: MarkerInspection): boolean {
  if (i.status !== "uncommitted" || i.resolveAudited || !i.marker) return false;
  if (i.marker.resolve && i.marker.resolve.choice !== "roll-back") return false;
  const a = core.rollbackAttempts.get(i.txn);
  return !!a && incompleteRollbackOf(a.causes, a.stepFailed) === "lost";
}

/** What closing would leave as lost: each path whose original cannot be put back, what is there now, and its source. */
async function lostOf(core: RepoCore, i: MarkerInspection): Promise<NonNullable<PendingWrite["lost"]>> {
  const st = core.projects.get(i.projectId);
  const out: NonNullable<PendingWrite["lost"]> = [];
  for (const c of core.rollbackAttempts.get(i.txn)?.causes ?? []) {
    if (c.kind !== "kept-copy-gone") continue;
    const s = await fsp.lstat(fromRel(core.root, c.path)).catch(() => null);
    const sourceId = st ? [...st.sources].find(([, f]) => c.path.startsWith(`${f}/`))?.[0] : undefined;
    out.push({ path: c.path, now: s === null ? "nothing" : s.isFile() ? "a file" : "something else", ...(sourceId ? { sourceId } : {}) });
  }
  return out;
}

/**
 * R509 (FR-736): closes, as it is, an interrupted change whose undo can never complete. Decided by the policy engine
 * against the project's rules (a refusal, which the project's log cannot take while the change holds it, is recorded
 * in the library's log); then, as the list's other choice does (R131 c): the choice is recorded in the marker first
 * (a roll-back, marked `close`, which an older build reads as a roll-back), the undo is run once more (repeatable) so
 * that everything of the change that CAN be undone is, the `txn.resolve` event is appended with what could not be put
 * back, and the marker goes. Nothing is deleted: what stands at each path stays, and a copy the app still keeps of
 * the change refuses the close. The project then takes changes again, and a warning says what was lost.
 */
export async function closePendingWrite(core: RepoCore, txn: string, projectId: string): Promise<{ txn: string; projectId: string }> {
  core.assertWritable();
  return core.serial(async () => {
    core.assertWritable();
    if (typeof txn !== "string" || !TXN.test(txn)) throw new NotFoundError("Interrupted change", String(txn));
    const present = (await inspectMarkers(core.root, () => undefined)).some((i) => i.txn === txn);
    if (!present) throw new NotFoundError("Interrupted change", txn);
    const anchorOf = await anchorsOf(core);
    const i = await inspectMarker(core.root, txn, anchorOf);
    // Named with the project the screen showed: never another project's change by a stale or wrong address.
    if (i.projectId !== projectId) throw new NotFoundError("Interrupted change", txn);
    if (!closable(core, i)) throw new PendingWriteChoiceError(txn, allowed(i), NOT_CLOSABLE);
    const m = i.marker!;
    const st = core.projects.get(m.projectId);
    if (!st) throw new NotFoundError("Project", m.projectId);
    if (await keptCopiesLeft(core, m)) throw new PendingWriteIncompleteError(txn, COPIES_LEFT);
    await decideClose(core, st, txn);
    if (!m.resolve?.close) await recordResolve(core.root, m, { choice: "roll-back", status: "uncommitted", at: core.clock().toISOString(), close: true });
    maybeCrash("before-changes");
    const undone = await undoEntries(core.root, m.entries);
    const attempt = { causes: undone.causes, stepFailed: undone.stepFailed === true };
    const state = undone.ok ? undefined : incompleteRollbackOf(attempt.causes, attempt.stepFailed);
    if (state !== undefined && state !== "lost") {
      core.rollbackAttempts.set(txn, attempt);
      throw new PendingWriteIncompleteError(txn, ROLLBACK_INCOMPLETE_ANSWER[state], undone.causes);
    }
    if (await keptCopiesLeft(core, m)) throw new PendingWriteIncompleteError(txn, COPIES_LEFT);
    const notPutBack = undone.causes.filter((c) => c.kind === "kept-copy-gone").map((c) => c.path);
    maybeCrash("before-audit");
    const trimmed = await trimTornAuditLine(core, m.projectFolder);
    const held = await appendResolve(
      core,
      st,
      anchorOf,
      { txn, choice: "close", status: "uncommitted", steps: m.entries.length, notPutBack, ...(trimmed ? { trimmedIncompleteLine: trimmed } : {}) },
      { result: "allow" },
    );
    maybeCrash("before-marker-delete");
    await removeMarker(core.root, m);
    await afterResolved(core, st, txn, held);
    // What was lost is said until the researcher dismisses it (FR-729); no path here (R503 d: the audit log names it).
    if (notPutBack.length) await keepWarning(core, { projectId: st.project.id, kind: "interrupted-change-closed", detail: "an interrupted change was closed as it was; a file it had removed could not be put back" });
    return { txn, projectId: st.project.id };
  });
}

/**
 * The policy engine's decision on closing (`close-change`), against the project's rules as written; a file that cannot
 * be read or parsed refuses (fail closed). A refusal is recorded in the library's audit log, since the project's own
 * log cannot take an entry while the interrupted change holds it (an entry after the change's start would make its
 * undo unverifiable), and thrown; nothing else is written.
 */
async function decideClose(core: RepoCore, st: ProjectState, txn: string): Promise<void> {
  const at = core.clock().toISOString();
  let decision: { result: "allow" } | { result: "deny"; reason: string };
  try {
    const raw = await readMaybe(core.abs(`${st.rel}/governance.yaml`));
    if (!raw) throw new Error("governance.yaml is missing");
    const d = evaluate(parseGovernance(raw.toString("utf8")), { action: "close-change", projectId: st.project.id, actor: core.actor, now: at, tz: core.zoneOf(st.project) });
    decision = d.result === "deny" ? { result: "deny", reason: d.reason } : { result: "allow" };
  } catch (e) {
    // Never the error's own message here: it can name an absolute path.
    decision = { result: "deny", reason: `Policy could not be evaluated (${e instanceof Error ? e.name : "error"})` };
  }
  if (decision.result === "allow") return;
  await appendLibraryAudit(core, {
    at,
    actor: core.actor,
    device: core.device,
    projectId: st.project.id,
    action: "close-change",
    entity: { type: "project", id: st.project.id },
    decision,
    details: { op: "txn.close", txn },
  });
  throw new PolicyDeniedError(decision.reason, "close-change");
}

/**
 * On a writable open, before automatic recovery (R131 c): completes every choice left recorded in a
 * marker by a crash or a failed audit append, auditing it in the project's log. The anchor is not
 * moved here; the open's usual check compares and moves it afterwards (recording any mismatch
 * first). A choice that cannot be completed stays recorded; recovery then reports it and its
 * project refuses changes.
 */
export async function completeRecordedResolves(core: RepoCore, anchorOf: (projectId: string) => Head | undefined): Promise<void> {
  for (const i of await inspectMarkers(core.root, anchorOf)) {
    const rec = i.marker?.resolve;
    if (!rec || !allowed(i).includes(rec.choice)) continue;
    const m = i.marker!;
    try {
      await carryOut(core, i, rec.choice, async (details) => {
        const { store } = await AuditStore.load(core.abs(`${m.projectFolder}/audit`), core.auditSegmentSize);
        const at = core.clock().toISOString();
        await store.append({ at, actor: core.actor, device: core.device, projectId: m.projectId, action: "txn.resolve", entity: { type: "project", id: m.projectId }, details });
      });
    } catch (err) {
      if (err instanceof SimulatedCrash) throw err;
      // Left recorded: reported by recovery, retried on the next open or by resolving again.
    }
  }
}
