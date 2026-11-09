import { describe, expect, it } from "vitest";
import { GENESIS_HASH, sealEvent, verifyChain } from "./audit.js";
import type { AuditEvent } from "./audit.js";

type Draft = Parameters<typeof sealEvent>[0];
const draft = (n: number, details?: Record<string, unknown>): Draft => ({
  at: `2026-01-01T00:00:0${n}.000Z`,
  actor: "u1",
  device: "d1",
  action: "library.move",
  ...(details ? { details } : {}),
});

function chain(n: number): AuditEvent[] {
  const out: AuditEvent[] = [];
  let prev: { seq: number; hash: string } | null = null;
  for (let i = 0; i < n; i++) {
    const e = sealEvent(draft(i, { i }), prev);
    out.push(e);
    prev = e;
  }
  return out;
}

describe("audit chain", () => {
  it("GENESIS_HASH is 64 zeros", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
  });

  it("seals first event with seq 1 and genesis prevHash", () => {
    const e = sealEvent(draft(0), null);
    expect(e.seq).toBe(1);
    expect(e.prevHash).toBe(GENESIS_HASH);
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a chain of 3", () => {
    const events = chain(3);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(verifyChain(events)).toEqual({ ok: true, count: 3, head: { seq: 3, hash: events[2]!.hash } });
  });

  it("verifies an empty iterable", () => {
    expect(verifyChain([])).toEqual({ ok: true, count: 0, head: null });
  });

  it("verifies a generator (single pass)", () => {
    const events = chain(3);
    function* gen() {
      yield* events;
    }
    expect(verifyChain(gen())).toEqual({ ok: true, count: 3, head: { seq: 3, hash: events[2]!.hash } });
  });

  it("detects tampered details", () => {
    const events = chain(3);
    events[1] = { ...events[1]!, details: { i: 99 } };
    expect(verifyChain(events)).toEqual({ ok: false, brokenAt: 1, reason: "hash-mismatch" });
  });

  it("detects a deleted event", () => {
    const events = chain(3);
    events.splice(1, 1);
    const r = verifyChain(events);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.brokenAt).toBe(1);
      expect(["prev-mismatch", "seq-gap"]).toContain(r.reason);
    }
  });

  it("detects a deleted first event (seq not 1)", () => {
    const events = chain(3).slice(1);
    const r = verifyChain(events);
    expect(r).toMatchObject({ ok: false, brokenAt: 0 });
  });

  it("rejects first event with non-genesis prevHash", () => {
    const e = sealEvent(draft(0), null);
    const forged = { ...e, prevHash: "a".repeat(64) };
    expect(verifyChain([forged])).toEqual({ ok: false, brokenAt: 0, reason: "prev-mismatch" });
  });

  it("rejects first event with seq != 1", () => {
    const e = sealEvent(draft(0), { seq: 4, hash: GENESIS_HASH });
    const forged = { ...e, prevHash: GENESIS_HASH };
    expect(verifyChain([forged])).toMatchObject({ ok: false, brokenAt: 0 });
  });

  it("detects seq gap with consistent prevHash", () => {
    const [a] = chain(1);
    const b = sealEvent(draft(1), { seq: 5, hash: a!.hash });
    expect(verifyChain([a!, b])).toEqual({ ok: false, brokenAt: 1, reason: "seq-gap" });
  });

  it("details key order does not change the hash", () => {
    const a = sealEvent(draft(0, { x: 1, y: { p: 1, q: 2 } }), null);
    const b = sealEvent(draft(0, { y: { q: 2, p: 1 }, x: 1 }), null);
    expect(a.hash).toBe(b.hash);
  });

  it("hash covers seq and prevHash", () => {
    const a = sealEvent(draft(0), null);
    const b = sealEvent(draft(0), { seq: 1, hash: "b".repeat(64) });
    expect(a.hash).not.toBe(b.hash);
  });

  it("rejects non-deterministic details", () => {
    for (const bad of [
      { a: [undefined] },
      { a: Number.NaN },
      { a: Number.POSITIVE_INFINITY },
      { a: { b: undefined } },
      { a: () => 1 },
      { a: 1n },
      { a: new Date() },
    ]) {
      expect(() => sealEvent(draft(0, bad as Record<string, unknown>), null)).toThrow(/details/);
    }
  });

  it("consistent tail rewrite passes but head differs; truncation changes count and head", () => {
    const orig = chain(3);
    const r0 = verifyChain(orig);
    const rewritten = [orig[0]!, sealEvent(draft(1, { i: "evil" }), orig[0]!)];
    rewritten.push(sealEvent(draft(2, { i: 2 }), rewritten[1]!));
    const r1 = verifyChain(rewritten);
    expect(r1.ok).toBe(true);
    if (r0.ok && r1.ok) {
      expect(r1.count).toBe(r0.count);
      expect(r1.head!.hash).not.toBe(r0.head!.hash);
    }
    const r2 = verifyChain(orig.slice(0, 2));
    expect(r2.ok).toBe(true);
    if (r0.ok && r2.ok) {
      expect(r2.count).toBeLessThan(r0.count);
      expect(r2.head!.hash).not.toBe(r0.head!.hash);
    }
  });

  it("rejects non-canonicalizable decision.conditions and entity values", () => {
    const d = (conditions: unknown[]): Draft => ({
      ...draft(0),
      decision: { result: "allow_with_conditions", conditions },
    });
    expect(() => sealEvent(d([undefined]), null)).toThrow();
    expect(() => sealEvent(d([Number.NaN]), null)).toThrow();
    expect(() => sealEvent({ ...draft(0), entity: { type: "t", id: undefined as never } }, null)).toThrow();
  });

  it("rejects non-ISO-UTC `at`", () => {
    for (const at of ["yesterday", "2026-01-01", "2026-01-01T00:00:00+02:00", "2026-13-40T00:00:00Z"]) {
      expect(() => sealEvent({ ...draft(0), at }, null)).toThrow(/at/);
    }
  });

  it("rejects sparse array holes", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(() => sealEvent(draft(0, { a: [1, , 3] }), null)).toThrow(/hole/);
  });

  it("verifyChain breaks (not throws) on null/non-object elements", () => {
    const [a] = chain(1);
    for (const bad of [null, undefined, 5, "x"]) {
      expect(verifyChain([a!, bad as never])).toEqual({ ok: false, brokenAt: 1, reason: "hash-mismatch" });
    }
    expect(verifyChain([null as never])).toMatchObject({ ok: false, brokenAt: 0 });
  });

  it("detects reordered pair", () => {
    const e = chain(3);
    const r = verifyChain([e[0]!, e[2]!, e[1]!]);
    expect(r).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it("detects duplicate seq", () => {
    const e = chain(3);
    const r = verifyChain([e[0]!, e[1]!, e[1]!]);
    expect(r).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it("detects stored-hash-only edit", () => {
    const e = chain(3);
    e[1] = { ...e[1]!, hash: "c".repeat(64) };
    expect(verifyChain(e)).toEqual({ ok: false, brokenAt: 1, reason: "hash-mismatch" });
  });
});
