import { describe, expect, it, vi } from "vitest";
import { CREDENTIAL_QUERY_KEYS } from "@ao/shared";
import { DEFAULT_APPEARANCE } from "../theme/appearance";
import { ApiClientError, SERVICE_NO_ANSWER, SseParser, createClient } from "./client";

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

describe("bytes() — a file's content, with the token in the header (R135 1, Task 57)", () => {
  it("GETs the path with the Authorization header and gives the body as a Blob of its type", async () => {
    const f = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } }));
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    const b = await api.bytes("/projects/p/sources/s/assets/a/content");
    expect(b.type).toBe("image/png");
    expect([...new Uint8Array(await b.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(f.calls[0]!.url).toBe(`${BASE}/projects/p/sources/s/assets/a/content`);
    expect(f.calls[0]!.init.method).toBe("GET");
    expect(header(f.calls[0]!.init, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[0]!.url).not.toContain(TOKEN);
  });

  it("an error answer is the service's error; a bad path is refused before any request", async () => {
    const f = fakeFetch(() => json({ error: { code: "PROJECT_LOCKED", message: "This project is locked." } }, 423));
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    await expect(api.bytes("/x")).rejects.toMatchObject({ status: 423, code: "PROJECT_LOCKED", message: "This project is locked." });
    expect(() => api.bytes(`/x?t=${TOKEN}`)).toThrow();
    expect(() => api.bytes(`/x/${TOKEN}`)).toThrow();
    expect(f.calls).toHaveLength(1);
  });

  it("an answer larger than the limit given is refused", async () => {
    const f = fakeFetch(() => new Response(new Uint8Array(100), { status: 200, headers: { "content-type": "image/png", "content-length": "100" } }));
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    await expect(api.bytes("/x", { maxBytes: 10 })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("with no Content-Length, it stops reading once the limit is passed and gives up the rest (M11)", async () => {
    // A body of 4-byte chunks that would go on for 40 000 bytes; nothing says how long it is.
    let pulls = 0;
    let cancelled = false;
    const body = () =>
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulls++;
          if (pulls > 10_000) c.close();
          else c.enqueue(new Uint8Array([1, 2, 3, 4]));
        },
        cancel() {
          cancelled = true;
        },
      });
    const f = fakeFetch(() => new Response(body(), { status: 200, headers: { "content-type": "image/png" } }));
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    await expect(api.bytes("/x", { maxBytes: 10 })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(pulls).toBeLessThan(10); // 3 chunks pass 10 bytes; the stream may pull a little ahead
    expect(cancelled).toBe(true);
  });

  it("with no Content-Length, a body within the limit is given whole, of its type (M10 d)", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6, 7, 8, 9, 10])];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
        c.close();
      },
    });
    const f = fakeFetch(() => new Response(stream, { status: 200, headers: { "content-type": "font/woff2" } }));
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    const b = await api.bytes("/x", { maxBytes: 10 });
    expect(b.type).toBe("font/woff2");
    // Read as the interface does where Blob.arrayBuffer is missing (this test DOM's Blob lacks it).
    const read = await new Promise<ArrayBuffer>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(b);
    });
    expect([...new Uint8Array(read)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // One byte more than the limit, sent in small pieces: refused.
    const over = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of [...chunks, new Uint8Array([11])]) c.enqueue(ch);
        c.close();
      },
    });
    const g = fakeFetch(() => new Response(over, { status: 200, headers: { "content-type": "font/woff2" } }));
    await expect(createClient(BASE, TOKEN, { fetch: g.fetch }).bytes("/x", { maxBytes: 10 })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });
});

describe("bytes() — a body cut off part-way (FR-350)", () => {
  /** A body that sends one chunk and then fails, as a connection dropped mid-answer does. */
  const brokenBody = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.error(new TypeError("network error"));
      },
    });
  const cut = { status: 0, code: "INTERNAL", message: "The library service's answer was cut off before it finished." };

  it.each([
    ["with a limit (read in chunks)", { maxBytes: 100 }],
    ["without a limit (read whole)", {}],
  ])("%s: said as an answer cut off, not as a service that could not be reached", async (_n, opts) => {
    const f = fakeFetch(() => new Response(brokenBody(), { status: 200, headers: { "content-type": "image/png" } }));
    await expect(createClient(BASE, TOKEN, { fetch: f.fetch }).bytes("/x", opts)).rejects.toMatchObject(cut);
  });
});

describe("byteRange() and ndjson() — an answer cut off part-way (FR-350, R467 M6)", () => {
  /** One line, then the connection drops on the next read. */
  const brokenBody = () => {
    let n = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (n++ === 0) c.enqueue(new TextEncoder().encode('{"a":1}\n'));
        else c.error(new TypeError("network error"));
      },
    });
  };
  const cut = { status: 0, code: "INTERNAL", message: "The library service's answer was cut off before it finished." };
  const unreached = { status: 0, code: "UNAVAILABLE", message: "The library service could not be reached." };

  it("byteRange: a 206 whose body breaks off is said cut off; a request that never got an answer is 'could not be reached'", async () => {
    const f = fakeFetch(() => new Response(brokenBody(), { status: 206, headers: { "content-range": "bytes 0-99/1000" } }));
    await expect(createClient(BASE, TOKEN, { fetch: f.fetch }).byteRange("/x", 0, 99)).rejects.toMatchObject(cut);
    const down = createClient(BASE, TOKEN, { fetch: (() => Promise.reject(new TypeError("network error"))) as typeof fetch });
    await expect(down.byteRange("/x", 0, 99)).rejects.toMatchObject(unreached);
  });

  it("ndjson: a stream whose read breaks off is said cut off (after its lines so far); one that never began is 'could not be reached'", async () => {
    const f = fakeFetch(() => new Response(brokenBody(), { status: 200, headers: { "content-type": "application/x-ndjson" } }));
    const got: unknown[] = [];
    const run = async () => {
      for await (const line of createClient(BASE, TOKEN, { fetch: f.fetch }).ndjson("POST", "/x")) got.push(line);
    };
    await expect(run()).rejects.toMatchObject(cut);
    expect(got).toEqual([{ a: 1 }]);
    const down = createClient(BASE, TOKEN, { fetch: (() => Promise.reject(new TypeError("network error"))) as typeof fetch });
    const never = async () => {
      for await (const _ of down.ndjson("POST", "/x")) void _;
    };
    await expect(never()).rejects.toMatchObject(unreached);
  });
});

describe("mediaUrl() — the address a media element loads (R135)", () => {
  const TICKET = "Ab3_-".repeat(8) + "xyz"; // 43 base64url characters
  const B64_TOKEN = "Q".repeat(40); // a token that could sit inside a ticket-shaped path

  it("gives the base URL plus the ticket path, nothing else, and fetches nothing", () => {
    const f = fakeFetch(() => json({}));
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    expect(api.mediaUrl(`/media/${TICKET}`)).toBe(`${BASE}/media/${TICKET}`);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses anything but /media/<43 base64url characters>: a query, a fragment, other routes, other hosts", () => {
    const api = createClient(BASE, TOKEN, { fetch: fakeFetch(() => json({})).fetch });
    for (const path of [
      `/media/${TICKET}?x=1`,
      `/media/${TICKET}?`,
      `/media/${TICKET}#t=10`,
      `/media/${TICKET}%3Fx=1`,
      `/media/${TICKET}%23t`,
      `/media/${TICKET}/x`,
      `/media/${TICKET.slice(1)}`,
      "/projects",
      `//evil.example/media/${TICKET}`,
      `http://127.0.0.1:4317/media/${TICKET}`,
      `/media/../media/${TICKET}`,
    ]) {
      expect(() => api.mediaUrl(path), path).toThrow(/media address/);
    }
  });

  it("refuses an address carrying the service token, however it is written", () => {
    const api = createClient(BASE, B64_TOKEN, { fetch: fakeFetch(() => json({})).fetch });
    expect(() => api.mediaUrl(`/media/${B64_TOKEN}abc`)).toThrow(/token/);
    expect(() => api.mediaUrl(`/media/abc${B64_TOKEN}`)).toThrow(/token/);
    expect(() => api.mediaUrl(`/media/${TICKET}`)).not.toThrow();
  });

  it("the ordinary request paths still refuse ?, # and the token (unchanged by the media address)", () => {
    const api = createClient(BASE, B64_TOKEN, { fetch: fakeFetch(() => json({})).fetch });
    for (const path of [`/media/${TICKET}?a=1`, `/media/${TICKET}#f`, `/media/${B64_TOKEN}abc`]) {
      expect(() => api.request("GET", path), path).toThrow(/path|token/);
    }
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

  describe("FR-756 C (R586 M2): a stream that does not open within `openWithinMs`", () => {
    /** A fetch the browser never settles: it ends only when its signal aborts. */
    const neverOpens = () =>
      fakeFetch(
        (_u, init) =>
          new Promise<Response>((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          }),
      );

    it("is given up at the limit: its request is cancelled and the stream ends with “did not answer in time”", async () => {
      const f = neverOpens();
      const opened = vi.fn();
      const it = createClient(BASE, TOKEN, { fetch: f.fetch }).events({ openWithinMs: 50, onOpen: opened });
      await expect(it.next()).rejects.toMatchObject({ status: 0, code: "UNAVAILABLE", message: SERVICE_NO_ANSWER });
      expect(f.calls[0]!.init.signal?.aborted).toBe(true);
      expect(opened).not.toHaveBeenCalled();
    });

    it("that is open is never dropped by the limit, however quiet it is", async () => {
      let sent: AbortSignal | undefined;
      const f = fakeFetch((_u, init) => {
        sent = init.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("event: library.state\ndata: {}\n\n"));
            init.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      });
      const ac = new AbortController();
      const opened = vi.fn();
      const it = createClient(BASE, TOKEN, { fetch: f.fetch }).events({ signal: ac.signal, openWithinMs: 50, onOpen: opened });
      expect((await it.next()).value).toEqual({ type: "library.state", data: {} });
      expect(opened).toHaveBeenCalledTimes(1);
      // Six times the limit with nothing on the stream: it is still open, still waiting for the next event.
      const quiet = await Promise.race([it.next().then(() => "ended"), new Promise((r) => setTimeout(() => r("still open"), 300))]);
      expect(quiet).toBe("still open");
      expect(sent?.aborted).toBe(false);
      // The researcher's own leaving still ends it, quietly.
      ac.abort();
      expect(sent?.aborted).toBe(true);
    });

    it("left before it opens ends quietly (the page's own abort is not an error)", async () => {
      const f = neverOpens();
      const ac = new AbortController();
      const it = createClient(BASE, TOKEN, { fetch: f.fetch }).events({ signal: ac.signal, openWithinMs: 5_000 });
      const next = it.next();
      ac.abort();
      await expect(next).resolves.toMatchObject({ done: true });
    });

    it("without `openWithinMs` waits as before (no limit unless asked)", async () => {
      const f = neverOpens();
      const ac = new AbortController();
      const next = createClient(BASE, TOKEN, { fetch: f.fetch }).events({ signal: ac.signal }).next();
      const r = await Promise.race([next.then(() => "settled"), new Promise((res) => setTimeout(() => res("waiting"), 200))]);
      expect(r).toBe("waiting");
      ac.abort();
      await expect(next).resolves.toMatchObject({ done: true });
    });
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

describe("byteRange() — a range of a stored file with the token in the header (Task R5)", () => {
  const PATH = "/projects/p1/sources/s1/assets/a1/document";
  /** A 206 answer as the service gives it. */
  const partial = (body: Uint8Array, contentRange: string | null, status = 206, extra: Record<string, string> = {}) =>
    new Response(body as BodyInit, { status, headers: { "content-type": "application/pdf", ...(contentRange !== null ? { "content-range": contentRange } : {}), ...extra } });
  const bytesOf = (n: number, from = 0) => Uint8Array.from({ length: n }, (_, i) => (from + i) % 251);
  /** A header as sent (jsdom's Headers drops Range, which browsers send with fetch). */
  const sent = (init: RequestInit, name: string): string | undefined => Object.entries((init.headers ?? {}) as Record<string, string>).find(([k]) => k.toLowerCase() === name)?.[1];

  it("byteRange sends the token in the header and returns the bytes and total", async () => {
    const f = fakeFetch(() => partial(bytesOf(10, 5), "bytes 5-14/100"));
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    const r = await api.byteRange(PATH, 5, 14);
    expect(r.start).toBe(5);
    expect(r.end).toBe(14);
    expect(r.total).toBe(100);
    expect(r.bytes).toBeInstanceOf(Uint8Array);
    expect([...r.bytes]).toEqual([...bytesOf(10, 5)]);
    expect(f.calls).toHaveLength(1);
    const c = f.calls[0]!;
    expect(c.url).toBe(`${BASE}${PATH}`);
    expect(c.url).not.toContain(TOKEN);
    expect(c.init.method).toBe("GET");
    expect(header(c.init, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(sent(c.init, "range")).toBe("bytes=5-14");
    expect(sent(c.init, "if-range")).toBeUndefined();
  });

  it("byteRange accepts an answer cut short by the service (its 4 MiB limit, or the end of the file)", async () => {
    const f = fakeFetch((_url, init) => {
      const asked = sent(init, "range");
      return asked === "bytes=0-9999999" ? partial(bytesOf(4194304), "bytes 0-4194303/20000000") : partial(bytesOf(3, 97), "bytes 97-99/100");
    });
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    const big = await api.byteRange(PATH, 0, 9999999);
    expect({ start: big.start, end: big.end, total: big.total, length: big.bytes.length }).toEqual({ start: 0, end: 4194303, total: 20000000, length: 4194304 });
    const tail = await api.byteRange(PATH, 97, 500);
    expect({ start: tail.start, end: tail.end, total: tail.total }).toEqual({ start: 97, end: 99, total: 100 });
  });

  it("byteRange refuses a mismatched Content-Range", async () => {
    const cases: Array<[string, () => Response]> = [
      ["another start", () => partial(bytesOf(10), "bytes 0-9/100")],
      ["an end past what was asked", () => partial(bytesOf(11), "bytes 5-15/100")],
      ["an end past the file", () => partial(bytesOf(10), "bytes 5-14/14")],
      ["no Content-Range", () => partial(bytesOf(10), null)],
      ["an unknown total", () => partial(bytesOf(10), "bytes 5-14/*")],
      ["another unit", () => partial(bytesOf(10), "items 5-14/100")],
      ["not a number", () => partial(bytesOf(10), "bytes 5-1e1/100")],
      ["the whole file (200), not a range", () => partial(bytesOf(100), "bytes 5-14/100", 200)],
      ["a shorter body", () => partial(bytesOf(9, 5), "bytes 5-14/100")],
      ["a longer body", () => partial(bytesOf(11, 5), "bytes 5-14/100")],
      ["a declared length that differs", () => partial(bytesOf(10, 5), "bytes 5-14/100", 206, { "content-length": "11" })],
      ["cut short in the middle of the file without reason", () => partial(bytesOf(5, 5), "bytes 5-9/100")],
    ];
    for (const [what, respond] of cases) {
      const api = createClient(BASE, TOKEN, { fetch: fakeFetch(respond).fetch });
      const err = await api.byteRange(PATH, 5, 14).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, what).toBeInstanceOf(ApiClientError);
      expect((err as ApiClientError).code, what).toBe("INTERNAL");
      // Not a success status: the answer was wrong, as a bad gateway's would be (review M5).
      expect((err as ApiClientError).status, what).toBe(502);
      expect((err as ApiClientError).message, what).not.toContain(TOKEN);
    }
  });

  it("byteRange gives the service's own refusals as they are, and checks its arguments before sending", async () => {
    const f = fakeFetch(() => json({ error: { code: "PROJECT_LOCKED", message: "This project is locked. Its passphrase is needed." } }, 423));
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    await expect(api.byteRange(PATH, 0, 9)).rejects.toMatchObject({ status: 423, code: "PROJECT_LOCKED" });
    const unsatisfiable = createClient(BASE, TOKEN, { fetch: fakeFetch(() => new Response(null, { status: 416, headers: { "content-range": "bytes */100" } })).fetch });
    // A 416 has no error body: it is said in plain words, with the file's length when the service gave it (review M5).
    await expect(unsatisfiable.byteRange(PATH, 200, 300)).rejects.toMatchObject({ status: 416, code: "VALIDATION", message: "The part of the file asked for is past its end.", reason: "100" });
    const empty = createClient(BASE, TOKEN, { fetch: fakeFetch(() => new Response(null, { status: 416, headers: { "content-range": "bytes */0" } })).fetch });
    await expect(empty.byteRange(PATH, 0, 9)).rejects.toMatchObject({ status: 416, reason: "0" });
    const before = f.calls.length;
    for (const [a, b] of [
      [-1, 9],
      [10, 9],
      [0.5, 9],
      [0, Number.NaN],
      [0, 2 ** 53],
    ] as Array<[number, number]>) {
      await expect(api.byteRange(PATH, a, b)).rejects.toThrow();
    }
    await expect(api.byteRange(`${PATH}?token=${TOKEN}`, 0, 9)).rejects.toThrow();
    await expect(api.byteRange(`/x/${TOKEN}`, 0, 9)).rejects.toThrow();
    expect(f.calls.length).toBe(before);
  });

  it("byteRange passes its signal to the request", async () => {
    const ctl = new AbortController();
    const f = fakeFetch((_url, init) => {
      expect(init.signal).toBe(ctl.signal);
      return partial(bytesOf(2), "bytes 0-1/2");
    });
    const api = createClient(BASE, TOKEN, { fetch: f.fetch });
    await api.byteRange(PATH, 0, 1, { signal: ctl.signal });
    ctl.abort();
    const g = fakeFetch((_url, init) => (init.signal?.aborted ? Promise.reject(new DOMException("aborted", "AbortError")) : partial(bytesOf(2), "bytes 0-1/2")));
    await expect(createClient(BASE, TOKEN, { fetch: g.fetch }).byteRange(PATH, 0, 1, { signal: ctl.signal })).rejects.toMatchObject({ name: "AbortError" });
    // Aborted once the body is read but before the bytes are handed back: no stale answer (review M5).
    const late = new AbortController();
    const h = fakeFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(bytesOf(2));
          c.close();
          late.abort();
        },
      });
      return new Response(body, { status: 206, headers: { "content-range": "bytes 0-1/2" } });
    });
    await expect(createClient(BASE, TOKEN, { fetch: h.fetch }).byteRange(PATH, 0, 1, { signal: late.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
