import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server, testClient, url, useMockService } from "../test/service";
import { ApiClientError, MAX_NDJSON_LINE_BYTES } from "./client";

useMockService();

const enc = new TextEncoder();
function chunks(parts: string[], opts: { gapMs?: number; hang?: boolean } = {}) {
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      for (const p of parts) {
        c.enqueue(enc.encode(p));
        if (opts.gapMs) await new Promise((r) => setTimeout(r, opts.gapMs));
      }
      if (!opts.hang) c.close();
    },
  });
  return new HttpResponse(stream, { headers: { "content-type": "application/x-ndjson" } });
}

async function collect(gen: AsyncGenerator<unknown>) {
  const out: unknown[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe("client.ndjson()", () => {
  it("yields each line, across chunk boundaries", async () => {
    server.use(http.post(url("/s"), () => chunks(['{"a":1}\n{"b"', ':2}\n'])));
    await expect(collect(testClient().ndjson("POST", "/s"))).resolves.toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("an abort returns quietly", async () => {
    server.use(http.post(url("/s"), () => chunks(['{"a":1}\n'], { hang: true })));
    const ac = new AbortController();
    const out: unknown[] = [];
    for await (const v of testClient().ndjson("POST", "/s", { signal: ac.signal })) {
      out.push(v);
      ac.abort();
    }
    expect(out).toEqual([{ a: 1 }]);
  });

  it("an abort while waiting for the next chunk returns quietly", async () => {
    server.use(http.post(url("/s"), () => chunks(['{"a":1}\n'], { hang: true })));
    const ac = new AbortController();
    const out: unknown[] = [];
    setTimeout(() => ac.abort(), 50);
    for await (const v of testClient().ndjson("POST", "/s", { signal: ac.signal })) out.push(v);
    expect(out).toEqual([{ a: 1 }]);
  });

  it("a stream that ends in the middle of a line is an error", async () => {
    server.use(http.post(url("/s"), () => chunks(['{"a":1}\n{"b":'])));
    await expect(collect(testClient().ndjson("POST", "/s"))).rejects.toBeInstanceOf(ApiClientError);
  });

  it("a whole line over 1 MB delivered in one chunk is refused", async () => {
    const line = `${JSON.stringify({ x: "y".repeat(MAX_NDJSON_LINE_BYTES) })}\n`;
    server.use(http.post(url("/s"), () => chunks([line])));
    await expect(collect(testClient().ndjson("POST", "/s"))).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("the cap counts bytes, not characters", async () => {
    // ~0.6 M characters, ~1.2 MB of UTF-8
    const line = `${JSON.stringify({ x: "é".repeat(600_000) })}\n`;
    expect(line.length).toBeLessThan(MAX_NDJSON_LINE_BYTES);
    server.use(http.post(url("/s"), () => chunks([line])));
    await expect(collect(testClient().ndjson("POST", "/s"))).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("an unfinished line growing past 1 MB is refused before the stream ends", async () => {
    const part = "z".repeat(400_000);
    server.use(http.post(url("/s"), () => chunks(['{"x":"', part, part, part], { hang: true })));
    await expect(collect(testClient().ndjson("POST", "/s"))).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });
});

describe("client errors never echo the path or the token", () => {
  it("a bad path's message leaves the path out", () => {
    const token = "t".repeat(40);
    for (const bad of [`/x?${token}`, `/x#${token}`, `/x/%E0%A4%A${token}`, `x/${token}`]) {
      let msg = "";
      try {
        void testClient().request("GET", bad);
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg, bad).not.toBe("");
      expect(msg).not.toContain(token);
      expect(msg).not.toContain("/x");
    }
  });
});
