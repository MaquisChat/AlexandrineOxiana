/**
 * The capture queues a service knows of, readable again (Task 63, R146): bounded in memory and in
 * answers, never across projects, and a running address cannot be queued twice in one project.
 */
import { describe, expect, it } from "vitest";
import { CAPTURE_ITEMS_KEPT, CAPTURE_QUEUE_KEEP_MS, CAPTURE_QUEUES_KEPT, CAPTURE_QUEUES_LISTED } from "@ao/shared";
import { CaptureQueueRegistry } from "./queues.js";
import type { ProfileCaptureReport } from "./profile-capture.js";

const P = "019a6f00-0000-7000-8000-000000000001";
const Q = "019a6f00-0000-7000-8000-000000000002";
const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const IG = "https://www.instagram.com/p/Cabc123/";
const TT = "https://www.tiktok.com/@someone/video/7234567890";

function clock(start = Date.parse("2026-11-12T10:00:00Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("CaptureQueueRegistry", () => {
  it("a links queue: every address, the outcomes so far in order, and its end", () => {
    const c = clock();
    const r = new CaptureQueueRegistry({ now: c.now });
    r.startLinks("q1", P, [YT, IG, TT], "desktop");
    expect(r.detail(P, "q1")).toEqual({
      queueId: "q1",
      projectId: P,
      kind: "links",
      startedBy: "desktop",
      done: 0,
      total: 3,
      finished: false,
      startedAt: "2026-11-12T10:00:00.000Z",
      urls: [YT, IG, TT],
      items: [],
    });
    r.progress("q1", 1, 3, { url: YT, status: "created", sourceId: "s1" });
    r.progress("q1", 2, 3, { url: IG, status: "failed", errorCode: "TOOL_NOT_INSTALLED", reason: "The image downloader is not installed on this computer, so nothing was saved.", tool: "image-downloader" });
    c.advance(5000);
    r.finish("q1", { error: Object.assign(new Error("/home/someone/secret path"), { name: "WorkerUnavailableError" }) });
    const d = r.detail(P, "q1")!;
    expect(d.done).toBe(2);
    expect(d.finished).toBe(true);
    expect(d.finishedAt).toBe("2026-11-12T10:00:05.000Z");
    // The missing tool's code, sentence and id come through unchanged.
    expect(d.items).toEqual([
      { url: YT, status: "created", sourceId: "s1" },
      { url: IG, status: "failed", errorCode: "TOOL_NOT_INSTALLED", reason: "The image downloader is not installed on this computer, so nothing was saved.", tool: "image-downloader" },
    ]);
    // The kind of error only, never its message.
    expect(d.error).toBe("WorkerUnavailableError");
    expect(JSON.stringify(d)).not.toContain("secret");
  });

  it("an outcome carries only its known fields", () => {
    const r = new CaptureQueueRegistry();
    r.startLinks("q1", P, [YT], "extension");
    r.progress("q1", 1, 1, { url: YT, status: "created", secret: "x", path: "/home/a" } as never);
    expect(r.detail(P, "q1")!.items).toEqual([{ url: YT, status: "created" }]);
    expect(r.detail(P, "q1")!.startedBy).toBe("extension");
  });

  it("a profile run: its address, the total once listed, its posts, and its report without items (the stop sentence and the tool kept)", () => {
    const r = new CaptureQueueRegistry();
    r.startProfile("qp", P, "https://www.instagram.com/someone/", "desktop");
    expect(r.detail(P, "qp")).toMatchObject({ kind: "profile", url: "https://www.instagram.com/someone/", total: null, done: 0, items: [] });
    expect(r.detail(P, "qp")!.urls).toBeUndefined();
    r.progress("qp", 1, 4, { url: IG, status: "created" });
    const report: ProfileCaptureReport = {
      status: "paused-rate-limited",
      profileSourceId: "ps",
      batchId: "b1",
      listComplete: false,
      created: 1,
      duplicates: 0,
      incomplete: 0,
      failed: 0,
      newlyUnavailable: 0,
      reappeared: 0,
      edited: 0,
      items: [{ url: IG, status: "created" }],
      errorCode: "RATE_LIMITED",
      reason: "The platform is limiting requests, so the profile capture was paused.",
    };
    r.finish("qp", { report });
    const d = r.detail(P, "qp")!;
    expect(d.total).toBe(4);
    expect(d.items).toEqual([{ url: IG, status: "created" }]);
    expect(d.report).toEqual({ ...report, items: undefined });
    expect(d.report).not.toHaveProperty("items");
    expect(d.report!.reason).toMatch(/paused/);
  });

  it("never answers for another project", () => {
    const r = new CaptureQueueRegistry();
    r.startLinks("q1", P, [YT], "desktop");
    r.startLinks("q2", Q, [IG], "desktop");
    expect(r.detail(Q, "q1")).toBeUndefined();
    expect(r.list(P).map((q) => q.queueId)).toEqual(["q1"]);
    expect(r.list(Q).map((q) => q.queueId)).toEqual(["q2"]);
    expect(r.detail(P, "nope")).toBeUndefined();
  });

  it("lists summaries without items: running first, then the most recently finished, at most CAPTURE_QUEUES_LISTED", () => {
    const c = clock();
    const r = new CaptureQueueRegistry({ now: c.now });
    for (let i = 0; i < CAPTURE_QUEUES_LISTED + 5; i++) {
      r.startLinks(`f${i}`, P, [YT], "desktop");
      c.advance(1000);
      r.finish(`f${i}`, {});
    }
    r.startLinks("running", P, [YT], "desktop");
    const list = r.list(P);
    expect(list).toHaveLength(CAPTURE_QUEUES_LISTED);
    expect(list[0]!.queueId).toBe("running");
    expect(list[1]!.queueId).toBe(`f${CAPTURE_QUEUES_LISTED + 4}`);
    for (const q of list) {
      expect(q).not.toHaveProperty("items");
      expect(q).not.toHaveProperty("urls");
    }
  });

  it("a finished queue is kept for CAPTURE_QUEUE_KEEP_MS; a running one always", () => {
    const c = clock();
    const r = new CaptureQueueRegistry({ now: c.now });
    r.startLinks("done", P, [YT], "desktop");
    r.finish("done", {});
    r.startLinks("long", P, [YT, IG], "desktop");
    c.advance(CAPTURE_QUEUE_KEEP_MS - 1);
    expect(r.detail(P, "done")).toBeDefined();
    c.advance(2);
    expect(r.detail(P, "done")).toBeUndefined();
    expect(r.list(P).map((q) => q.queueId)).toEqual(["long"]);
    c.advance(10 * CAPTURE_QUEUE_KEEP_MS);
    expect(r.detail(P, "long")).toBeDefined();
  });

  it("keeps at most CAPTURE_QUEUES_KEPT finished queues in all (the oldest finished go first)", () => {
    const c = clock();
    const r = new CaptureQueueRegistry({ now: c.now });
    for (let i = 0; i < CAPTURE_QUEUES_KEPT + 3; i++) {
      r.startLinks(`f${i}`, i % 2 ? P : Q, [YT], "desktop");
      c.advance(10);
      r.finish(`f${i}`, {});
    }
    expect(r.size()).toBe(CAPTURE_QUEUES_KEPT);
    expect(r.detail(P, "f1")).toBeUndefined();
    expect(r.detail(Q, "f0")).toBeUndefined();
    expect(r.detail(Q, "f2")).toBeUndefined();
    expect(r.detail(P, "f3")).toBeDefined();
  });

  it("keeps at most CAPTURE_ITEMS_KEPT items of a long profile run and counts the rest", () => {
    const r = new CaptureQueueRegistry();
    r.startProfile("qp", P, "https://www.youtube.com/@someone", "desktop");
    const n = CAPTURE_ITEMS_KEPT + 7;
    for (let i = 1; i <= n; i++) r.progress("qp", i, n, { url: `https://www.youtube.com/watch?v=abcdef${i}`, status: "created" });
    const d = r.detail(P, "qp")!;
    expect(d.done).toBe(n);
    expect(d.items).toHaveLength(CAPTURE_ITEMS_KEPT);
    expect(d.itemsOmitted).toBe(7);
  });

  it("starting a queue id again (a queue carried on after a move) keeps what it had", () => {
    const r = new CaptureQueueRegistry();
    r.startLinks("q1", P, [YT, IG], "desktop");
    r.progress("q1", 1, 2, { url: YT, status: "created" });
    r.startLinks("q1", P, [IG], "desktop");
    expect(r.detail(P, "q1")).toMatchObject({ done: 1, total: 2, urls: [YT, IG] });
  });

  describe("an address still waiting or being captured", () => {
    it("is found in a running links queue of the same project, by its canonical form", () => {
      const r = new CaptureQueueRegistry();
      r.startLinks("q1", P, [YT, IG, TT], "desktop");
      expect(r.runningConflict(P, [IG])).toBe("q1");
      expect(r.runningConflict(P, ["https://www.instagram.com/p/Cabc123/?igsh=abc"])).toBe("q1");
      expect(r.runningConflict(P, ["https://youtu.be/dQw4w9WgXcQ"])).toBe("q1");
      // Another project: no conflict.
      expect(r.runningConflict(Q, [IG])).toBeUndefined();
      // Once captured it is no longer waiting.
      r.progress("q1", 1, 3, { url: YT, status: "created" });
      expect(r.runningConflict(P, [YT])).toBeUndefined();
      expect(r.runningConflict(P, [IG])).toBe("q1");
      // A finished queue holds nothing.
      r.finish("q1", { error: new Error("stopped") });
      expect(r.runningConflict(P, [TT])).toBeUndefined();
    });

    it("is a running profile run's address", () => {
      const r = new CaptureQueueRegistry();
      r.startProfile("qp", P, "https://www.instagram.com/someone/", "desktop");
      expect(r.runningConflict(P, ["https://instagram.com/someone?hl=en"])).toBe("qp");
      expect(r.runningConflict(P, ["https://www.instagram.com/other/"])).toBeUndefined();
      r.finish("qp", {});
      expect(r.runningConflict(P, ["https://www.instagram.com/someone/"])).toBeUndefined();
    });
  });
});
