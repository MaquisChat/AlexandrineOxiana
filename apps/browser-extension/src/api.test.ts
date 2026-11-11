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
