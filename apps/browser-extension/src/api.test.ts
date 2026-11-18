import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi, type LocalStorageArea } from "./api.js";

const TOKEN = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789-_";

function memoryStorage(): LocalStorageArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(key: string) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, JSON.parse(JSON.stringify(items)));
    },
    async remove(key: string) {
      delete data[key];
    },
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const r = respond(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const service = (url: string) => {
  if (url.endsWith("/extension/pair/confirm")) return { status: 200, body: { token: TOKEN } };
  if (url.endsWith("/projects")) return { status: 200, body: { projects: [{ id: "p1", name: "Estuary", captureMethods: ["browser_capture", "downloader"] }] } };
  if (url.endsWith("/capture/browser")) return { status: 200, body: { sourceId: "s1", status: "created" } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } };
};

const headerOf = (init: RequestInit, name: string): string | null => new Headers(init.headers).get(name);

describe("pairing", () => {
  it("posts the code to the port the user typed, stores the token in storage.local, never in a URL", async () => {
    const storage = memoryStorage();
    const { fn, calls } = fakeFetch(service);
    const api = createApi({ fetch: fn, storage });
    const p = await api.pair("48123", "042917");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:48123/extension/pair/confirm");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ code: "042917" });
    expect(headerOf(calls[0]!.init, "content-type")).toBe("application/json");
    expect(headerOf(calls[0]!.init, "authorization")).toBeNull();
    expect(p).toMatchObject({ port: 48123 });
    expect(storage.data.pairing).toMatchObject({ port: 48123, token: TOKEN });

    // Later calls carry the token in the Authorization header only.
    await api.listProjects();
    await api.captureBrowser({ projectId: "p1", url: "https://www.instagram.com/p/X/", extracted: { platform: "instagram", kind: "post", canonicalUrl: "https://www.instagram.com/p/X/", mediaUrls: [] }, screenshotPng: "iVBORw0KGgo=", html: "<html></html>", alsoDownload: false });
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:48123/extension/pair/confirm", "http://127.0.0.1:48123/projects", "http://127.0.0.1:48123/capture/browser"]);
    for (const c of calls) {
      expect(c.url).not.toContain(TOKEN);
      expect(c.url).not.toContain("?");
      expect(String(c.init.body ?? "")).not.toContain(TOKEN);
      expect(c.init.credentials).toBe("omit");
    }
    expect(headerOf(calls[1]!.init, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headerOf(calls[2]!.init, "authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("sends the capture body in the shape /capture/browser reads", async () => {
    const storage = memoryStorage();
    const { fn, calls } = fakeFetch(service);
    const api = createApi({ fetch: fn, storage });
    await api.pair("48123", "123456");
    const body = { projectId: "p1", url: "https://www.instagram.com/p/X/", extracted: { platform: "instagram", kind: "post", canonicalUrl: "https://www.instagram.com/p/X/", caption: "c", mediaUrls: [] }, screenshotPng: "iVBORw0KGgo=", html: "<html></html>", alsoDownload: true };
    expect(await api.captureBrowser(body)).toEqual({ sourceId: "s1", status: "created" });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual(body);
  });

  it("refuses a bad port or code before contacting anything", async () => {
    const { fn, calls } = fakeFetch(service);
    const api = createApi({ fetch: fn, storage: memoryStorage() });
    for (const port of ["0", "70000", "abc", "80; evil", "1.5", ""]) await expect(api.pair(port, "123456"), port).rejects.toBeInstanceOf(ApiError);
    for (const code of ["12345", "1234567", "12a456", " 123456", ""]) await expect(api.pair("48123", code), code).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);
  });

  it("keeps nothing when the service refuses the code", async () => {
    const storage = memoryStorage();
    const { fn } = fakeFetch(() => ({ status: 401, body: { error: { code: "UNAUTHORIZED", message: "That code is not valid. Ask the desktop app for a new one." } } }));
    const api = createApi({ fetch: fn, storage });
    await expect(api.pair("48123", "123456")).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "That code is not valid. Ask the desktop app for a new one." });
    expect(storage.data).toEqual({});
  });

  it("unpair clears the stored token; calls after that need pairing again", async () => {
    const storage = memoryStorage();
    const { fn, calls } = fakeFetch(service);
    const api = createApi({ fetch: fn, storage });
    await api.pair("48123", "123456");
    await api.unpair();
    expect(storage.data.pairing).toBeUndefined();
    expect(await api.getPairing()).toBeUndefined();
    await expect(api.listProjects()).rejects.toMatchObject({ code: "NOT_PAIRED" });
    expect(calls).toHaveLength(1);
  });

  it("forgets a token the service no longer accepts (401)", async () => {
    const storage = memoryStorage();
    let paired = false;
    const { fn } = fakeFetch((url) => {
      if (url.endsWith("/extension/pair/confirm")) {
        paired = true;
        return { status: 200, body: { token: TOKEN } };
      }
      return paired ? { status: 401, body: { error: { code: "UNAUTHORIZED", message: "A valid token is needed." } } } : { status: 500, body: {} };
    });
    const api = createApi({ fetch: fn, storage });
    await api.pair("48123", "123456");
    await expect(api.listProjects()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(storage.data.pairing).toBeUndefined();
  });

  it("refuses a pairing record that is malformed in storage", async () => {
    const storage = memoryStorage();
    storage.data.pairing = { port: "48123/../x", token: TOKEN };
    const api = createApi({ fetch: fakeFetch(service).fn, storage });
    expect(await api.getPairing()).toBeUndefined();
  });

  it("queues profile links with POST /capture/browser/links {projectId, urls} and the Authorization header (R111)", async () => {
    const storage = memoryStorage();
    const { fn, calls } = fakeFetch((url) => (url.endsWith("/capture/browser/links") ? { status: 200, body: { queueId: "q1" } } : service(url)));
    const api = createApi({ fetch: fn, storage });
    await api.pair("48123", "123456");
    expect(await api.queueLinks("p 1/x", ["https://www.instagram.com/p/A/"])).toEqual({ queueId: "q1" });
    expect(calls[1]!.url).toBe("http://127.0.0.1:48123/capture/browser/links");
    expect(calls[1]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ projectId: "p 1/x", urls: ["https://www.instagram.com/p/A/"] });
    expect(headerOf(calls[1]!.init, "authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("keeps the service's error code and reason (POLICY_DENIED carries the rule's reason)", async () => {
    const storage = memoryStorage();
    const { fn } = fakeFetch((url) =>
      url.endsWith("/links") ? { status: 403, body: { error: { code: "POLICY_DENIED", message: "This capture is not allowed.", reason: "Platform tiktok is outside the protocol." } } } : service(url),
    );
    const api = createApi({ fetch: fn, storage });
    await api.pair("48123", "123456");
    await expect(api.queueLinks("p1", ["https://www.tiktok.com/@a/video/12345"])).rejects.toMatchObject({ code: "POLICY_DENIED", status: 403, reason: "Platform tiktok is outside the protocol." });
    expect(storage.data.pairing).toBeDefined(); // a 403 is not a reason to forget the pairing
  });

  it("accepts only a token of at least 32 base64url characters", async () => {
    for (const token of ["short", "a".repeat(31), `${"a".repeat(40)}+/`, `${"a".repeat(40)}=`, `${"a".repeat(40)} `]) {
      const storage = memoryStorage();
      const api = createApi({ fetch: fakeFetch(() => ({ status: 200, body: { token } })).fn, storage });
      await expect(api.pair("48123", "123456"), token).rejects.toMatchObject({ code: "BAD_REPLY" });
      expect(storage.data).toEqual({});
    }
    const storage = memoryStorage();
    storage.data.pairing = { port: 48123, token: "a".repeat(31) };
    expect(await createApi({ fetch: fakeFetch(service).fn, storage }).getPairing()).toBeUndefined();
    storage.data.pairing = { port: 48123, token: "a".repeat(43) };
    expect(await createApi({ fetch: fakeFetch(service).fn, storage }).getPairing()).toMatchObject({ token: "a".repeat(43) });
  });
});

describe("the app's port changed (R171, defect D13)", () => {
  const OLD = 48123;
  const NEW = 51234;
  const paired = (storage: ReturnType<typeof memoryStorage>) => (storage.data.pairing = { port: OLD, token: TOKEN, pairedAt: "2026-11-01T10:00:00.000Z" });

  it("names both possible causes when the app does not answer on the saved port", async () => {
    const storage = memoryStorage();
    paired(storage);
    const api = createApi({ fetch: (async () => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch, storage });
    const err = (await api.listProjects().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("UNREACHABLE");
    expect(err.message).toContain(`port ${OLD}`);
    expect(err.message).toMatch(/closed/i);
    expect(err.message).toMatch(/port changed|changed its port/i);
    expect(err.message).not.toContain(TOKEN);
    expect(storage.data.pairing).toBeDefined();
  });

  it("checks the new port with one authorised request (the token in the header only), then saves it, keeping the token", async () => {
    const storage = memoryStorage();
    paired(storage);
    const { fn, calls } = fakeFetch(service);
    const api = createApi({ fetch: fn, storage });
    const r = await api.changePort(` ${NEW} `);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://127.0.0.1:${NEW}/projects`);
    expect(calls[0]!.init.method).toBe("GET");
    expect(headerOf(calls[0]!.init, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(r.pairing).toEqual({ port: NEW, token: TOKEN, pairedAt: "2026-11-01T10:00:00.000Z" });
    expect(r.projects).toEqual([{ id: "p1", name: "Estuary", captureMethods: ["browser_capture", "downloader"] }]);
    expect(storage.data.pairing).toEqual({ port: NEW, token: TOKEN, pairedAt: "2026-11-01T10:00:00.000Z" });
    // Later calls go to the new port.
    await api.listProjects();
    expect(calls[1]!.url).toBe(`http://127.0.0.1:${NEW}/projects`);
  });

  it("a desktop app with no library open accepts the token too (503 LIBRARY_OFFLINE): the port is saved", async () => {
    const storage = memoryStorage();
    paired(storage);
    const { fn } = fakeFetch(() => ({ status: 503, body: { error: { code: "LIBRARY_OFFLINE", message: "No library is open." } } }));
    const r = await createApi({ fetch: fn, storage }).changePort(String(NEW));
    expect(r.projects).toBeNull();
    expect(storage.data.pairing).toMatchObject({ port: NEW, token: TOKEN });
  });

  it("“no library open” passes only as the app's own answer: status 503 with the service's error shape (fix round 1, I2)", async () => {
    const offline = { code: "LIBRARY_OFFLINE", message: "No library is open." };
    const refused: Array<{ status: number; body: unknown }> = [
      { status: 400, body: { error: offline } },
      { status: 418, body: { error: offline } },
      { status: 302, body: { error: offline } },
      { status: 500, body: { error: offline } },
      { status: 503, body: { error: { code: "LIBRARY_OFFLINE" } } },
      { status: 503, body: { error: { code: "LIBRARY_OFFLINE", message: 5 } } },
      { status: 503, body: { code: "LIBRARY_OFFLINE", message: "No library is open." } },
      // A success status other than 200, even with a list, is not the app's answer either.
      { status: 201, body: { projects: [] } },
    ];
    for (const r of refused) {
      const storage = memoryStorage();
      paired(storage);
      const err = (await createApi({ fetch: fakeFetch(() => r).fn, storage }).changePort(String(NEW)).catch((e: unknown) => e)) as ApiError;
      expect(err.code, JSON.stringify(r)).toBe("BAD_REPLY");
      expect(storage.data.pairing, JSON.stringify(r)).toMatchObject({ port: OLD, token: TOKEN });
    }
  });

  it("a 503 in the service's own shape shows the service's message; the port and the token are kept (Task 68 round 2, Rm5)", async () => {
    const storage = memoryStorage();
    paired(storage);
    const said = "This computer's list of paired browsers cannot be read right now. Your browser stays paired; try again in a moment, or open the desktop app's “Browser extension” page.";
    const { fn } = fakeFetch(() => ({ status: 503, body: { error: { code: "UNAVAILABLE", message: said } } }));
    const err = (await createApi({ fetch: fn, storage }).changePort(String(NEW)).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("UNAVAILABLE");
    expect(err.message).toContain(said);
    expect(err.message).toContain(`This browser keeps port ${OLD}.`);
    expect(err.message).not.toMatch(/was not one from the desktop app/);
    expect(storage.data.pairing).toMatchObject({ port: OLD, token: TOKEN });
  });

  it("a redirect is refused as everywhere else (the request asks fetch to fail on one), and nothing is saved", async () => {
    const storage = memoryStorage();
    paired(storage);
    let asked: RequestInit | undefined;
    const fn = (async (_i: RequestInfo | URL, init: RequestInit = {}) => {
      asked = init;
      // What fetch does with redirect: "error" when the answer is a redirect.
      throw new TypeError("Failed to fetch: redirect");
    }) as unknown as typeof fetch;
    await expect(createApi({ fetch: fn, storage }).changePort(String(NEW))).rejects.toMatchObject({ code: "UNREACHABLE" });
    expect(asked?.redirect).toBe("error");
    expect(storage.data.pairing).toMatchObject({ port: OLD });
  });

  it("keeps the old port, and says why, when nothing answers on the new one", async () => {
    const storage = memoryStorage();
    paired(storage);
    const api = createApi({ fetch: (async () => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch, storage });
    const err = (await api.changePort(String(NEW)).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("UNREACHABLE");
    expect(err.message).toContain(`port ${NEW}`);
    expect(err.message).toContain(`port ${OLD}`);
    expect(storage.data.pairing).toMatchObject({ port: OLD, token: TOKEN });
  });

  it("keeps the old port and the token when the new port refuses the token (401 or 403): it may be another program", async () => {
    for (const status of [401, 403]) {
      const storage = memoryStorage();
      paired(storage);
      const { fn } = fakeFetch(() => ({ status, body: { error: { code: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", message: "no" } } }));
      const err = (await createApi({ fetch: fn, storage }).changePort(String(NEW)).catch((e: unknown) => e)) as ApiError;
      expect(err.code).toBe("NOT_ACCEPTED");
      expect(err.message).toContain(`port ${NEW}`);
      expect(err.message).toMatch(/pair again/i);
      expect(storage.data.pairing).toMatchObject({ port: OLD, token: TOKEN });
    }
  });

  it("keeps the old port when the answer is not the desktop app's (another program on that port)", async () => {
    for (const r of [{ status: 404, body: "<html>" }, { status: 200, body: { hello: "world" } }, { status: 500, body: { error: { code: "INTERNAL", message: "x" } } }]) {
      const storage = memoryStorage();
      paired(storage);
      const err = (await createApi({ fetch: fakeFetch(() => r).fn, storage }).changePort(String(NEW)).catch((e: unknown) => e)) as ApiError;
      expect(err.code, JSON.stringify(r)).toBe("BAD_REPLY");
      expect(err.message).toContain(`port ${OLD}`);
      expect(storage.data.pairing).toMatchObject({ port: OLD });
    }
  });

  it("refuses a bad port before contacting anything, and needs a pairing", async () => {
    const storage = memoryStorage();
    const { fn, calls } = fakeFetch(service);
    const api = createApi({ fetch: fn, storage });
    await expect(api.changePort(String(NEW))).rejects.toMatchObject({ code: "NOT_PAIRED" });
    paired(storage);
    for (const bad of ["", "0", "70000", "12a", "1.5", "-1"]) await expect(api.changePort(bad), bad).rejects.toMatchObject({ code: "BAD_PORT" });
    expect(calls).toHaveLength(0);
  });

  it("a check called off after the answer arrived but before the save saves nothing (review M1)", async () => {
    const storage = memoryStorage();
    paired(storage);
    const ac = new AbortController();
    let reads = 0;
    const get = storage.get.bind(storage);
    storage.get = async (key: string) => {
      // The second read is the one just before the save: the popup is closed at that moment.
      if (++reads === 2) ac.abort();
      return get(key);
    };
    const { fn } = fakeFetch(service);
    await expect(createApi({ fetch: fn, storage }).changePort(String(NEW), { signal: ac.signal })).rejects.toMatchObject({ code: "ABORTED" });
    expect(storage.data.pairing).toMatchObject({ port: OLD });
  });

  it("a check that is called off saves nothing", async () => {
    const storage = memoryStorage();
    paired(storage);
    const ac = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fn = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      await gate;
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = createApi({ fetch: fn, storage }).changePort(String(NEW), { signal: ac.signal });
    ac.abort();
    release();
    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
    expect(storage.data.pairing).toMatchObject({ port: OLD });
  });

  it("saves nothing when the pairing changed while the port was checked (unpaired meanwhile)", async () => {
    const storage = memoryStorage();
    paired(storage);
    const { fn } = fakeFetch((url) => {
      delete storage.data.pairing;
      return service(url);
    });
    await expect(createApi({ fetch: fn, storage }).changePort(String(NEW))).rejects.toMatchObject({ code: "CHANGED" });
    expect(storage.data.pairing).toBeUndefined();
  });
});

// Find and acquire, the browser's fallback (R348 f, i): the list and the file, with the token in the header only.
describe("the browser's fallback: the list and the file (R348 f)", () => {
  const TICKET = "0123456789abcdef0123456789abcdef";
  const PAGE = "https://pdfs.publisher.example/a.pdf?x=1";
  const pairedStorage = () => {
    const storage = memoryStorage();
    storage.data.pairing = { port: 48123, token: TOKEN, pairedAt: "" };
    return storage;
  };

  it("the list: POST /find/browser/waiting with exactly {} as JSON, the token in the header; the answer as it came", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: { waiting: [{ ticket: TICKET, label: "A work" }] } }));
    const api = createApi({ fetch: fn, storage: pairedStorage() });
    expect(await api.findWaiting()).toEqual({ waiting: [{ ticket: TICKET, label: "A work" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:48123/find/browser/waiting");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe("{}");
    expect(headerOf(calls[0]!.init, "content-type")).toBe("application/json");
    expect(headerOf(calls[0]!.init, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.init.credentials).toBe("omit");
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("the file: ONE POST /find/browser/file/<ticket>, Content-Type application/pdf, x-ao-page, the PDF as the body; the token only in the header", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: { outcome: "held", sentence: "Sent. The file waits for your check in the app's review queue." } }));
    const api = createApi({ fetch: fn, storage: pairedStorage() });
    const pdf = new Blob([new TextEncoder().encode("%PDF-1.7\n…")], { type: "application/pdf" });
    const r = await api.sendFindPdf(TICKET, PAGE, pdf);
    expect(r).toEqual({ outcome: "held", sentence: "Sent. The file waits for your check in the app's review queue." });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://127.0.0.1:48123/find/browser/file/${TICKET}`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(pdf);
    expect(headerOf(calls[0]!.init, "content-type")).toBe("application/pdf");
    expect(headerOf(calls[0]!.init, "x-ao-page")).toBe(PAGE);
    expect(headerOf(calls[0]!.init, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(calls[0]!.init.credentials).toBe("omit");
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("a ticket that is not 32 lower-case hex is never put in an address", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const api = createApi({ fetch: fn, storage: pairedStorage() });
    for (const bad of ["../projects", `${TICKET}?x`, TICKET.toUpperCase(), ""]) {
      await expect(api.sendFindPdf(bad, PAGE, new Blob([]))).rejects.toMatchObject({ code: "BAD_PATH" });
    }
    expect(calls).toEqual([]);
  });

  it("a refusal carries the service's sentence; 401 forgets the pairing", async () => {
    const storage = pairedStorage();
    let status = 400;
    const { fn } = fakeFetch(() => ({ status, body: { error: { code: "VALIDATION", message: "That tab's file is not a PDF. The work is still waiting.", reason: "browser-not-pdf" } } }));
    const api = createApi({ fetch: fn, storage });
    await expect(api.sendFindPdf(TICKET, PAGE, new Blob([]))).rejects.toMatchObject({ status: 400, message: "That tab's file is not a PDF. The work is still waiting.", serviceShaped: true });
    status = 401;
    await expect(api.sendFindPdf(TICKET, PAGE, new Blob([]))).rejects.toMatchObject({ status: 401 });
    expect(storage.data.pairing).toBeUndefined();
  });

  it("no answer at all (the connection closed): UNREACHABLE, no status", async () => {
    const fn = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const api = createApi({ fetch: fn, storage: pairedStorage() });
    const e = await api.sendFindPdf(TICKET, PAGE, new Blob([])).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ code: "UNREACHABLE" });
    expect((e as ApiError).status).toBeUndefined();
  });

  it("a stop asked through the signal: ABORTED", async () => {
    const fn = (async (_u: unknown, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("{}");
    }) as unknown as typeof fetch;
    const api = createApi({ fetch: fn, storage: pairedStorage() });
    const ac = new AbortController();
    ac.abort();
    await expect(api.findWaiting({ signal: ac.signal })).rejects.toMatchObject({ code: "ABORTED" });
  });
});
