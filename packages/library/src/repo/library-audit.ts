/**
 * The library's own audit log (`<Library>/audit/NNNN.jsonl`, hash-chained like a project's) for
 * decisions that have no project to hold them (Task 50): a refused project creation. The refusal
 * happens before the project, and so its audit log, exists; the library folder is the narrowest
 * place that survives a restart and travels with the library (a move copies it). Nothing secret is
 * recorded (never a passphrase) and no absolute path.
 *
 * Checked on every open: a chain that does not verify is reported (`chain-broken`, library-wide);
 * an incomplete last line left by a crash is trimmed and reported like a project's (R28). No
 * external anchor is kept for it (a known limit: a truncation of this log is not detected).
 */
import { join } from "node:path";
import { verifyChain, type AuditEvent, type AuditVerifyResult } from "@ao/core";
import { AuditStore, type AuditInput } from "./audit-store.js";
import type { RepoCore } from "./state.js";

export const LIBRARY_AUDIT_DIR = "audit";

/** Appends one event to the library's audit log (serialised by the caller's write queue). */
export async function appendLibraryAudit(core: RepoCore, input: AuditInput): Promise<void> {
  const { store } = await AuditStore.load(join(core.root, LIBRARY_AUDIT_DIR), core.auditSegmentSize);
  await store.append(input);
}

/** The library's audit events and whether their chain verifies (empty when there is no log). */
export async function readLibraryAudit(root: string): Promise<{ events: AuditEvent[]; verify: AuditVerifyResult }> {
  const events = await AuditStore.read(join(root, LIBRARY_AUDIT_DIR));
  return { events: events.filter((e): e is AuditEvent => e !== null), verify: verifyChain(events as AuditEvent[]) };
}
