/**
 * The hand-over of a search's words to the reader (Task R12, Rulings R192 f, R195): in memory only,
 * taken once, gone after 60 seconds, on a change of the library's state, and on a failed watch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPendingFind, FIND_TTL_MS, guardPendingFind, setPendingFind, takePendingFind } from "./readerHandoff";

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
