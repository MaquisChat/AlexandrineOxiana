/**
 * The library's own audit log (`<Library>/audit/NNNN.jsonl`) for decisions that have no project to
 * hold them (Task 50, R154 a): a refused project creation, and marks set aside while a project's own
 * log is not intact (R154 d). The library folder is the narrowest place that survives a restart and
 * travels with the library (a move copies it). Nothing secret is recorded (never a passphrase) and no
 * absolute path.
 *
 * Protected exactly like a project's log: hash-chained, durably appended (a torn last line is
 * trimmed at the next writable open and the trim recorded here, R28), and anchored in the device's
 * anchors file under `<libraryId>/*`. Every open compares the log with its anchor (`checkAnchor`):
 * a broken chain, a different event at the anchored position, a log cut short, a missing or emptied
 * log this computer wrote to, are reported library-wide and, when writable, recorded here before the
 * log is anchored again (R82). The head is kept in memory, so an append does not read the log.
 *
 * Repeats (R154 a as amended, N6): the day's first refusal of a kind is a normal chained entry; an
 * identical refusal later that same UTC day is dropped, and the audit screen says, for a refusal,
 * that further identical ones that day are not listed. Nothing is counted outside the chain.
 * "Identical" means every field the entry shows is equal (action, actor, device, decision, and every
 * detail, `encrypted` included); anything that differs is a new entry.
 */
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { verifyChain, type AuditEvent, type AuditVerifyResult } from "@ao/core";
import { AuditStore, checkAnchor, type AuditInput, type Head } from "./audit-store.js";
import type { IncompleteLine } from "./incomplete-lines.js";
import type { RepoCore } from "./state.js";
import { LIBRARY_AUDIT_REASONS_FILE, libraryReasonLine, reasonMac } from "./audit-reasons.js";
import { appendDurable, assertContained, readMaybe, truncateDurable, undoAppend } from "./io.js";
import { SimulatedCrash, maybeCrash } from "./seams.js";

export const LIBRARY_AUDIT_DIR = "audit";

/** The anchor key of the library's log: `<libraryId>/*`. */
export const libraryAnchorKey = (core: RepoCore) => core.anchorKey("*");


const dirOf = (root: string) => join(root, LIBRARY_AUDIT_DIR);

async function store(core: RepoCore): Promise<AuditStore> {
  if (!core.libraryAudit) {
    const { store: s, events } = await AuditStore.load(dirOf(core.root), core.auditSegmentSize);
    core.libraryAudit = s;
    core.libraryAuditLast = [...events].reverse().find((e): e is AuditEvent => e !== null) ?? null;
    core.libraryAuditRecent = events.filter((e): e is AuditEvent => e !== null && e.at.slice(0, 10) === core.libraryAuditLast?.at.slice(0, 10));
  }
  return core.libraryAudit;
}

/** Appends one event and moves the anchor (serialised by the caller's write queue). */
export async function appendLibraryAudit(core: RepoCore, input: AuditInput): Promise<AuditEvent> {
  const s = await store(core);
  const { event } = await s.append(input);
  core.libraryAuditLast = event;
  const day = event.at.slice(0, 10);
  core.libraryAuditRecent = [...(core.libraryAuditRecent ?? []).filter((e) => e.at.slice(0, 10) === day), event];
  if (s.head) {
    try {
      await core.anchors.set(libraryAnchorKey(core), s.head, input.at);
    } catch {
      // advisory, as for a project: the next open compares again
    }
  }
  return event;
}

type Shown = Pick<AuditEvent, "at" | "actor" | "device" | "action" | "decision" | "details" | "projectId">;

/**
 * R362 b: appends an entry about an encrypted project whose details record a reason by its keyed digest only (R369 b), after
 * sealing the text under the project's key into `<Library>/audit-reasons.jsonl` (the entry's seq and hash in the
 * clear). The line is written first, durably: a crash before the entry leaves it as the store's last line, with a
 * seq past the log's head, and `trimOrphanReasons` removes it at the next writable open; after the entry, both stand.
 */
export async function appendLibraryAuditWithReason(core: RepoCore, input: AuditInput, k: { key: Uint8Array; keyId: string }, text: string): Promise<AuditEvent> {
  const s = await store(core);
  const d = input.details as Record<string, unknown> | undefined;
  const mac = d?.reasonMac;
  if (mac !== reasonMac(k.key, text) || d?.reason !== undefined || d?.reasonSha256 !== undefined || input.projectId === undefined) throw new Error("a sealed reason needs an audit entry that records only its keyed digest");
  const next = s.peek(input);
  const path = join(core.root, LIBRARY_AUDIT_REASONS_FILE);
  await assertContained(core.root, path);
  const u = await appendDurable(path, `${libraryReasonLine(k.key, k.keyId, input.projectId, { seq: next.seq, hash: next.hash, reasonMac: mac, text })}\n`, 0o600);
  try {
    maybeCrash("library-reason-before-entry");
    return await appendLibraryAudit(core, input);
  } catch (err) {
    // In-process failure: the line goes again (a crash leaves it for the next open).
    if (!(err instanceof SimulatedCrash)) await undoAppend(u).catch(() => {});
    throw err;
  }
}

/**
 * At a writable open (R362 b): a sealed reason left without its entry in the library's log by a crash (its seq past
 * the log's head, or its hash not the entry's at that seq), and a cut-off last line, are removed. Only the last lines
 * can be such: each line is written just before its entry, in the write queue.
 */
async function trimOrphanReasons(core: RepoCore, events: Array<AuditEvent | null>): Promise<void> {
  const path = join(core.root, LIBRARY_AUDIT_REASONS_FILE);
  const raw = await readMaybe(path);
  if (!raw) return;
  const text = raw.toString("utf8");
  let keep = text.length;
  for (;;) {
    const body = text.slice(0, keep);
    const end = body.endsWith("\n") ? body.length - 1 : body.length;
    if (end <= 0) break;
    const start = body.lastIndexOf("\n", end - 1) + 1;
    const line = body.slice(start, end);
    let ok = false;
    try {
      const o = JSON.parse(line) as { seq?: unknown; hash?: unknown };
      ok = body.endsWith("\n") && typeof o.seq === "number" && events[o.seq - 1]?.hash === o.hash;
    } catch {
      ok = false;
    }
    if (ok) break;
    keep = start;
  }
  if (keep < text.length) await truncateDurable(path, Buffer.byteLength(text.slice(0, keep), "utf8"));
}

/** The same refusal on the same UTC day: every field the entry shows is equal (N6). */
export function sameRefusal(a: Shown, b: Shown): boolean {
  return (
    a.at.slice(0, 10) === b.at.slice(0, 10) &&
    a.action === b.action &&
    a.actor === b.actor &&
    a.device === b.device &&
    a.projectId === b.projectId &&
    isDeepStrictEqual(a.decision ?? null, b.decision ?? null) &&
    isDeepStrictEqual(a.details ?? null, b.details ?? null)
  );
}

/** A refusal: appended, unless the same refusal is already recorded today (then dropped, N6). */
export async function appendLibraryRefusal(core: RepoCore, input: AuditInput): Promise<void> {
  await store(core);
  if ((core.libraryAuditRecent ?? []).some((e) => sameRefusal(e, input))) return;
  await appendLibraryAudit(core, input);
}

/**
 * The library's audit events, whether their chain verifies, and the repeat count of the latest
 * entry (only while it is still the latest).
 */
export async function readLibraryAudit(root: string): Promise<{ events: AuditEvent[]; verify: AuditVerifyResult }> {
  const all = await AuditStore.read(dirOf(root));
  return { events: all.filter((e): e is AuditEvent => e !== null), verify: verifyChain(all as AuditEvent[]) };
}

/**
 * At open: compares the log with its anchor, reports what is wrong library-wide and, when
 * writable, records it (and trims of the log's last line) in the log, then anchors it again.
 */
export async function checkLibraryAudit(core: RepoCore, anchor: Head | undefined, writable: boolean, trimmed: IncompleteLine[]): Promise<void> {
  const { store: s, events, verify } = await AuditStore.load(dirOf(core.root), core.auditSegmentSize);
  core.libraryAudit = s;
  core.libraryAuditLast = [...events].reverse().find((e): e is AuditEvent => e !== null) ?? null;
  core.libraryAuditRecent = events.filter((e): e is AuditEvent => e !== null && e.at.slice(0, 10) === core.libraryAuditLast?.at.slice(0, 10));
  // A library that never had a log, and that this computer never anchored, has nothing to compare.
  const problem = events.length === 0 && !anchor ? null : checkAnchor(events, verify, anchor, core.device);
  if (problem) core.integrityWarnings.push({ projectId: "*", kind: problem.kind, detail: `the library's audit log: ${problem.detail}` });
  if (!writable) return;
  // Only against a log whose chain verifies: otherwise its entries cannot say which reason is whose.
  if (verify.ok) await trimOrphanReasons(core, events).catch(() => {});
  const at = core.clock().toISOString();
  const base = { at, actor: core.actor, device: core.device };
  try {
    let appended = false;
    if (problem) {
      await appendLibraryAudit(core, {
        ...base,
        action: problem.kind === "anchor-missing" ? "audit.anchor-missing" : "audit.anchor-mismatch",
        details: { kind: problem.kind, detail: problem.detail, ...(anchor ? { recorded: { seq: anchor.seq, hash: anchor.hash } } : {}) },
      });
      appended = true;
    }
    if (verify.ok) {
      for (const l of trimmed) {
        await appendLibraryAudit(core, { ...base, action: "audit.trimmed-incomplete-line", details: { file: l.file, bytes: l.bytes, sha256: l.sha256 } });
        appended = true;
      }
    }
    if (!problem && !appended && s.head && (anchor?.seq !== s.head.seq || anchor.hash !== s.head.hash)) {
      await core.anchors.set(libraryAnchorKey(core), s.head, at).catch(() => {});
    }
  } catch (err) {
    core.integrityWarnings.push({
      projectId: "*",
      kind: "audit-append-failed-at-open",
      detail: `a check of the library's audit log could not be recorded (${err instanceof Error ? err.name : "Error"})`,
    });
  }
}
