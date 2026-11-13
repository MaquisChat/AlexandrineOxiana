/**
 * The review queue's file record (R31): `<Project>/review/pending.jsonl`, one entry per line,
 * append-only. A later line with the same id supersedes an earlier one (e.g. `status: resolved`).
 * In encrypted projects every line is sealed with the project key (like the change log), so field
 * reasons, which quote titles and names, never sit in plaintext. The index's `review_items` table
 * is a cache of this file; for encrypted projects it holds only field names and statuses.
 */
import { createHash } from "node:crypto";
import { REQUIRED_FIELDS, newId } from "@ao/core";
import { openLine, readMaybe, sealLine } from "./io.js";
import { InvalidInputError, NotFoundError, ReviewEntryDecidedError } from "./errors.js";
import { CHANGE_LOG_MODE, runMutation, type Tx } from "./mutate.js";
import type { ProjectState, RepoCore } from "./state.js";

export const REVIEW_FILE = "review/pending.jsonl";
const PURPOSE = "ao-review";

/**
 * What queued a verification entry (R176 3): a capture whose fields conflict, or a consent
 * withdrawal (the withdrawn consent records it reaches). Import entries need none: their kind says it.
 */
export type ReviewCause =
  /** `foundBy: "later-check"`: the conflict arose when a later check added data to an existing source (R190). */
  | { kind: "capture-conflict"; foundBy?: "later-check" }
  | { kind: "consent-withdrawal"; consentIds: string[] };

export interface ReviewEntry {
  id: string;
  projectId: string;
  sourceId?: string;
  kind: "verification" | "import";
  status: "pending" | "resolved";
  createdAt: string;
  /** JSON pointer → verification status of each field that needs review. */
  fields: Record<string, string>;
  /** Plain-language reasons (may quote titles and names). */
  reasons: string[];
  /** Import items: the identification confidence the resolution reached. */
  confidence?: number;
  /** Import items: the identification method (`Evidence.method`). */
  method?: string;
  /** Import items: up to 3 candidate matches from lookups (may quote titles and names). */
  candidates?: unknown[];
  /** Import items: an existing source this one may duplicate. */
  duplicateOf?: { sourceId: string; reason: string };
  /** Import items: identifiers found in the file that no lookup confirmed (e.g. "doi:10.1/x"). */
  hints?: string[];
  /** Import items: the import batch that queued it (Bulk Import). */
  batchId?: string;
  /** Verification entries queued since R176: what queued it (older entries: see reviewCauseOf). */
  cause?: ReviewCause;
  /**
   * Resolved entries: when, and the decision taken: an import decision ("accept", "skip", "merge",
   * …, "undone"), "confirmed" or "rechecked" (a capture's conflict, R176 1),
   * "reviewed-after-withdrawal" (R176 2), "source-removed" (R176 4).
   */
  resolvedAt?: string;
  decision?: string;
  /** "reviewed-after-withdrawal": the researcher's reason, as typed. */
  reason?: string;
}

/**
 * The cause of a verification entry (R176 3), the one place it is inferred: a recorded cause wins;
 * an entry queued before causes were recorded is a capture's when it lists fields (captures queue
 * their conflicting or unverified fields) and a consent withdrawal's when it lists none (withdrawals
 * queue no fields; which consent is then unknown). Import entries have no cause.
 */
export function reviewCauseOf(e: Pick<ReviewEntry, "kind" | "fields" | "cause">): ReviewCause | undefined {
  if (e.kind !== "verification") return undefined;
  if (e.cause) return e.cause;
  return Object.keys(e.fields ?? {}).length > 0 ? { kind: "capture-conflict" } : { kind: "consent-withdrawal", consentIds: [] };
}

/**
 * A field a capture's entry lists holds it open only while the present report has it in conflict or
 * unverified (coordinator's ruling 1, fix round 1): a field that has left the report (the type
 * changed, the field was removed, a recheck no longer reports it) is settled.
 */
const UNSETTLED = new Set(["conflict", "unverified"]);

type Reported = { source: { id: string }; verification: Record<string, { status: string }> };

/** Whether `e` is a pending capture entry of `sf` none of whose listed fields is left unsettled in `sf`'s report. */
function settledBy(e: ReviewEntry, sf: Reported): boolean {
  if (e.status !== "pending" || e.sourceId !== sf.source.id || reviewCauseOf(e)?.kind !== "capture-conflict") return false;
  return Object.keys(e.fields ?? {}).every((f) => !UNSETTLED.has(sf.verification[f]?.status ?? ""));
}

/** What re-examined a source's capture entries, and the decision a resolved entry records. */
export type ReexaminedBy = "confirmation" | "recheck" | "edit";
const DECISION: Record<ReexaminedBy, string> = { confirmation: "confirmed", recheck: "rechecked", edit: "edited" };

/**
 * Inside a running mutation that has just written `sf` with a new report (a confirm, a recheck, an
 * edit that recomputed the report, an import decision that rewrote it; R176 1): every pending
 * capture-conflict entry of the source none of whose listed fields is left in conflict or unverified
 * gets its `resolved` line in the same change. Returns the ids resolved.
 */
export async function resolveSettledCaptureEntries(core: RepoCore, tx: Tx, sf: Reported, by: ReexaminedBy): Promise<string[]> {
  const done: string[] = [];
  for (const e of await readReviewEntries(core, tx.state)) {
    if (!settledBy(e, sf)) continue;
    await writeReviewLine(core, tx, { ...e, status: "resolved", resolvedAt: tx.at, decision: DECISION[by] });
    done.push(e.id);
  }
  return done;
}

type Rechecked = { source: { id: string }; verification: Record<string, { status: string; reason?: string }> };

/** What one change queued in one entry: the audit's `reviewQueued` items. */
export type QueuedConflicts = { entry: string; fields: string[] };

/** The pending capture-conflict entries of a source (only these hold a conflicting field open, R193 a). */
const pendingCaptureEntries = (entries: ReviewEntry[], sourceId: string) =>
  entries.filter((e) => e.status === "pending" && e.sourceId === sourceId && reviewCauseOf(e)?.kind === "capture-conflict");

/** The fields of `sf` in conflict that no pending capture-conflict entry lists as in conflict. */
function unlistedConflicts(entries: ReviewEntry[], sf: Rechecked): string[] {
  const listed = new Set(
    pendingCaptureEntries(entries, sf.source.id).flatMap((e) =>
      Object.entries(e.fields ?? {})
        .filter(([, st]) => st === "conflict")
        .map(([f]) => f),
    ),
  );
  return Object.keys(sf.verification).filter((f) => sf.verification[f]!.status === "conflict" && !listed.has(f));
}

/** Without writing: whether a recheck must queue a conflict (R193 b), so a recheck that changes no verification still runs. */
export async function hasUnlistedConflicts(core: RepoCore, st: ProjectState, sf: Rechecked): Promise<boolean> {
  return unlistedConflicts(await readReviewEntries(core, st), sf).length > 0;
}

/**
 * The invariant of R193 (b), inside a running mutation that has just written `after` with its
 * verification report: every field of the source in conflict is listed, as in conflict, in a pending
 * capture-conflict entry of the source. (A field the researcher confirmed is user-confirmed, never in
 * conflict, so it raises nothing.) Only capture-conflict entries count (R193 a): an import entry that
 * lists the field is settled by its decision, which says nothing about the conflict. A field a
 * capture entry lists with another status ("unverified") is relisted as in conflict in that entry
 * (review M1); any other goes into the source's pending capture-conflict entry (one per source), or,
 * when there is none, into a new entry whose cause is recorded as a later check. This holds whether
 * the conflict is new or was already there with no entry (a source D19 left behind). Returns what was
 * written, per entry; empty when everything was already listed.
 */
export async function queueUnlistedConflicts(core: RepoCore, tx: Tx, after: Rechecked): Promise<QueuedConflicts[]> {
  const entries = await readReviewEntries(core, tx.state);
  const fields = unlistedConflicts(entries, after);
  if (fields.length === 0) return [];
  const reasonOf = (f: string) => after.verification[f]!.reason?.trim() || `A later check found conflicting values for ${f}.`;
  const captures = pendingCaptureEntries(entries, after.source.id);
  const byEntry = new Map<ReviewEntry, string[]>();
  const fresh: string[] = [];
  for (const f of fields) {
    const home = captures.find((e) => f in (e.fields ?? {})) ?? captures[0];
    if (home) byEntry.set(home, [...(byEntry.get(home) ?? []), f]);
    else fresh.push(f);
  }
  const out: QueuedConflicts[] = [];
  for (const [e, fs] of byEntry) {
    await writeReviewLine(core, tx, { ...e, fields: { ...e.fields, ...Object.fromEntries(fs.map((f) => [f, "conflict"])) }, reasons: [...e.reasons, ...fs.map(reasonOf)] });
    out.push({ entry: e.id, fields: fs });
  }
  if (fresh.length) {
    const e = await appendReviewEntry(core, tx, { sourceId: after.source.id, fields: Object.fromEntries(fresh.map((f) => [f, "conflict"])), reasons: fresh.map(reasonOf), cause: { kind: "capture-conflict", foundBy: "later-check" } });
    out.push({ entry: e.id, fields: fresh });
  }
  return out;
}

/** The value a JSON pointer names ("/identifiers/doi"). */
function valueAt(root: unknown, pointer: string): unknown {
  let cur: unknown = root;
  for (const part of pointer.split("/").slice(1)) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return cur;
}

const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

type Edited = { source: { id: string; type: string } & Record<string, unknown>; verification: Record<string, { status: string }> };

/**
 * After an ordinary edit (fix round 2, coordinator's ruling on I3): the edit NEVER rewrites the
 * stored report; it only re-examines the source's pending capture entries, in its own change. A
 * listed field counts as settled when
 *  - it is no longer a field of the source as edited: the edit emptied it (it had a value and now
 *    has none), or the type changed and the field has no value and is not one of the new type's
 *    fields (`REQUIRED_FIELDS[type]`, the verification's own list of a type's fields); or
 *  - the STORED report does not have it, or has it neither in conflict nor unverified.
 * A listed field still there and still in conflict or unverified in the stored report keeps the entry pending.
 */
export async function resolveCaptureEntriesAfterEdit(core: RepoCore, tx: Tx, before: Edited, after: Edited): Promise<string[]> {
  const typeChanged = before.source.type !== after.source.type;
  const fieldsOfType = new Set(REQUIRED_FIELDS[after.source.type as keyof typeof REQUIRED_FIELDS] ?? REQUIRED_FIELDS.other);
  const gone = (f: string) => {
    const now = valueAt(after.source, f);
    if (!blank(now)) return false;
    if (!blank(valueAt(before.source, f))) return true; // the edit emptied it
    return typeChanged && !fieldsOfType.has(f);
  };
  const done: string[] = [];
  for (const e of await readReviewEntries(core, tx.state)) {
    if (e.status !== "pending" || e.sourceId !== after.source.id || reviewCauseOf(e)?.kind !== "capture-conflict") continue;
    const open = Object.keys(e.fields ?? {}).some((f) => UNSETTLED.has(after.verification[f]?.status ?? "") && !gone(f));
    if (open) continue;
    await writeReviewLine(core, tx, { ...e, status: "resolved", resolvedAt: tx.at, decision: DECISION.edit });
    done.push(e.id);
  }
  return done;
}

/** Without writing: whether a recheck would resolve any of the source's capture entries (so a recheck that changes no verification still runs). */
export async function hasSettledCaptureEntries(core: RepoCore, st: ProjectState, sf: Reported): Promise<boolean> {
  return (await readReviewEntries(core, st)).some((e) => settledBy(e, sf));
}

/** The policy operation and audit op of "Reviewed after the withdrawal" (R176 2). */
export const WITHDRAWAL_REVIEWED_OP = "review.withdrawal-reviewed";
const REASON_MAX = 2000;

/**
 * "Reviewed after the withdrawal" (R176 2): the researcher's explicit decision on an entry a consent
 * withdrawal queued, with a reason in their own words (stored as typed). Its own policy operation
 * (`review-withdrawal`, allowed in every profile; the engine refuses a blank reason, and the refusal
 * is audited); one governed, audited, crash-safe change that writes only the entry's `resolved`
 * line — nothing else about the source changes. A locked project is refused before anything is read.
 */
export async function reviewedAfterWithdrawal(core: RepoCore, projectId: string, entryId: string, reason: string): Promise<ReviewEntry> {
  core.assertWritable();
  const st = core.state(projectId);
  core.assertUnlocked(st);
  if (typeof reason !== "string") throw new InvalidInputError("Give a reason, in your own words.");
  if (reason.length > REASON_MAX) throw new InvalidInputError(`Give a reason of up to ${REASON_MAX} characters.`);
  const find = async (s: ProjectState) => {
    const e = (await readReviewEntries(core, s)).find((x) => x.id === entryId);
    if (!e || !e.sourceId) throw new NotFoundError("Review entry", entryId);
    if (reviewCauseOf(e)?.kind !== "consent-withdrawal") throw new InvalidInputError("This is not an entry flagged by a consent withdrawal.");
    if (e.status !== "pending") throw new ReviewEntryDecidedError();
    return e;
  };
  const first = await find(st);
  return runMutation(
    core,
    projectId,
    { action: "review-withdrawal", reviewWithdrawal: { reason } },
    async (tx) => {
      // Read again inside the change: of two decisions at once, the second finds it decided.
      const e = await find(tx.state);
      const resolved: ReviewEntry = { ...e, status: "resolved", resolvedAt: tx.at, decision: "reviewed-after-withdrawal", reason };
      await writeReviewLine(core, tx, resolved);
      return resolved;
    },
    {
      op: WITHDRAWAL_REVIEWED_OP,
      entity: { type: "source", id: first.sourceId! },
      // In an encrypted project the reason's text stays in the sealed review line only: the audit log
      // (plain lines) records that a reason was given and its SHA-256 (coordinator's ruling 2, fix round 1).
      auditDetails: core.encrypted(st)
        ? { reviewEntry: entryId, reasonGiven: true, reasonSha256: createHash("sha256").update(reason, "utf8").digest("hex") }
        : { reviewEntry: entryId, reason },
    },
  );
}

/** The pending entries read once per change (a change that removes many sources reads the queue once). */
const pendingByTx = new WeakMap<Tx, ReviewEntry[]>();

/**
 * Inside the change that removes a source (R176 4): its pending entries are resolved
 * ("source-removed"), except `keep`, an entry the caller resolves itself in this change.
 */
export async function resolveEntriesOfRemovedSource(core: RepoCore, tx: Tx, sourceId: string, opts: { keep?: string; decision?: "source-removed" | "undone" } = {}): Promise<string[]> {
  let pending = pendingByTx.get(tx);
  if (!pending) {
    pending = (await readReviewEntries(core, tx.state)).filter((e) => e.status === "pending");
    pendingByTx.set(tx, pending);
  }
  const done: string[] = [];
  for (const e of pending) {
    if (e.sourceId !== sourceId || e.id === opts.keep) continue;
    await writeReviewLine(core, tx, { ...e, status: "resolved", resolvedAt: tx.at, decision: opts.decision ?? "source-removed" });
    done.push(e.id);
  }
  pendingByTx.set(
    tx,
    pending.filter((e) => !done.includes(e.id)),
  );
  return done;
}

/** What a caller queues; the entry's id, project, status and time are filled in. */
export interface ReviewInput {
  sourceId?: string;
  kind?: ReviewEntry["kind"];
  fields: Record<string, string>;
  reasons: string[];
  confidence?: number;
  method?: string;
  candidates?: unknown[];
  duplicateOf?: { sourceId: string; reason: string };
  hints?: string[];
  batchId?: string;
  cause?: ReviewCause;
}

/** A `review_items` row; `payload` is safe for the persistent index (nothing identifying when `encrypted`). */
export interface ReviewItemRow {
  id: string;
  projectId: string;
  sourceId?: string;
  batchId?: string;
  kind: ReviewEntry["kind"];
  status: ReviewEntry["status"];
  payload: Record<string, unknown>;
  createdAt: string;
}

export function reviewRow(e: ReviewEntry, encrypted: boolean): ReviewItemRow {
  const safe = {
    fields: e.fields,
    ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
    ...(e.method ? { method: e.method } : {}),
    ...(e.duplicateOf ? { duplicateOf: e.duplicateOf } : {}),
  };
  return {
    id: e.id,
    projectId: e.projectId,
    ...(e.sourceId ? { sourceId: e.sourceId } : {}),
    ...(e.batchId ? { batchId: e.batchId } : {}),
    kind: e.kind,
    status: e.status,
    payload: encrypted ? safe : { ...safe, reasons: e.reasons, ...(e.candidates ? { candidates: e.candidates } : {}), ...(e.hints ? { hints: e.hints } : {}) },
    createdAt: e.createdAt,
  };
}

/** Appends a new pending entry inside a running mutation and indexes it after commit. */
export async function appendReviewEntry(
  core: RepoCore,
  tx: Tx,
  input: ReviewInput,
): Promise<ReviewEntry> {
  const st = tx.state;
  const entry: ReviewEntry = {
    id: newId(),
    projectId: st.project.id,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    kind: input.kind ?? "verification",
    status: "pending",
    createdAt: tx.at,
    fields: input.fields,
    reasons: input.reasons,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.method ? { method: input.method } : {}),
    ...(input.candidates?.length ? { candidates: input.candidates } : {}),
    ...(input.duplicateOf ? { duplicateOf: input.duplicateOf } : {}),
    ...(input.hints?.length ? { hints: input.hints } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
    ...(input.cause ? { cause: input.cause } : {}),
  };
  await writeReviewLine(core, tx, entry);
  return entry;
}

/**
 * Appends a later version of an entry (same id) inside a running mutation, e.g. marking it
 * resolved with the decision taken; the newest line per id wins when the file is read.
 */
export async function appendReviewUpdate(core: RepoCore, tx: Tx, entry: ReviewEntry): Promise<void> {
  await writeReviewLine(core, tx, entry);
}

/** Every review entry of a project (newest version per id); sealed lines need the unlocked key. */
export async function readReviewEntries(core: RepoCore, st: ProjectState): Promise<ReviewEntry[]> {
  const raw = await readMaybe(core.abs(`${st.rel}/${REVIEW_FILE}`));
  if (!raw) return [];
  return parseReviewFile(raw.toString("utf8"), st.project.id, core.encrypted(st) ? core.key(st).key : null).entries;
}

async function writeReviewLine(core: RepoCore, tx: Tx, entry: ReviewEntry): Promise<void> {
  const st = tx.state;
  const json = JSON.stringify(entry);
  const encrypted = core.encrypted(st);
  if (encrypted) {
    const { key, keyId } = core.key(st);
    await tx.appendLine(`${st.rel}/${REVIEW_FILE}`, sealLine(key, keyId, st.project.id, json, PURPOSE));
  } else {
    await tx.appendLine(`${st.rel}/${REVIEW_FILE}`, json, { mode: CHANGE_LOG_MODE });
  }
  const row = reviewRow(entry, encrypted);
  tx.index((sink) => sink.indexReviewItem?.(row));
}

/**
 * Reads a review file's text: the newest entry per id. `key` opens sealed lines (encrypted
 * projects); unreadable lines are skipped and counted.
 */
export function parseReviewFile(text: string, projectId: string, key: Uint8Array | null): { entries: ReviewEntry[]; skipped: number } {
  const byId = new Map<string, ReviewEntry>();
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const json = key ? openLine(key, projectId, line, PURPOSE) : line;
      const e = JSON.parse(json) as ReviewEntry;
      if (typeof e?.id !== "string" || e.projectId !== projectId) throw new Error("not a review entry of this project");
      byId.set(e.id, e);
    } catch {
      skipped++;
    }
  }
  return { entries: [...byId.values()], skipped };
}
