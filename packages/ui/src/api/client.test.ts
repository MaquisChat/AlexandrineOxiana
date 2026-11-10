import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../theme/appearance";
import { ApiClientError, createClient, parseSse } from "./client";

const TOKEN = "t".repeat(40) + "SECRET";
const BASE = "http://127.0.0.1:4317";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

describe("createClient", () => {
  it("GET /settings/appearance with the token in the Authorization header", async () => {
    const f = fakeFetch(() => json(DEFAULT_APPEARANCE));
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    await expect(api.appearance.get()).resolves.toEqual(DEFAULT_APPEARANCE);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(`${BASE}/settings/appearance`);
    expect(f.calls[0]!.init.method).toBe("GET");
    expect(header(f.calls[0]!.init, "authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("PUT /settings/appearance sends the patch as JSON and returns the merged settings", async () => {
    const merged = { ...DEFAULT_APPEARANCE, theme: "dark" as const };
    const f = fakeFetch(() => json(merged));
    const api = createClient(`${BASE}/`, TOKEN, { fetch: f.fetch });
    await expect(api.appearance.put({ theme: "dark" })).resolves.toEqual(merged);
    const c = f.calls[0]!;
    expect(c.url).toBe(`${BASE}/settings/appearance`);
    expect(c.init.method).toBe("PUT");
    expect(header(c.init, "content-type")).toBe("application/json");
    expect(JSON.parse(String(c.init.body))).toEqual({ theme: "dark" });
  });

  it("never puts the token in a URL, for any request (including the event stream)", async () => {
    const f = fakeFetch((url) => (url.endsWith("/events") ? new Response(new ReadableStream({ start: (c) => c.close() })) : json([])));
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    await api.appearance.get();
    await api.appearance.put({ density: "compact" });
    await api.request("GET", "/libraries");
    await api.request("GET", "/projects/p1/sources", { query: { text: "x" } });
    for await (const _ of api.events()) void _;
    expect(f.calls.length).toBe(5);
    for (const c of f.calls) {
      expect(c.url).not.toContain(TOKEN);
      expect(c.url).not.toMatch(/token=/i);
      expect(header(c.init, "authorization")).toBe(`Bearer ${TOKEN}`);
    }
    expect(f.calls[3]!.url).toBe(`${BASE}/projects/p1/sources?text=x`);
  });

  it("refuses a base URL that carries credentials or a query string, and a query parameter named token", () => {
    expect(() => createClient(`http://u:p@127.0.0.1:1`, TOKEN)).toThrow(/base URL/);
    expect(() => createClient(`${BASE}/?token=${TOKEN}`, TOKEN)).toThrow(/base URL/);
    expect(() => createClient("file:///etc", TOKEN)).toThrow(/base URL/);
    const api = createClient(BASE, TOKEN, { fetch: fakeFetch(() => json({})).fetch });
    expect(() => api.request("GET", "/x", { query: { token: "abc" } })).toThrow(/token/);
    expect(() => api.request("GET", "x")).toThrow(/path/);
  });

  it("errors carry the service's { error: { code, message, reason } }", async () => {
    const f = fakeFetch(() => json({ error: { code: "VALIDATION", message: '"theme" must be one of: system, light, dark.', reason: "bad value" } }, 400));
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    const err = await api.appearance.put({ theme: "dark" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    const e = err as ApiClientError;
    expect(e.status).toBe(400);
    expect(e.code).toBe("VALIDATION");
    expect(e.message).toBe('"theme" must be one of: system, light, dark.');
    expect(e.reason).toBe("bad value");
    expect(e.error).toEqual({ code: "VALIDATION", message: '"theme" must be one of: system, light, dark.', reason: "bad value" });
  });

  it("a response that is not the service's error shape, or no response at all, still gives a plain error", async () => {
    const api = createClient(BASE, TOKEN, { fetch: fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 })).fetch });
    const e = (await api.appearance.get().catch((x: unknown) => x)) as ApiClientError;
    expect(e.code).toBe("INTERNAL");
    expect(e.status).toBe(502);
    const down = createClient(BASE, TOKEN, {
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const d = (await down.appearance.get().catch((x: unknown) => x)) as ApiClientError;
    expect(d).toBeInstanceOf(ApiClientError);
    expect(d.code).toBe("UNAVAILABLE");
    expect(d.message).not.toContain(TOKEN);
  });
});

describe("events() — SSE over fetch streaming (not EventSource)", () => {
  function streamOf(chunks: string[]) {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
  }

  it("reads frames split across chunks, with the Authorization header", async () => {
    const f = fakeFetch(
      () =>
        new Response(
          streamOf([
            "event: library.state\ndata: {\"state\":\"open\"}\n\n: keep-alive\n\nevent: job.pro",
            "gress\ndata: {\"id\":\"j1\",\n",
            "data: \"done\":3}\n\n",
          ]),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const es = vi.fn();
    vi.stubGlobal("EventSource", es);
    try {
      const api = createClient(BASE, TOKEN, { fetch: f.fetch });
      const got = [];
      for await (const ev of api.events()) got.push(ev);
      expect(got).toEqual([
        { type: "library.state", data: { state: "open" } },
        { type: "job.progress", data: { id: "j1", done: 3 } },
      ]);
      expect(es).not.toHaveBeenCalled();
      expect(f.calls[0]!.url).toBe(`${BASE}/events`);
      expect(header(f.calls[0]!.init, "authorization")).toBe(`Bearer ${TOKEN}`);
      expect(header(f.calls[0]!.init, "accept")).toBe("text/event-stream");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an error response to /events throws the service error", async () => {
    const api = createClient(BASE, TOKEN, { fetch: fakeFetch(() => json({ error: { code: "UNAUTHORIZED", message: "Not signed in." } }, 401)).fetch });
    const it = api.events();
    await expect(it.next()).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("stops when the signal aborts", async () => {
    const ac = new AbortController();
    const f = fakeFetch((_u, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("event: library.state\ndata: {}\n\n"));
          init.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body);
    });
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    const got = [];
    for await (const ev of api.events({ signal: ac.signal })) {
      got.push(ev);
      ac.abort();
    }
    expect(got).toHaveLength(1);
  });

  it("parseSse handles CRLF line endings and multi-line data", () => {
    expect(parseSse("event: a\r\ndata: 1\r\n\r\n")).toEqual({ events: [{ type: "a", data: 1 }], rest: "" });
    expect(parseSse("data: {\"x\":\ndata: 1}\n\nevent: b")).toEqual({ events: [{ type: "message", data: { x: 1 } }], rest: "event: b" });
  });
});
