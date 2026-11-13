/**
 * The reader's typed calls (Task R6): ids only in the addresses, the token only in the header, the
 * document read through byteRange (Task R5), the annotation routes of Task R4 with their methods.
 */
import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import { readerApi } from "./reader";

const BASE = "http://127.0.0.1:4100";
const TOKEN = "t".repeat(40);

function fakeFetch(answer: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const header = (init: RequestInit, name: string) => Object.entries((init.headers ?? {}) as Record<string, string>).find(([k]) => k.toLowerCase() === name)?.[1];

describe("readerApi", () => {
  it("documentRange reads the asset's document route through byteRange, with ids only in the address", async () => {
    const body = Uint8Array.from([37, 80, 68, 70]);
    const f = fakeFetch(() => new Response(body as BodyInit, { status: 206, headers: { "content-type": "application/pdf", "content-range": "bytes 0-3/1000" } }));
    const api = readerApi(createClient(BASE, TOKEN, { fetch: f.fetch }));
    const ac = new AbortController();
    const r = await api.documentRange("p 1", "s/1", "a1", 0, 3, ac.signal);
    expect(r).toMatchObject({ start: 0, end: 3, total: 1000 });
    expect([...r.bytes]).toEqual([37, 80, 68, 70]);
    expect(f.calls[0]!.url).toBe(`${BASE}/projects/p%201/sources/s%2F1/assets/a1/document`);
    expect(f.calls[0]!.url).not.toContain(TOKEN);
    expect(header(f.calls[0]!.init, "range")).toBe("bytes=0-3");
    expect(header(f.calls[0]!.init, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[0]!.init.signal).toBe(ac.signal);
  });

  it("the annotation calls use the routes of Task R4", async () => {
    const f = fakeFetch((_url, init) => new Response(init.method === "GET" ? JSON.stringify({ annotations: [], count: 0, textChars: 0 }) : JSON.stringify({ id: "n1" }), { status: 200, headers: { "content-type": "application/json" } }));
    const api = readerApi(createClient(BASE, TOKEN, { fetch: f.fetch }));
    await api.listAnnotations("p1", "s1");
    await api.createAnnotation("p1", "s1", { kind: "highlight", assetId: "a1", anchors: [{ page: 0, rects: [{ x: 1, y: 2, w: 3, h: 4 }] }], quote: "q", colorName: "yellow" });
    await api.updateAnnotation("p1", "s1", "n/1", { colorName: "blue" });
    await api.deleteAnnotation("p1", "s1", "n/1");
    expect(f.calls.map((c) => `${c.init.method} ${c.url.slice(BASE.length)}`)).toEqual([
      "GET /projects/p1/sources/s1/annotations",
      "POST /projects/p1/sources/s1/annotations",
      "PATCH /projects/p1/sources/s1/annotations/n%2F1",
      "DELETE /projects/p1/sources/s1/annotations/n%2F1",
    ]);
    expect(JSON.parse(String(f.calls[1]!.init.body))).toMatchObject({ kind: "highlight", assetId: "a1", colorName: "yellow" });
    expect(JSON.parse(String(f.calls[2]!.init.body))).toEqual({ colorName: "blue" });
  });
});
