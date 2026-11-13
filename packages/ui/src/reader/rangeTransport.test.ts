// @vitest-environment node
/**
 * The range transport pdf.js reads a document through (Task R6): pdf.js asks for [begin, end) and
 * gets exactly those bytes, fetched by `fetchRange` (inclusive ends, as byteRange takes them) in as
 * many pieces as the service's 4 MiB cut makes; once aborted, nothing more is fetched or handed on.
 */
import { describe, expect, it, vi } from "vitest";
import { createRangeTransport, onRangeFailure } from "./rangeTransport";

const MiB = 1024 * 1024;
/** A file whose byte at offset i is i mod 251. */
function fileBytes(start: number, endInclusive: number): Uint8Array {
  const out = new Uint8Array(endInclusive - start + 1);
  for (let k = 0; k < out.length; k++) out[k] = (start + k) % 251;
  return out;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Listens like pdf.js's PDFDataTransportStream: every `range` the transport hands on. */
function listen(t: ReturnType<typeof createRangeTransport>) {
  const got: Array<{ begin: number; chunk: Uint8Array }> = [];
  t.transportReady((a: { type: string; begin: number; chunk: Uint8Array }) => {
    if (a.type === "range") got.push({ begin: a.begin, chunk: a.chunk });
  });
  return got;
}

describe("createRangeTransport", () => {
  it("requestDataRange answers with the bytes fetched for that range", async () => {
    const total = 10 * MiB + 7;
    const calls: Array<[number, number]> = [];
    // The service cuts every answer at 4 MiB (DOCUMENT_RANGE_MAX_BYTES).
    const fetchRange = vi.fn(async (start: number, end: number) => {
      calls.push([start, end]);
      return { bytes: fileBytes(start, Math.min(end, start + 4 * MiB - 1, total - 1)), total };
    });
    const first = { bytes: fileBytes(0, MiB - 1), total };
    const t = createRangeTransport(first, fetchRange);
    expect(t.length).toBe(total);
    expect(t.initialData).toBe(first.bytes);
    const got = listen(t);

    // One chunk: pdf.js's end is exclusive, byteRange's inclusive.
    t.requestDataRange(MiB, 2 * MiB);
    // Six chunks up to the end of the file, longer than one answer of the service.
    t.requestDataRange(4 * MiB, total);
    await vi.waitFor(() => expect(got).toHaveLength(2));

    expect(calls).toEqual([
      [MiB, 2 * MiB - 1],
      [4 * MiB, total - 1],
      [8 * MiB, total - 1],
    ]);
    const byBegin = new Map(got.map((g) => [g.begin, g.chunk]));
    // Compared as buffers: a deep equality over megabytes takes far too long.
    const same = (a: Uint8Array | undefined, b: Uint8Array) => a !== undefined && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b));
    expect(byBegin.get(MiB)?.length).toBe(MiB);
    expect(same(byBegin.get(MiB), fileBytes(MiB, 2 * MiB - 1))).toBe(true);
    expect(byBegin.get(4 * MiB)?.length).toBe(total - 4 * MiB);
    expect(same(byBegin.get(4 * MiB), fileBytes(4 * MiB, total - 1))).toBe(true);
  });

  it("an aborted signal stops further ranges", async () => {
    const total = 8 * MiB;
    // A range in flight when the transport is aborted (pdf.js aborts it when the document is destroyed).
    let release: (() => void) | undefined;
    const signals: AbortSignal[] = [];
    const fetchRange = vi.fn((start: number, end: number, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise<{ bytes: Uint8Array; total: number }>((resolve) => {
        release = () => resolve({ bytes: fileBytes(start, end), total });
      });
    });
    const t = createRangeTransport({ bytes: fileBytes(0, MiB - 1), total }, fetchRange);
    const got = listen(t);
    t.requestDataRange(MiB, 2 * MiB);
    await tick();
    expect(fetchRange).toHaveBeenCalledTimes(1);
    t.abort();
    // The fetch in flight is told to stop, and its answer, if it still comes, is not handed on.
    expect(signals[0]?.aborted).toBe(true);
    release!();
    await tick();
    t.requestDataRange(2 * MiB, 3 * MiB);
    await tick();
    expect(fetchRange).toHaveBeenCalledTimes(1);
    expect(got).toEqual([]);

    // The caller's own signal (leaving the reader): a fetch that fails with AbortError stops the
    // transport too; no further range is fetched and no failure is reported.
    const ac = new AbortController();
    const failures: unknown[] = [];
    const fetch2 = vi.fn(async (start: number, end: number) => {
      if (ac.signal.aborted) throw new DOMException("The range was no longer wanted.", "AbortError");
      return { bytes: fileBytes(start, end), total };
    });
    const t2 = createRangeTransport({ bytes: fileBytes(0, MiB - 1), total }, fetch2);
    onRangeFailure(t2, (e) => failures.push(e));
    const got2 = listen(t2);
    ac.abort();
    t2.requestDataRange(MiB, 2 * MiB);
    await tick();
    t2.requestDataRange(2 * MiB, 3 * MiB);
    await tick();
    expect(fetch2).toHaveBeenCalledTimes(1);
    expect(got2).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("a failed range is reported once, stops further ranges, and pdf.js is handed nothing at all", async () => {
    const failure = Object.assign(new Error("This project is locked."), { status: 423 });
    const fetchRange = vi.fn(async () => {
      throw failure;
    });
    const t = createRangeTransport({ bytes: fileBytes(0, MiB - 1), total: 4 * MiB }, fetchRange);
    const got = listen(t);
    const failures: unknown[] = [];
    const stop = onRangeFailure(t, (e) => failures.push(e));
    t.requestDataRange(MiB, 2 * MiB);
    await vi.waitFor(() => expect(failures).toEqual([failure]));
    t.requestDataRange(2 * MiB, 3 * MiB);
    await tick();
    // Nothing more is fetched, and pdf.js is never handed a byte that did not come from the file
    // (A7): neither for the range that failed nor for one asked for afterwards.
    expect(fetchRange).toHaveBeenCalledTimes(1);
    expect(got).toEqual([]);
    stop();
    // A listener added after the failure hears of it at once.
    const late: unknown[] = [];
    onRangeFailure(t, (e) => late.push(e));
    expect(late).toEqual([failure]);
  });

  it("an answer of the wrong length is a failure, never handed on as data", async () => {
    const fetchRange = vi.fn(async () => ({ bytes: new Uint8Array(0), total: 4 * MiB }));
    const t = createRangeTransport({ bytes: fileBytes(0, MiB - 1), total: 4 * MiB }, fetchRange);
    const got = listen(t);
    const failures: unknown[] = [];
    onRangeFailure(t, (e) => failures.push(e));
    t.requestDataRange(MiB, 2 * MiB);
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    await tick();
    expect(got).toEqual([]);
  });

  it("an answer that gives the file another length is a failure: the file changed while it was read", async () => {
    const total = 4 * MiB;
    const fetchRange = vi.fn(async (start: number, end: number) => ({ bytes: fileBytes(start, end), total: total + 518 }));
    const t = createRangeTransport({ bytes: fileBytes(0, MiB - 1), total }, fetchRange);
    const got = listen(t);
    const failures: unknown[] = [];
    onRangeFailure(t, (e) => failures.push(e));
    t.requestDataRange(MiB, 2 * MiB);
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toMatchObject({ name: "FileChangedError" });
    await tick();
    expect(got).toEqual([]);
    // The same length is fine.
    const ok = createRangeTransport({ bytes: fileBytes(0, MiB - 1), total }, async (start, end) => ({ bytes: fileBytes(start, end), total }));
    const got2 = listen(ok);
    ok.requestDataRange(MiB, 2 * MiB);
    await vi.waitFor(() => expect(got2).toHaveLength(1));
  });

  it("an answer that does not say the file's length (bare bytes, or no whole-number total) is a failure, never data", async () => {
    for (const bad of [fileBytes(MiB, 2 * MiB - 1), { bytes: fileBytes(MiB, 2 * MiB - 1) }, { bytes: fileBytes(MiB, 2 * MiB - 1), total: "4194304" }]) {
      const fetchRange = vi.fn(async () => bad as unknown as { bytes: Uint8Array; total: number });
      const t = createRangeTransport({ bytes: fileBytes(0, MiB - 1), total: 4 * MiB }, fetchRange);
      const got = listen(t);
      const failures: unknown[] = [];
      onRangeFailure(t, (e) => failures.push(e));
      t.requestDataRange(MiB, 2 * MiB);
      await vi.waitFor(() => expect(failures).toHaveLength(1));
      await tick();
      expect(got).toEqual([]);
    }
  });

  it("refuses a first part that is not the start of a file of that length", () => {
    expect(() => createRangeTransport({ bytes: new Uint8Array(10), total: 5 }, async () => ({ bytes: new Uint8Array(0), total: 10 }))).toThrow();
    expect(() => createRangeTransport({ bytes: new Uint8Array(10), total: 0 }, async () => ({ bytes: new Uint8Array(0), total: 10 }))).toThrow();
    expect(() => createRangeTransport({ bytes: new Uint8Array(10), total: 1.5 }, async () => ({ bytes: new Uint8Array(0), total: 10 }))).toThrow();
  });
});
