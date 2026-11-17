/**
 * Reasons the researcher types, and the audit log (R362 b, with R177 b).
 *
 * An encrypted project's audit log stays readable without its key (so its chain can be checked while it is locked).
 * A reason typed into such a project is therefore never written to an audit log as typed: the entry records that a
 * reason was given and the SHA-256 of its text (`auditedReason`, R177 b's form, defined here only), and the text is
 * kept sealed with the project:
 *  - "Reviewed after the withdrawal": in its sealed review entry (R177 b), as before;
 *  - every other reason an audit entry carries: in ONE sealed store of reasons, `<Project>/audit-reasons/reasons.jsonl`, one
 *    line per entry, sealed under the project key (purpose `ao-audit-reasons`), holding the entry's sequence number
 *    and hash, the SHA-256 and the text. It is written in the same governed change as its entry, under the write-ahead
 *    marker (R26), before the entry: a crash before the entry leaves the marker uncommitted and the line is undone
 *    with it; after the entry, both stand (mutate.ts);
 *  - a mark set aside while the project's own log cannot take it is recorded in the LIBRARY's log (R154 d): its text
 *    is sealed under the project key in `<Library>/audit-reasons.jsonl` (sequence number and hash of the library's
 *    entry in the clear, the text sealed), written just before the entry; a line left without its entry by a crash
 *    can only be the last, and is removed at the next writable open (library-audit.ts).
 * A project that is not encrypted is unchanged: the reason is audited as typed. Encryption is chosen when a project is
 * made and never changes afterwards; entries written before this rule stay as they were (the log is append-only).
 */
import { createHash } from "node:crypto";
import { REASON_SEALED_LOCKED, REASON_SEALED_MISMATCH, REASON_SEALED_MISSING, type AuditReasonView } from "@ao/shared";
import type { AuditEvent } from "@ao/core";
import { openLine, readMaybe, sealLine } from "./io.js";
import { PURPOSE_AUDIT_REASONS } from "./sealed-purposes.js";

/** The project's sealed store of reasons (relative to the project folder). */
export const AUDIT_REASONS_FILE = "audit-reasons/reasons.jsonl";
/** The library's sealed store of reasons for its own log (relative to the library folder). */
export const LIBRARY_AUDIT_REASONS_FILE = "audit-reasons.jsonl";

/** The operations whose audit entry carries a reason the researcher typed. */
export const REASON_OPS: readonly string[] = ["attention.set-aside", "project.governance", "consent.document-detach", "review.withdrawal-reviewed"];

export const reasonSha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** What an audit entry records of a reason the researcher typed (R177 b's form, for every reason, R362 b). */
export function auditedReason(encrypted: boolean, reason: string): { reason: string } | { reasonGiven: true; reasonSha256: string } {
  return encrypted ? { reasonGiven: true, reasonSha256: reasonSha256(reason) } : { reason };
}

/** One reason as it is kept sealed. */
export interface SealedReason {
  seq: number;
  hash: string;
  reasonSha256: string;
  text: string;
}

/** One line of a project's store: the record sealed under the project key. */
export function sealedReasonLine(key: Uint8Array, keyId: string, projectId: string, r: SealedReason): string {
  return sealLine(key, keyId, projectId, JSON.stringify({ seq: r.seq, hash: r.hash, reasonSha256: r.reasonSha256, text: r.text }), PURPOSE_AUDIT_REASONS);
}

/** One line of the library's store: which entry, in the clear (so an orphan can be found without a key), and the record sealed. */
export function libraryReasonLine(key: Uint8Array, keyId: string, projectId: string, r: SealedReason): string {
  return JSON.stringify({ seq: r.seq, hash: r.hash, projectId, sealed: sealedReasonLine(key, keyId, projectId, r) });
}

const at = (seq: number, hash: string) => `${seq}:${hash}`;

/** The project store's records that open with `key`, by `seq:hash` (lines that do not open are skipped). */
export async function readProjectReasons(path: string, key: Uint8Array, projectId: string): Promise<Map<string, SealedReason>> {
  const out = new Map<string, SealedReason>();
  const raw = await readMaybe(path);
  if (!raw) return out;
  for (const line of raw.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(openLine(key, projectId, line, PURPOSE_AUDIT_REASONS)) as SealedReason;
      out.set(at(r.seq, r.hash), r);
    } catch {
      // damaged, or not this project's: as if absent
    }
  }
  return out;
}

/** The library store's lines as written: which entry and project, and the sealed record. */
export async function readLibraryReasonLines(path: string): Promise<Array<{ seq: number; hash: string; projectId: string; sealed: string }>> {
  const raw = await readMaybe(path);
  if (!raw) return [];
  const out: Array<{ seq: number; hash: string; projectId: string; sealed: string }> = [];
  for (const line of raw.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as { seq: unknown; hash: unknown; projectId: unknown; sealed: unknown };
      if (typeof o.seq === "number" && typeof o.hash === "string" && typeof o.projectId === "string" && typeof o.sealed === "string") out.push(o as { seq: number; hash: string; projectId: string; sealed: string });
    } catch {
      // an incomplete last line: trimmed at the next writable open
    }
  }
  return out;
}

/** Opens one sealed record of the library's store, or undefined. */
export function openLibraryReason(sealed: string, key: Uint8Array, projectId: string): SealedReason | undefined {
  try {
    return JSON.parse(openLine(key, projectId, sealed, PURPOSE_AUDIT_REASONS)) as SealedReason;
  } catch {
    return undefined;
  }
}

/** True when the entry records a sealed reason (R177 b's form). */
export function hasSealedReason(e: Pick<AuditEvent, "details">): boolean {
  return e.details?.reasonGiven === true && typeof e.details.reasonSha256 === "string";
}

/**
 * What the audit screen shows for an entry's reason, or undefined when it carries none:
 *  - a reason audited as typed (a project that is not encrypted, or an entry written before R362 b): the text;
 *  - a sealed reason: `text(entry)` gives the sealed text found for it (`locked` when the key is not available,
 *    undefined when it is not there); it is shown only when its SHA-256 is the entry's.
 */
export function reasonView(e: Pick<AuditEvent, "details">, sealedText: () => string | undefined | "locked"): AuditReasonView | undefined {
  const d = e.details;
  if (!d || typeof d.op !== "string" || !REASON_OPS.includes(d.op)) return undefined;
  if (hasSealedReason(e)) {
    const t = sealedText();
    if (t === "locked") return { state: "locked", message: REASON_SEALED_LOCKED };
    if (t === undefined) return { state: "missing", message: REASON_SEALED_MISSING };
    if (reasonSha256(t) !== d.reasonSha256) return { state: "mismatch", message: REASON_SEALED_MISMATCH };
    return { state: "text", text: t };
  }
  return typeof d.reason === "string" ? { state: "text", text: d.reason } : undefined;
}

export const reasonKey = at;
