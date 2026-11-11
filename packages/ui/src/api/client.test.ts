import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CREDENTIAL_QUERY_KEYS } from "@ao/shared";
import { DEFAULT_APPEARANCE } from "../theme/appearance";
import { ApiClientError, SseParser, createClient } from "./client";

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

  it("refuses a base URL that is not loopback http on a port (reviewer bypasses)", () => {
    for (const bad of [
      "http://u:p@127.0.0.1:1",
      `${BASE}/?token=${TOKEN}`,
      `${BASE}/#x`,
      "file:///etc",
      "https://127.0.0.1:4317",
      "http://127.0.0.1",
      "http://127.0.0.1:0",
      "http://localhost",
      "http://evil.example:4317",
      "http://127.0.0.1.evil.example:4317",
      "http://localhost.evil.example:4317",
      "http://[::1]:4317",
      "http://127.0.0.2:4317",
      "http://0x7f000001:4317",
      "http://127.0.0.1:4317/api",
      "  http://127.0.0.1:4317",
    ]) {
      expect(() => createClient(bad, TOKEN), bad).toThrow(/base URL/);
    }
    expect(() => createClient("http://localhost:4317", TOKEN)).not.toThrow();
    expect(() => createClient("http://127.0.0.1:65535/", TOKEN)).not.toThrow();
  });

  it("refuses a token that is short or contains CR/LF", () => {
    expect(() => createClient(BASE, "short")).toThrow(/token/);
    expect(() => createClient(BASE, "x".repeat(31))).toThrow(/token/);
    expect(() => createClient(BASE, `${"x".repeat(40)}\r\nX-Evil: 1`)).toThrow(/token/);
    expect(() => createClient(BASE, `${"x".repeat(40)}\n`)).toThrow(/token/);
    expect(() => createClient(BASE, "x".repeat(32))).not.toThrow();
  });

  it("refuses paths with ? or #, credential query keys (the service's list, any case) and any URL containing the token (reviewer bypasses)", () => {
    const api = createClient(BASE, TOKEN, { fetch: fakeFetch(() => json({})).fetch });
    for (const path of ["x", "//evil.example/x", `/x?token=${TOKEN}`, "/x?a=1", "/x#frag", "/x%3Ftoken=1", `/projects/${TOKEN}`, `/projects/${encodeURIComponent(TOKEN)}`]) {
      expect(() => api.request("GET", path), path).toThrow(/path|token/);
    }
    for (const key of CREDENTIAL_QUERY_KEYS) {
      expect(() => api.request("GET", "/x", { query: { [key]: "v" } }), key).toThrow(/token|credential/);
      expect(() => api.request("GET", "/x", { query: { [key.toUpperCase()]: "v" } }), key).toThrow(/token|credential/);
    }
    expect(() => api.request("GET", "/x", { query: { text: TOKEN } })).toThrow(/token/);
    expect(() => api.request("GET", "/x", { query: { text: TOKEN.slice(0, 20) } })).not.toThrow();
  });

  it("finds the token however a path encodes it, and in query values as URLSearchParams writes them (R109)", () => {
    const odd = "abc def+ghi/jkl~mno!*'()%zz:@;=,$&".padEnd(40, "q");
    const api = createClient(BASE, odd, { fetch: fakeFetch(() => json({})).fetch });
    const once = encodeURIComponent(odd);
    for (const path of [`/x/${once}`, `/x/${encodeURIComponent(once)}`, `/x/${encodeURIComponent(encodeURIComponent(once))}`, `/x/${once.replace(/c/g, "%63")}`]) {
      expect(() => api.request("GET", path), path).toThrow(/token/);
    }
    expect(() => api.request("GET", "/x", { query: { text: odd } })).toThrow(/token/);
    expect(() => api.request("GET", "/x", { query: { text: `prefix ${odd} suffix` } })).toThrow(/token/);
    expect(() => api.request("GET", "/x", { query: { text: "abc def" } })).not.toThrow();
    const plain = createClient(BASE, TOKEN, { fetch: fakeFetch(() => json({})).fetch });
    expect(() => plain.request("GET", `/x/${TOKEN.replace(/t/g, "%74")}`)).toThrow(/token/);
    expect(() => plain.request("GET", "/x/%E0%A4%A")).toThrow(/path/); // undecodable: refused, not guessed
  });

  it("uses the same credential query keys as the service", () => {
    const auth = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/library-service/src/auth.ts"), "utf8");
    const m = /CREDENTIAL_QUERY_KEYS[^=\n]*=\s*new Set\(\[([^\]]*)\]\)/.exec(auth);
    const imported = /import\s*\{[^}]*CREDENTIAL_QUERY_KEYS[^}]*\}\s*from\s*"@ao\/(?:core|shared)/.test(auth);
    expect(m !== null || imported, "auth.ts declares or imports CREDENTIAL_QUERY_KEYS").toBe(true);
    if (m?.[1]) expect(new Set(m[1].split(",").map((k) => k.trim().replace(/"/g, "")))).toEqual(new Set(CREDENTIAL_QUERY_KEYS));
  });

  it("a 2xx answer that is not JSON is an ApiClientError, not a crash", async () => {
    const api = createClient(BASE, TOKEN, { fetch: fakeFetch(() => new Response("<html>proxy</html>", { status: 200 })).fetch });
    const e = await api.appearance.get().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiClientError);
    expect((e as ApiClientError).code).toBe("INTERNAL");
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

  it("a CRLF split across chunks is one line break, not a blank line (no event is cut short)", async () => {
    const f = fakeFetch(() => new Response(streamOf(["event: job.progress\r", "\ndata: {\"a\":1,\r", "\n", "data: \"b\":2}\r\n\r\n"])));
    const got = [];
    for await (const ev of createClient(BASE, TOKEN, { fetch: f.fetch }).events()) got.push(ev);
    expect(got).toEqual([{ type: "job.progress", data: { a: 1, b: 2 } }]);
  });

  it("an incomplete final event (stream ended without a blank line) is discarded", async () => {
    const f = fakeFetch(() => new Response(streamOf(["event: a\ndata: 1\n\n", "event: b\ndata: 2"])));
    const got = [];
    for await (const ev of createClient(BASE, TOKEN, { fetch: f.fetch }).events()) got.push(ev);
    expect(got).toEqual([{ type: "a", data: 1 }]);
  });

  it("an event larger than 1 MB is an error, not unbounded buffering", async () => {
    const big = "x".repeat(256 * 1024);
    const chunks = ["data: \""];
    for (let i = 0; i < 5; i++) chunks.push(big);
    const f = fakeFetch(() => new Response(streamOf(chunks)));
    const it = createClient(BASE, TOKEN, { fetch: f.fetch }).events();
    await expect(it.next()).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("many small chunks of one large event are parsed in linear time", async () => {
    const chunks = ["data: \""];
    for (let i = 0; i < 20000; i++) chunks.push("y".repeat(40));
    chunks.push("\"\n\n");
    const f = fakeFetch(() => new Response(streamOf(chunks)));
    const t0 = performance.now();
    const got = [];
    for await (const ev of createClient(BASE, TOKEN, { fetch: f.fetch }).events()) got.push(ev);
    expect((got[0]!.data as string).length).toBe(800000);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("SseParser handles CR, LF and CRLF line endings, multi-line data and comments", () => {
    const p = new SseParser();
    expect(p.push("event: a\r\ndata: 1\r\n\r\n")).toEqual([{ type: "a", data: 1 }]);
    expect(p.push("data: {\"x\":\ndata: 1}\n\nevent: b")).toEqual([{ type: "message", data: { x: 1 } }]);
    expect(p.push("\rdata: 2\r\r: keep-alive\n\n")).toEqual([{ type: "b", data: 2 }]);
  });

  it("an empty chunk between CR and LF does not split the CRLF (R109)", () => {
    const p = new SseParser();
    expect(p.push("event: a\r")).toEqual([]);
    expect(p.push("")).toEqual([]);
    expect(p.push("\ndata: 1\r")).toEqual([]);
    expect(p.push("")).toEqual([]);
    expect(p.push("\n\r\n")).toEqual([{ type: "a", data: 1 }]);
  });
});

describe("ndjson() — streamed NDJSON answers (Task 36: library move)", () => {
  const stream = (parts: string[]) =>
    new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } }), { status: 200, headers: { "content-type": "application/x-ndjson" } });

  it("yields each line as JSON, joining lines split across chunks, with the token in the header only", async () => {
    const f = fakeFetch(() => stream(['{"progress":{"phase":"co', 'py"}}\n{"done":true}', "\n"]));
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    const out: unknown[] = [];
    for await (const line of api.ndjson("POST", "/libraries/move", { body: { dest: "/x" } })) out.push(line);
    expect(out).toEqual([{ progress: { phase: "copy" } }, { done: true }]);
    expect(f.calls[0]!.url).toBe(`${BASE}/libraries/move`);
    expect(header(f.calls[0]!.init, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[0]!.init.body).toBe(JSON.stringify({ dest: "/x" }));
  });

  it("throws the service's error when the stream never starts", async () => {
    const f = fakeFetch(() => json({ error: { code: "CONFLICT", message: "A move of this library is already running." } }, 409));
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    const it = api.ndjson("POST", "/libraries/move", { body: {} });
    await expect(it.next()).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });
});
