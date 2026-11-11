import { describe, expect, it } from "vitest";
import { addPending, afterSend, chunks, parsePending, removePending, sendInChunks } from "./pending.js";

describe("pending profile links (kept per project, merged, never overwritten)", () => {
  it("keeps lists of different projects apart", () => {
    let p = addPending({}, "p1", ["https://a.example/1"], "r1");
    p = addPending(p, "p2", ["https://a.example/2"], "r2");
    expect(p).toEqual({ p1: { urls: ["https://a.example/1"], reason: "r1" }, p2: { urls: ["https://a.example/2"], reason: "r2" } });
  });

  it("merges a second list for the same project, without duplicates, keeping the newest reason", () => {
    let p = addPending({}, "p1", ["https://a.example/1", "https://a.example/2"], "r1");
    p = addPending(p, "p1", ["https://a.example/2", "https://a.example/3"], "r2");
    expect(p.p1).toEqual({ urls: ["https://a.example/1", "https://a.example/2", "https://a.example/3"], reason: "r2" });
  });

  it("removes one project's list only", () => {
    const p = addPending(addPending({}, "p1", ["https://a.example/1"], "r"), "p2", ["https://a.example/2"], "r");
    expect(Object.keys(removePending(p, "p1"))).toEqual(["p2"]);
  });

  it("reads back only well-formed entries", () => {
    expect(parsePending({ p1: { urls: ["https://a.example/1", 3, "javascript:x"], reason: "r" }, p2: "x", p3: { urls: "no" } })).toEqual({ p1: { urls: ["https://a.example/1"], reason: "r" } });
    expect(parsePending(undefined)).toEqual({});
  });

  it("sends long lists in pieces of at most 500", () => {
    const urls = Array.from({ length: 1201 }, (_, i) => `https://a.example/${i}`);
    expect(chunks(urls, 500).map((c) => c.length)).toEqual([500, 500, 201]);
  });

  it("R116: when a later piece fails, the links already sent leave the pending list (a retry does not send them again)", async () => {
    const urls = Array.from({ length: 700 }, (_, i) => `https://a.example/${i}`);
    let p = addPending({}, "p1", urls, "offline");
    const sentParts: string[][] = [];
    const r = await sendInChunks(p.p1!.urls, 500, async (part) => {
      if (sentParts.length === 1) throw new Error("the service went away");
      sentParts.push(part);
    });
    expect(sentParts.map((x) => x.length)).toEqual([500]);
    expect(r.error).toBeInstanceOf(Error);
    p = afterSend(p, "p1", r.sent, r.rest, "the service went away");
    expect(p.p1!.urls).toEqual(urls.slice(500));
    expect(p.p1!.reason).toBe("the service went away");
    // All taken: the project's list is gone.
    const ok = await sendInChunks(p.p1!.urls, 500, async () => {});
    expect(ok.error).toBeUndefined();
    expect(afterSend(p, "p1", ok.sent, ok.rest, "")).toEqual({});
  });
});
