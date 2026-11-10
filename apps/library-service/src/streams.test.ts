/** Backpressure of the streamed responses (R99 minors): slow SSE clients dropped, NDJSON waits for drain. */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ndjsonWriter, sseWriter } from "./streams.js";

class FakeRes extends EventEmitter {
  writableLength = 0;
  writes: string[] = [];
  destroyed = false;
  full = false;
  write(s: string): boolean {
    this.writes.push(s);
    this.writableLength += s.length;
    return !this.full;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

describe("streams", () => {
  it("an SSE client whose buffer passes the cap is dropped", () => {
    const res = new FakeRes();
    const send = sseWriter(res as never, 100);
    expect(send("x".repeat(50))).toBe(true);
    res.full = true;
    expect(send("y".repeat(80))).toBe(false);
    expect(res.destroyed).toBe(true);
    expect(send("z")).toBe(false);
    expect(res.writes).toHaveLength(2);
  });

  it("NDJSON waits for drain before the next line", async () => {
    const res = new FakeRes();
    const write = ndjsonWriter(res as never);
    res.full = true;
    let second = false;
    const p = write({ a: 1 }).then(() => write({ b: 2 }).then(() => (second = true)));
    await new Promise((r) => setTimeout(r, 20));
    expect(res.writes).toEqual(['{"a":1}\n']);
    expect(second).toBe(false);
    res.full = false;
    res.emit("drain");
    await p;
    expect(res.writes).toEqual(['{"a":1}\n', '{"b":2}\n']);
  });
});
