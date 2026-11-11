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
 * Repeats (R154 a): a refusal identical to the latest entry (same action, operation, name, reason,
 * actor and device) on the same UTC day is not appended again; it is counted in `audit/repeats.json`
 * against that entry (`{seq, hash, count, lastAt}`), as the backup scheduler records one denial a day.
 */
import { join } from "node:path";
import { verifyChain, type AuditEvent, type AuditVerifyResult } from "@ao/core";
import { writeFileAtomic } from "../fs/atomic.js";
import { AuditStore, checkAnchor, type AuditInput, type Head } from "./audit-store.js";
import type { IncompleteLine } from "./incomplete-lines.js";
import { assertContained, readMaybe } from "./io.js";
import type { RepoCore } from "./state.js";

export const LIBRARY_AUDIT_DIR = "audit";
const REPEATS_FILE = "repeats.json";

/** The anchor key of the library's log: `<libraryId>/*`. */
export const libraryAnchorKey = (core: RepoCore) => core.anchorKey("*");

interface Repeats {
  seq: number;
  hash: string;
  count: number;
  lastAt: string;
}

const dirOf = (root: string) => join(root, LIBRARY_AUDIT_DIR);

async function store(core: RepoCore): Promise<AuditStore> {
  if (!core.libraryAudit) {
    const { store: s, events } = await AuditStore.load(dirOf(core.root), core.auditSegmentSize);
    core.libraryAudit = s;
    core.libraryAuditLast = [...events].reverse().find((e): e is AuditEvent => e !== null) ?? null;
  }
  return core.libraryAudit;
}

/** Appends one event and moves the anchor (serialised by the caller's write queue). */
export async function appendLibraryAudit(core: RepoCore, input: AuditInput): Promise<AuditEvent> {
  const s = await store(core);
  const { event } = await s.append(input);
  core.libraryAuditLast = event;
  if (s.head) {
    try {
      await core.anchors.set(libraryAnchorKey(core), s.head, input.at);
    } catch {
      // advisory, as for a project: the next open compares again
    }
  }
  return event;
}

const sameKind = (a: AuditEvent, b: AuditInput) =>
  a.action === b.action &&
  a.actor === b.actor &&
  a.device === b.device &&
  a.decision?.result === b.decision?.result &&
  a.decision?.reason === b.decision?.reason &&
  a.details?.op === b.details?.op &&
  a.details?.name === b.details?.name &&
  a.at.slice(0, 10) === b.at.slice(0, 10);

/** A refusal: appended, or counted against the latest entry when it repeats it the same day. */
export async function appendLibraryRefusal(core: RepoCore, input: AuditInput): Promise<void> {
  await store(core);
  const last = core.libraryAuditLast;
  if (last && sameKind(last, input)) {
    const file = join(dirOf(core.root), REPEATS_FILE);
    await assertContained(core.root, file);
    const prev = await readRepeats(core.root);
    const count = prev && prev.seq === last.seq && prev.hash === last.hash ? prev.count + 1 : 1;
    const body: Repeats = { seq: last.seq, hash: last.hash, count, lastAt: input.at };
    await writeFileAtomic(file, JSON.stringify(body), { mode: 0o600 });
    return;
  }
  await appendLibraryAudit(core, input);
}

async function readRepeats(root: string): Promise<Repeats | null> {
  try {
    const raw = await readMaybe(join(dirOf(root), REPEATS_FILE));
    const r = raw ? (JSON.parse(raw.toString("utf8")) as Partial<Repeats>) : null;
    if (!r || !Number.isSafeInteger(r.seq) || typeof r.hash !== "string" || !Number.isSafeInteger(r.count) || typeof r.lastAt !== "string") return null;
    return r as Repeats;
  } catch {
    return null;
  }
}

/**
 * The library's audit events, whether their chain verifies, and the repeat count of the latest
 * entry (only while it is still the latest).
 */
export async function readLibraryAudit(root: string): Promise<{ events: AuditEvent[]; verify: AuditVerifyResult; repeats?: Repeats }> {
  const all = await AuditStore.read(dirOf(root));
  const events = all.filter((e): e is AuditEvent => e !== null);
  const last = events.at(-1);
  const r = await readRepeats(root);
  return {
    events,
    verify: verifyChain(all as AuditEvent[]),
    ...(r && last && r.seq === last.seq && r.hash === last.hash ? { repeats: { seq: r.seq, count: r.count, lastAt: r.lastAt } as Repeats } : {}),
  };
}

/**
 * At open: compares the log with its anchor, reports what is wrong library-wide and, when
 * writable, records it (and trims of the log's last line) in the log, then anchors it again.
 */
export async function checkLibraryAudit(core: RepoCore, anchor: Head | undefined, writable: boolean, trimmed: IncompleteLine[]): Promise<void> {
  const { store: s, events, verify } = await AuditStore.load(dirOf(core.root), core.auditSegmentSize);
  core.libraryAudit = s;
  core.libraryAuditLast = [...events].reverse().find((e): e is AuditEvent => e !== null) ?? null;
  // A library that never had a log, and that this computer never anchored, has nothing to compare.
  const problem = events.length === 0 && !anchor ? null : checkAnchor(events, verify, anchor, core.device);
  if (problem) core.integrityWarnings.push({ projectId: "*", kind: problem.kind, detail: `the library's audit log: ${problem.detail}` });
  if (!writable) return;
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
