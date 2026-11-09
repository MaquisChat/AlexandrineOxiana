import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";

export const GENESIS_HASH = "0".repeat(64);

export interface AuditEvent {
  /** 1-based position in the chain. */
  seq: number;
  at: string;
  actor: string;
  device: string;
  /**
   * Known values: PolicyAction values (defined in a later task), 'library.move',
   * 'library.reconnect', 'key.unlock', 'import.batch'. Typed as string for now.
   */
  action: string;
  entity?: { type: string; id: string };
  projectId?: string;
  decision?: {
    result: "allow" | "deny" | "allow_with_conditions";
    reason?: string;
    conditions?: unknown[];
  };
  details?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export type AuditBreakReason = "hash-mismatch" | "prev-mismatch" | "seq-gap";

export type AuditVerifyResult =
  | { ok: true; count: number; head: { seq: number; hash: string } | null }
  | { ok: false; brokenAt: number; reason: AuditBreakReason };

/** Throws unless `v` is JSON-representable without loss (so canonical form is faithful). */
function assertCanonicalizable(v: unknown, path: string): void {
  if (v === null || typeof v === "string" || typeof v === "boolean") return;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error(`audit event not canonicalizable: non-finite number at ${path}`);
    }
    return;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (!(i in v)) throw new Error(`audit event not canonicalizable: sparse array hole at ${path}[${i}]`);
      assertCanonicalizable(v[i], `${path}[${i}]`);
    }
    return;
  }
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`audit event not canonicalizable: non-plain object at ${path}`);
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      assertCanonicalizable(x, `${path}.${k}`);
    }
    return;
  }
  throw new Error(`audit event not canonicalizable: ${typeof v} at ${path}`);
}

function hashOf(eventWithoutHash: Omit<AuditEvent, "hash">): string {
  const json = canonicalize(eventWithoutHash);
  if (json === undefined) throw new Error("audit event not canonicalizable");
  return bytesToHex(sha256(utf8ToBytes(json)));
}

export function sealEvent(
  e: Omit<AuditEvent, "hash" | "prevHash" | "seq">,
  prev: { seq: number; hash: string } | null,
): AuditEvent {
  if (
    typeof e.at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(e.at) ||
    Number.isNaN(Date.parse(e.at))
  ) {
    throw new Error("audit event 'at' must be an ISO 8601 UTC timestamp");
  }
  // Drop top-level undefined optionals so the hash input matches what is stored.
  const base = Object.fromEntries(
    Object.entries(e).filter(([, v]) => v !== undefined),
  ) as Omit<AuditEvent, "hash" | "prevHash" | "seq">;
  const body: Omit<AuditEvent, "hash"> = {
    ...base,
    seq: prev ? prev.seq + 1 : 1,
    prevHash: prev ? prev.hash : GENESIS_HASH,
  };
  // Covers entity, decision (incl. conditions) and details.
  assertCanonicalizable(body, "event");
  return { ...body, hash: hashOf(body) };
}

/**
 * Single pass, constant memory: only the previous event's seq/hash are retained.
 *
 * LIMITATION: this proves internal consistency only. An attacker who rewrites
 * events from N to the tail and recomputes every hash, or who truncates the
 * tail, still gets `ok: true`. Callers must anchor `head` (seq + hash)
 * externally (later tasks record checkpoints) and compare it against the
 * returned `head` to detect tail rewrites and truncation.
 */
export function verifyChain(events: Iterable<AuditEvent>): AuditVerifyResult {
  let prev = null as { seq: number; hash: string } | null;
  let i = 0;
  for (const ev of events) {
    if (ev === null || typeof ev !== "object") {
      return { ok: false, brokenAt: i, reason: "hash-mismatch" };
    }
    const expectedPrev: string = prev ? prev.hash : GENESIS_HASH;
    const expectedSeq: number = prev ? prev.seq + 1 : 1;
    if (ev.prevHash !== expectedPrev) return { ok: false, brokenAt: i, reason: "prev-mismatch" };
    if (ev.seq !== expectedSeq) return { ok: false, brokenAt: i, reason: "seq-gap" };
    const { hash, ...rest } = ev;
    let actual: string;
    try {
      actual = hashOf(rest);
    } catch {
      return { ok: false, brokenAt: i, reason: "hash-mismatch" };
    }
    if (actual !== hash) return { ok: false, brokenAt: i, reason: "hash-mismatch" };
    prev = { seq: ev.seq, hash: ev.hash };
    i++;
  }
  return { ok: true, count: i, head: prev };
}
