/**
 * The hand-over of a search's words to the reader (Task R12, Rulings R192 f, R195): in memory only,
 * taken once, gone after 60 seconds, on a change of the library's state, and on a failed watch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, STREAM_OPEN_TIMEOUT_MS } from "../api/client";
import { clearPendingFind, FIND_DROPPED_TTL_MS, FIND_TTL_MS, guardPendingFind, setPendingFind, takeFindDropped, takePendingFind } from "./readerHandoff";

beforeEach(() => {
  vi.useFakeTimers();
  clearPendingFind();
});
afterEach(() => {
  clearPendingFind();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

const storages = () => JSON.stringify([...Object.entries(localStorage), ...Object.entries(sessionStorage)]);

describe("readerHandoff", () => {
  it("words are taken once and never put in the address", () => {
    const before = window.location.href;
    const stateBefore = JSON.stringify(window.history.state);
    setPendingFind("p1", "s1", "cultural capital");
    expect(window.location.href).toBe(before);
    expect(JSON.stringify(window.history.state)).toBe(stateBefore);
    expect(storages()).not.toContain("capital");
    expect(takePendingFind("p1", "s1")).toBe("cultural capital");
    expect(takePendingFind("p1", "s1")).toBeUndefined();
    expect(window.location.href).toBe(before);
    expect(window.location.href).not.toContain("capital");
    expect(storages()).not.toContain("capital");
  });

  it("are for the project and source they were set for; asking for another source takes nothing and leaves nothing", () => {
    setPendingFind("p1", "s1", "habitus");
    expect(takePendingFind("p1", "s2")).toBeUndefined();
    expect(takePendingFind("p1", "s1")).toBeUndefined();
    setPendingFind("p1", "s1", "habitus");
    expect(takePendingFind("p2", "s1")).toBeUndefined();
    expect(takePendingFind("p1", "s1")).toBeUndefined();
  });

  it("a second search replaces the first", () => {
    setPendingFind("p1", "s1", "first");
    setPendingFind("p1", "s2", "second");
    expect(takePendingFind("p1", "s1")).toBeUndefined();
    setPendingFind("p1", "s1", "first");
    setPendingFind("p1", "s2", "second");
    expect(takePendingFind("p1", "s2")).toBe("second");
  });

  it("expire after 60 seconds, to the millisecond", () => {
    expect(FIND_TTL_MS).toBe(60_000);
    setPendingFind("p1", "s1", "habitus");
    vi.advanceTimersByTime(FIND_TTL_MS - 1);
    expect(takePendingFind("p1", "s1")).toBe("habitus");
    setPendingFind("p1", "s1", "habitus");
    vi.advanceTimersByTime(FIND_TTL_MS);
    expect(takePendingFind("p1", "s1")).toBeUndefined();
  });

  it("are dropped by clearPendingFind (a lock, a close, a switch)", () => {
    setPendingFind("p1", "s1", "habitus");
    clearPendingFind();
    expect(takePendingFind("p1", "s1")).toBeUndefined();
  });

  it("are not kept by a timer after they were taken: a later set is not cut short by the first one's expiry", () => {
    setPendingFind("p1", "s1", "one");
    vi.advanceTimersByTime(50_000);
    expect(takePendingFind("p1", "s1")).toBe("one");
    setPendingFind("p1", "s1", "two");
    vi.advanceTimersByTime(20_000);
    expect(takePendingFind("p1", "s1")).toBe("two");
  });
});

/** A stream of events the test feeds by hand. */
function stream() {
  const queue: Array<{ type: string } | Error | "end"> = [];
  let wake: (() => void) | undefined;
  const push = (e: { type: string } | Error | "end") => {
    queue.push(e);
    wake?.();
  };
  const events = vi.fn(async function* (o: { signal?: AbortSignal } = {}) {
    for (;;) {
      while (queue.length === 0) {
        if (o.signal?.aborted) return;
        await new Promise<void>((r) => {
          wake = r;
          o.signal?.addEventListener("abort", () => r(), { once: true });
        });
      }
      const e = queue.shift()!;
      if (e === "end") return;
      if (e instanceof Error) throw e;
      yield e;
    }
  });
  return { events, push };
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("guardPendingFind", () => {
  it("keeps the words through the state the stream opens with, and drops them at the next change of state", async () => {
    const s = stream();
    setPendingFind("p1", "s1", "habitus");
    guardPendingFind(s.events);
    s.push({ type: "library.state" });
    await settle();
    s.push({ type: "job.progress" });
    await settle();
    expect(takePendingFind("p1", "s1")).toBe("habitus");
  });

  it("drops the words at a change of state after the first", async () => {
    const s = stream();
    setPendingFind("p1", "s1", "habitus");
    guardPendingFind(s.events);
    s.push({ type: "library.state" });
    await settle();
    s.push({ type: "library.state" });
    await settle();
    expect(takePendingFind("p1", "s1")).toBeUndefined();
  });

  it("drops the words when the stream is lost (it fails closed)", async () => {
    const s = stream();
    setPendingFind("p1", "s1", "habitus");
    guardPendingFind(s.events);
    s.push(new Error("lost"));
    await settle();
    expect(takePendingFind("p1", "s1")).toBeUndefined();
  });

  it("stops watching when the words are taken, and does nothing when there are none", async () => {
    const s = stream();
    guardPendingFind(s.events);
    expect(s.events).not.toHaveBeenCalled();
    setPendingFind("p1", "s1", "habitus");
    guardPendingFind(s.events);
    const signal = s.events.mock.calls[0]![0]!.signal!;
    expect(takePendingFind("p1", "s1")).toBe("habitus");
    expect(signal.aborted).toBe(true);
  });
});

describe("guardPendingFind's opening limit (R641 D1, ruled (a)): a watch not open in time is lost and drops the words; nothing reconnects", () => {
  const BASE = "http://127.0.0.1:4100";
  const TOKEN = "t".repeat(40);
  /** A real client over a fetch that answers by `answer`; each request's signal is kept. */
  function service(answer: (signal: AbortSignal) => Promise<Response> | Response) {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn(async (_u: RequestInfo | URL, init: RequestInit = {}) => {
      signals.push(init.signal!);
      return answer(init.signal!);
    }) as unknown as typeof globalThis.fetch;
    const client = createClient(BASE, TOKEN, { fetch });
    return { events: (o: Parameters<typeof client.events>[0]) => client.events(o), signals, fetch: fetch as unknown as ReturnType<typeof vi.fn> };
  }
  /** An opened stream: the state, then `: keep-alive` at each of `beats` (ms after opening). It never ends of itself. */
  const opened = (beats: number[]) => () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const send = (t: string) => c.enqueue(new TextEncoder().encode(t));
        send("event: library.state\ndata: {}\n\n");
        for (const at of beats) setTimeout(() => send(": keep-alive\n\n"), at);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };

  it("the watch is opened with the opening limit and no silence limit (the words' own 60 s life ends the watch first)", () => {
    const s = stream();
    setPendingFind("p1", "s1", "habitus");
    guardPendingFind(s.events);
    expect(s.events.mock.calls[0]![0]).toMatchObject({ openWithinMs: STREAM_OPEN_TIMEOUT_MS });
    expect(s.events.mock.calls[0]![0]).not.toHaveProperty("quietWithinMs");
  });

  it("a watch that is not open within the limit is lost: its request is cancelled, the words are dropped (and said to be), nothing is opened again", async () => {
    const svc = service((signal) => new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })));
    setPendingFind("p1", "s1", "habitus");
    guardPendingFind(svc.events);
    await vi.advanceTimersByTimeAsync(STREAM_OPEN_TIMEOUT_MS - 1_000);
    expect(svc.signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(svc.signals[0]!.aborted).toBe(true);
    expect(takePendingFind("p1", "s1")).toBeUndefined();
    expect(takeFindDropped("p1", "s1")).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(svc.fetch).toHaveBeenCalledTimes(1);
  });

  it("a watch that opens in time and keeps its keep-alives carries the words exactly as today", async () => {
    const svc = service(opened([25_000, 50_000]));
    setPendingFind("p1", "s1", "habitus");
    guardPendingFind(svc.events);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(svc.signals[0]!.aborted).toBe(false);
    expect(takePendingFind("p1", "s1")).toBe("habitus");
    expect(takeFindDropped("p1", "s1")).toBe(false);
    // Taken: the watch ends.
    expect(svc.signals[0]!.aborted).toBe(true);
    expect(svc.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("takeFindDropped: telling the researcher the words were not carried over", () => {
  it("is true once for the source whose words were dropped before the reader took them", () => {
    setPendingFind("p1", "s1", "habitus");
    clearPendingFind();
    expect(takeFindDropped("p1", "s2")).toBe(false);
    expect(takeFindDropped("p1", "s1")).toBe(true);
    expect(takeFindDropped("p1", "s1")).toBe(false);
  });

  it("is false when the words were taken, or when nothing was handed over", () => {
    expect(takeFindDropped("p1", "s1")).toBe(false);
    setPendingFind("p1", "s1", "habitus");
    expect(takePendingFind("p1", "s1")).toBe("habitus");
    expect(takeFindDropped("p1", "s1")).toBe(false);
  });

  it("is true when the words expired, and only for a short while", () => {
    setPendingFind("p1", "s1", "habitus");
    vi.advanceTimersByTime(FIND_TTL_MS);
    vi.advanceTimersByTime(FIND_DROPPED_TTL_MS - 1);
    expect(takeFindDropped("p1", "s1")).toBe(true);
    setPendingFind("p1", "s1", "habitus");
    clearPendingFind();
    vi.advanceTimersByTime(FIND_DROPPED_TTL_MS);
    expect(takeFindDropped("p1", "s1")).toBe(false);
  });

  it("a new hand-over forgets an old drop", () => {
    setPendingFind("p1", "s1", "habitus");
    clearPendingFind();
    setPendingFind("p1", "s1", "again");
    expect(takePendingFind("p1", "s1")).toBe("again");
    expect(takeFindDropped("p1", "s1")).toBe(false);
  });
});
