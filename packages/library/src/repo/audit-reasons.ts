/**
 * Reasons the researcher types, and the audit log (R362 b, with R177 b).
 *
 * An encrypted project's audit log stays readable without its key (so its chain can be checked while it is locked).
 * A reason typed into such a project is therefore never written to an audit log as typed: the entry records that a
 * reason was given and a keyed digest of its text (`auditedReason`, defined here only): `reasonMac`, an HMAC-SHA-256
 * under a key derived from the project's data key for this purpose alone (R369 b), so that only who can unlock the
 * project can test a text against it. Entries written before R369 b carry R177 b's unkeyed `reasonSha256` instead; they
 * are read and checked by it as before. The text is kept sealed with the project:
 *  - "Reviewed after the withdrawal": in its sealed review entry (R177 b), as before;
 *  - every other reason an audit entry carries: in ONE sealed store of reasons, `<Project>/audit-reasons/reasons.jsonl`, one
 *    line per entry, sealed under the project key (purpose `ao-audit-reasons`), holding the entry's sequence number
 *    and hash, the keyed digest and the text. It is written in the same governed change as its entry, under the write-ahead
 *    marker (R26), before the entry: a crash before the entry leaves the marker uncommitted and the line is undone
 *    with it; after the entry, both stand (mutate.ts);
 *  - a mark set aside while the project's own log cannot take it is recorded in the LIBRARY's log (R154 d): its text
 *    is sealed under the project key in `<Library>/audit-reasons.jsonl` (sequence number and hash of the library's
 *    entry in the clear, the text sealed), written just before the entry; a line left without its entry by a crash
 *    can only be the last, and is removed at the next writable open (library-audit.ts).
 * A project that is not encrypted is unchanged: the reason is audited as typed. Encryption is chosen when a project is
 * made and never changes afterwards; entries written before this rule stay as they were (the log is append-only).
 */
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { REASON_SEALED_LOCKED, REASON_SEALED_MISMATCH, REASON_SEALED_MISSING, REASON_SEALED_UNREADABLE, type AuditReasonView } from "@ao/shared";
import type { AuditEvent } from "@ao/core";
import { openLine, readMaybe, sealLine } from "./io.js";
import { KEY_PURPOSE_AUDIT_REASON_MAC, PURPOSE_AUDIT_REASONS } from "./sealed-purposes.js";
import type { ProjectState, RepoCore } from "./state.js";

/** The project's sealed store of reasons (relative to the project folder). */
export const AUDIT_REASONS_FILE = "audit-reasons/reasons.jsonl";
/** The library's sealed store of reasons for its own log (relative to the library folder). */
export const LIBRARY_AUDIT_REASONS_FILE = "audit-reasons.jsonl";

/** The operations whose audit entry carries a reason the researcher typed. */
export const REASON_OPS: readonly string[] = ["attention.set-aside", "project.governance", "consent.document-detach", "review.withdrawal-reviewed"];

/** R177 b's unkeyed digest: only to read entries written before R369 b. */
export const reasonSha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * R369 b: the keyed digest of a reason: HMAC-SHA-256 of its exact text (UTF-8), hex, under a key derived from the
 * project's data key by HKDF-SHA-256 (no salt; info: KEY_PURPOSE_AUDIT_REASON_MAC) for this purpose alone, never the data
 * key itself. The derived key is wiped after use.
 */
export function reasonMac(projectKey: Uint8Array, text: string): string {
  const k = Buffer.from(hkdfSync("sha256", projectKey, Buffer.alloc(0), KEY_PURPOSE_AUDIT_REASON_MAC, 32));
  try {
    return createHmac("sha256", k).update(text, "utf8").digest("hex");
  } finally {
    k.fill(0);
  }
}

/** What an audit entry records of a reason the researcher typed: as typed (`projectKey` undefined: not encrypted), or that one was given and its keyed digest. */
export function auditedReason(projectKey: Uint8Array | undefined, reason: string): { reason: string } | { reasonGiven: true; reasonMac: string } {
  return projectKey ? { reasonGiven: true, reasonMac: reasonMac(projectKey, reason) } : { reason };
}

/** `auditedReason` for a project: keyed with its key when it is encrypted (throws when it is locked). */
export function auditedReasonIn(core: RepoCore, st: ProjectState, reason: string): { reason: string } | { reasonGiven: true; reasonMac: string } {
  return auditedReason(core.encrypted(st) ? core.key(st).key : undefined, reason);
}

/**
 * Whether `text` is the reason an entry's details record by digest: by its keyed digest (compared in constant time), or,
 * for an entry written before R369 b, by its SHA-256.
 */
export function reasonMatches(details: Record<string, unknown> | undefined, text: string, projectKey: Uint8Array): boolean {
  const recorded = typeof details?.reasonMac === "string" ? details.reasonMac : typeof details?.reasonSha256 === "string" ? details.reasonSha256 : undefined;
  if (recorded === undefined) return false;
  const got = Buffer.from(typeof details?.reasonMac === "string" ? reasonMac(projectKey, text) : reasonSha256(text), "utf8");
  const want = Buffer.from(recorded, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** One reason as it is kept sealed: the keyed digest its entry records (`reasonSha256` in lines written before R369 b). */
export interface SealedReason {
  seq: number;
  hash: string;
  reasonMac?: string;
  reasonSha256?: string;
  text: string;
}

/** One line of a project's store: the record sealed under the project key. */
export function sealedReasonLine(key: Uint8Array, keyId: string, projectId: string, r: SealedReason): string {
  const digest = r.reasonMac !== undefined ? { reasonMac: r.reasonMac } : { reasonSha256: r.reasonSha256 };
  return sealLine(key, keyId, projectId, JSON.stringify({ seq: r.seq, hash: r.hash, ...digest, text: r.text }), PURPOSE_AUDIT_REASONS);
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

/** True when the entry records a sealed reason: by its keyed digest (R369 b), or by its SHA-256 (R177 b's form, earlier entries). */
export function hasSealedReason(e: Pick<AuditEvent, "details">): boolean {
  return e.details?.reasonGiven === true && (typeof e.details.reasonMac === "string" || typeof e.details.reasonSha256 === "string");
}

/**
 * What the audit screen shows for an entry's reason, or undefined when it carries none:
 *  - a reason audited as typed (a project that is not encrypted, or an entry written before R362 b): the text;
 *  - a sealed reason: `sealed()` gives `locked` when the key is not available, `unreadable` when the place its text is
 *    kept could not be read (R369 d), else the project's key and the sealed text found for the entry (undefined when
 *    that place was read and holds none); the text is shown only when it matches the entry's digest (`reasonMatches`).
 */
export function reasonView(e: Pick<AuditEvent, "details">, sealed: () => "locked" | "unreadable" | { key: Uint8Array; text: string | undefined }): AuditReasonView | undefined {
  const d = e.details;
  if (!d || typeof d.op !== "string" || !REASON_OPS.includes(d.op)) return undefined;
  if (hasSealedReason(e)) {
    const t = sealed();
    if (t === "locked") return { state: "locked", message: REASON_SEALED_LOCKED };
    if (t === "unreadable") return { state: "unreadable", message: REASON_SEALED_UNREADABLE };
    if (t.text === undefined) return { state: "missing", message: REASON_SEALED_MISSING };
    if (!reasonMatches(d, t.text, t.key)) return { state: "mismatch", message: REASON_SEALED_MISMATCH };
    return { state: "text", text: t.text };
  }
  return typeof d.reason === "string" ? { state: "text", text: d.reason } : undefined;
}

export const reasonKey = at;
