import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetch, getGlobalDispatcher, request } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useMemorySecrets } from "../../src/secrets-testing.js";
import { setSecret } from "../../src/secrets.js";
import type { ScanContext, ScanItem } from "../../src/import/bulk/index.js";
import { zoteroWebAdapter } from "../../src/import/zotero-web.js";
import { FakeZotero, KEY_MARKER, fakeZoteroHandler, guardNetwork, type FakeResponse } from "./fake-zotero.js";

const API = "https://api.zotero.org";
const U = "user:42";

// Guard: nothing in this file may reach the network, even through a forgotten dispatcher option.
let unguard: () => void;
beforeAll(() => {
  unguard = guardNetwork();
});
afterAll(() => unguard());

let z: FakeZotero;
beforeEach(() => {
  z = new FakeZotero();
});
afterEach(async () => {
  await z.agent.close();
});

interface Answer {
  status: number;
  headers: Record<string, string>;
  text: string;
  json(): any;
}

/** One GET to the stand-in through its MockAgent, with the key unless `key` is null. */
async function get(path: string, o: { key?: string | null; headers?: Record<string, string>; origin?: string } = {}): Promise<Answer> {
  const key = o.key === undefined ? z.key : o.key;
  const res = await request(new URL(path, o.origin ?? API), {
    method: "GET",
    headers: { "zotero-api-version": "3", ...(key ? { "zotero-api-key": key } : {}), ...o.headers },
    dispatcher: z.agent,
  });
  const text = await res.body.text();
  const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)]));
  return { status: res.statusCode, headers, text, json: () => JSON.parse(text) };
}

const article = (title: string, extra: Record<string, unknown> = {}) => ({ itemType: "journalArticle", title, ...extra });

describe("FakeZotero: versions and since", () => {
  it("since and format=versions list only later changes", async () => {
    const a = z.addItem(U, article("A"));
    const b = z.addItem(U, article("B"));
    const v = z.libraryVersion(U);
    expect(v).toBe(2);
    const all = await get("/users/42/items?format=versions");
    expect(all.status).toBe(200);
    expect(all.headers["last-modified-version"]).toBe("2");
    expect(all.json()).toEqual({ [a]: 1, [b]: 2 });

    z.editItem(U, a, { title: "A2" });
    const c = z.addItem(U, article("C"));
    const later = await get(`/users/42/items?format=versions&since=${v}`);
    expect(later.json()).toEqual({ [a]: 3, [c]: 4 });
    expect(later.headers["last-modified-version"]).toBe("4");

    const full = await get(`/users/42/items?since=${v}&include=data`);
    const rows = full.json() as Array<{ key: string; version: number; data: { title: string; version: number; key: string } }>;
    expect(rows.map((r) => r.key).sort()).toEqual([a, c].sort());
    expect(rows.find((r) => r.key === a)).toMatchObject({ version: 3, data: { title: "A2", version: 3, key: a } });

    const keys = await get(`/users/42/items?format=keys&since=${v}`);
    expect(keys.text.split("\n").sort()).toEqual([a, c].sort());
    // children carry their own versions; a child's change does not change its parent's version
    const att = z.addItem(U, { itemType: "attachment", linkMode: "linked_url", url: "https://example.org" }, { parent: a });
    expect((await get(`/users/42/items/${a}/children?format=versions`)).json()).toEqual({ [att]: 5 });
    expect((await get(`/users/42/items/${a}`)).json()).toMatchObject({ version: 3 });
  });

  it("pages with limit (at most 100), start and Total-Results, and links the next page", async () => {
    for (let i = 0; i < 130; i++) z.addItem(U, article(`Item ${i}`));
    const first = await get("/users/42/items?limit=500");
    expect(first.json()).toHaveLength(100);
    expect(first.headers["total-results"]).toBe("130");
    expect(first.headers["link"]).toContain('rel="next"');
    const second = await get("/users/42/items?limit=100&start=100");
    expect(second.json()).toHaveLength(30);
    expect(second.headers["link"] ?? "").not.toContain('rel="next"');
    const dflt = await get("/users/42/items");
    expect(dflt.json()).toHaveLength(25);
    const versions = await get("/users/42/items?format=versions");
    expect(Object.keys(versions.json())).toHaveLength(130); // versions is not limited
    expect((await get("/users/42/items?limit=0")).status).toBe(400);
  });

  it("generates 8-character keys in Zotero's alphabet from a counter, the same on every run", async () => {
    const keys = Array.from({ length: 50 }, (_, i) => z.addItem(U, article(`t${i}`)));
    expect(new Set(keys).size).toBe(50);
    for (const k of keys) expect(k).toMatch(/^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/u);
    const other = new FakeZotero();
    try {
      expect(other.addItem(U, article("t0"))).toBe(keys[0]);
    } finally {
      await other.agent.close();
    }
  });
});

describe("FakeZotero: conditional requests", () => {
  it("If-Modified-Since-Version answers 304 when nothing changed", async () => {
    z.addItem(U, article("A"));
    const v = z.libraryVersion(U);
    const quiet = await get("/users/42/items/top?limit=1&format=keys", { headers: { "if-modified-since-version": String(v) } });
    expect(quiet.status).toBe(304);
    expect(quiet.text).toBe("");
    expect(quiet.headers["last-modified-version"]).toBe(String(v));
    // library-wide: a change to a collection alone breaks it, for a request about items
    z.addCollection(U, "Shelf");
    const changed = await get("/users/42/items/top?limit=1&format=keys", { headers: { "if-modified-since-version": String(v) } });
    expect(changed.status).toBe(200);
    expect(changed.headers["last-modified-version"]).toBe(String(v + 1));
    // so does a deletion
    const k = z.addItem(U, article("B"));
    const v2 = z.libraryVersion(U);
    expect((await get("/users/42/items/top?format=keys", { headers: { "if-modified-since-version": String(v2) } })).status).toBe(304);
    z.remove(U, k);
    expect((await get("/users/42/items/top?format=keys", { headers: { "if-modified-since-version": String(v2) } })).status).toBe(200);
    // an older version always gets the data; a single object ignores the header
    expect((await get("/users/42/items?format=keys", { headers: { "if-modified-since-version": "0" } })).status).toBe(200);
    const only = z.addItem(U, article("C"));
    const cur = z.libraryVersion(U);
    expect((await get(`/users/42/items/${only}`, { headers: { "if-modified-since-version": String(cur) } })).status).toBe(200);
  });

  it("If-Unmodified-Since-Version answers 412 once the library has moved on", async () => {
    z.addItem(U, article("A"));
    const v = z.libraryVersion(U);
    expect((await get("/users/42/items", { headers: { "if-unmodified-since-version": String(v) } })).status).toBe(200);
    z.addItem(U, article("B"));
    const late = await get("/users/42/items", { headers: { "if-unmodified-since-version": String(v) } });
    expect(late.status).toBe(412);
    expect(late.headers["last-modified-version"]).toBe(String(v + 1));
  });
});

describe("FakeZotero: the bin and deletions", () => {
  it("trashed items appear only with includeTrashed=1", async () => {
    const a = z.addItem(U, article("Keep"));
    const b = z.addItem(U, article("Binned"));
    const child = z.addItem(U, { itemType: "note", note: "<p>x</p>" }, { parent: b });
    z.trash(U, b);
    const plain = (await get("/users/42/items")).json() as Array<{ key: string }>;
    expect(plain.map((r) => r.key)).not.toContain(b);
    expect(plain.map((r) => r.key)).toContain(a);
    expect((await get("/users/42/items?includeTrashed=0&format=keys")).text.split("\n")).not.toContain(b);
    const withBin = (await get("/users/42/items?includeTrashed=1")).json() as Array<{ key: string; version: number; data: Record<string, unknown> }>;
    const row = withBin.find((r) => r.key === b)!;
    expect(row.data.deleted).toBe(1);
    expect(row.version).toBe(4);
    expect(withBin.find((r) => r.key === a)!.data.deleted).toBeUndefined();
    expect(withBin.map((r) => r.key)).toContain(child);
    // top-level too, and /items/trash lists only the binned ones
    expect((await get("/users/42/items/top?format=keys")).text.split("\n")).not.toContain(b);
    expect((await get("/users/42/items/top?format=keys&includeTrashed=1")).text.split("\n")).toContain(b);
    expect((await get("/users/42/items/trash?format=keys")).text.split("\n")).toEqual([b]);
    // restoring moves it into the incremental window by its new version
    const since = z.libraryVersion(U);
    z.restore(U, b);
    const back = (await get(`/users/42/items?since=${since}`)).json() as Array<{ key: string; data: Record<string, unknown> }>;
    expect(back.map((r) => r.key)).toEqual([b]);
    expect(back[0]!.data.deleted).toBeUndefined();
    expect((await get("/users/42/items?includeTrashed=2")).status).toBe(400);
  });

  it("deleted keys appear in /deleted?since", async () => {
    const a = z.addItem(U, article("A"));
    const att = z.addItem(U, { itemType: "attachment", linkMode: "linked_url" }, { parent: a });
    const b = z.addItem(U, article("B"));
    const coll = z.addCollection(U, "Shelf");
    const v = z.libraryVersion(U);
    const empty = await get(`/users/42/deleted?since=${v}`);
    expect(empty.json()).toEqual({ collections: [], searches: [], items: [], tags: [] });
    expect(empty.headers["last-modified-version"]).toBe(String(v));
    z.remove(U, a); // takes its child with it
    z.removeCollection(U, coll);
    const after = (await get(`/users/42/deleted?since=${v}`)).json() as { items: string[]; collections: string[] };
    expect(after.items.sort()).toEqual([a, att].sort());
    expect(after.collections).toEqual([coll]);
    const v2 = z.libraryVersion(U);
    expect((await get(`/users/42/deleted?since=${v2}`)).json()).toMatchObject({ items: [], collections: [] });
    expect((await get("/users/42/items?format=keys")).text.split("\n")).toEqual([b]);
    expect((await get(`/users/42/items/${a}`)).status).toBe(404);
    // from the start, everything deleted so far
    expect(((await get("/users/42/deleted")).json() as { items: string[] }).items.sort()).toEqual([a, att].sort());
  });
});

describe("FakeZotero: keys and permissions", () => {
  it("a revoked key is 403 everywhere", async () => {
    z.addItem(U, article("A"));
    z.addGroup(7, "Reading group");
    for (const p of ["/keys/current", "/users/42/groups", "/users/42/items", "/users/42/collections", "/users/42/deleted", "/groups/7/items"]) {
      expect((await get(p)).status, p).toBe(200);
    }
    z.revokeKey();
    for (const p of ["/keys/current", "/users/42/groups", "/users/42/items", "/users/42/items/top", "/users/42/collections", "/users/42/deleted", "/users/42/settings/tagColors", "/groups/7/items"]) {
      expect((await get(p)).status, p).toBe(403);
    }
  });

  it("a missing or wrong key is 403; the key may also come as a Bearer token or a query parameter", async () => {
    expect((await get("/users/42/items", { key: null })).status).toBe(403);
    expect((await get("/users/42/items", { key: "WrongWrongWrongWrong0000" })).status).toBe(403);
    expect((await get("/users/42/items", { key: null, headers: { authorization: `Bearer ${z.key}` } })).status).toBe(200);
    expect((await get(`/users/42/items?key=${z.key}`, { key: null })).status).toBe(200);
  });

  it("/keys/current says what the key can do, and groups it cannot read are 403", async () => {
    z.addGroup(7, "Reading group");
    z.addGroup(8, "Closed group");
    const all = (await get("/keys/current")).json();
    expect(all).toMatchObject({ userID: 42, access: { user: { library: true, files: true, notes: true, write: false }, groups: { all: { library: true } } } });
    expect(((await get("/users/42/groups")).json() as Array<{ id: number; data: { name: string } }>).map((g) => [g.id, g.data.name])).toEqual([
      [7, "Reading group"],
      [8, "Closed group"],
    ]);
    z.setKeyAccess({ groups: { "7": { library: true, write: false }, "8": { library: false, write: false } } });
    expect((await get("/groups/7/items")).status).toBe(200);
    expect((await get("/groups/8/items")).status).toBe(403);
    expect((await get("/groups/99/items")).status).toBe(404);
    expect(((await get("/users/42/groups")).json() as Array<{ id: number }>).map((g) => g.id)).toEqual([7]);
    expect((await get("/keys/current")).json()).toMatchObject({ access: { groups: { "7": { library: true }, "8": { library: false } } } });
    z.setKeyAccess({ library: false });
    expect((await get("/users/42/items")).status).toBe(403);
    expect((await get("/groups/7/items")).status).toBe(200); // group access is its own
    expect((await get("/users/43/items")).status).toBe(403); // someone else's library
  });

  it("a key without notes does not see notes; a key without files cannot fetch them", async () => {
    const a = z.addItem(U, article("A"));
    z.addItem(U, { itemType: "note", note: "<p>n</p>" }, { parent: a });
    const f = z.addItem(U, { itemType: "attachment", linkMode: "imported_file", filename: "a.pdf", contentType: "application/pdf" }, { parent: a, file: { bytes: Buffer.from("pdf") } });
    z.setKeyAccess({ notes: false, files: false });
    const kids = (await get(`/users/42/items/${a}/children`)).json() as Array<{ data: { itemType: string } }>;
    expect(kids.map((k) => k.data.itemType)).toEqual(["attachment"]);
    expect((await get(`/users/42/items/${f}/file`)).status).toBe(403);
  });
});

describe("FakeZotero: back-off and failures", () => {
  it("Backoff is sent once, then not", async () => {
    z.addItem(U, article("A"));
    z.backoffOnce(30);
    const first = await get("/users/42/items");
    expect(first.status).toBe(200);
    expect(first.headers["backoff"]).toBe("30");
    const second = await get("/users/42/items");
    expect(second.headers["backoff"]).toBeUndefined();
  });

  it("failNext answers the next n requests with the status and Retry-After, then recovers", async () => {
    z.addItem(U, article("A"));
    z.failNext(2, 429, 7);
    const a = await get("/users/42/items");
    expect([a.status, a.headers["retry-after"]]).toEqual([429, "7"]);
    expect((await get("/users/42/items")).status).toBe(429);
    expect((await get("/users/42/items")).status).toBe(200);
    z.failNext(1, 503);
    const c = await get("/users/42/items");
    expect([c.status, c.headers["retry-after"]]).toEqual([503, undefined]);
  });

  it("dropConnectionOnPage(n) breaks the connection of page n once", async () => {
    for (let i = 0; i < 150; i++) z.addItem(U, article(`Item ${i}`));
    z.dropConnectionOnPage(2);
    expect((await get("/users/42/items?limit=100&start=0")).status).toBe(200);
    await expect(get("/users/42/items?limit=100&start=100")).rejects.toThrow();
    expect((await get("/users/42/items?limit=100&start=100")).status).toBe(200);
  });
});

describe("FakeZotero: files", () => {
  const bytes = Buffer.from("%PDF-1.4 fake bytes");
  const md5 = createHash("md5").update(bytes).digest("hex");

  it("answers 302 to another host, then serves the bytes there without the key, with the MD5", async () => {
    const top = z.addItem(U, article("A"));
    const att = z.addItem(U, { itemType: "attachment", linkMode: "imported_file", filename: "a.pdf", contentType: "application/pdf" }, { parent: top, file: { bytes } });
    expect(((await get(`/users/42/items/${att}`)).json() as { data: { md5: string } }).data.md5).toBe(md5);
    const r = await get(`/users/42/items/${att}/file`);
    expect(r.status).toBe(302);
    const loc = new URL(r.headers["location"]!);
    expect(loc.protocol).toBe("https:");
    expect(loc.hostname).toBe("zoterofilestorage.s3.amazonaws.com");
    expect(loc.pathname).toMatch(/^\/zoterofilestorage\/[0-9a-f]{32}$/u);
    const file = await get(loc.pathname + loc.search, { key: null, origin: loc.origin });
    expect(file.status).toBe(200);
    expect(file.text).toBe(bytes.toString());
    expect(file.headers["etag"]).toContain(md5);
    // the storage request carried no key, and the API host does not serve storage paths
    const storage = z.requests.find((q) => q.path.startsWith("/zoterofilestorage/"))!;
    expect(storage.headers["zotero-api-key"]).toBeUndefined();
    expect((await get(loc.pathname)).status).toBe(501);
  });

  it("redirectHost can be changed; WebDAV files and attachments without a file answer 404", async () => {
    const att = z.addItem(U, { itemType: "attachment", linkMode: "imported_file", filename: "a.pdf" }, { file: { bytes } });
    z.redirectHost = "evil.example.com";
    const r = await get(`/users/42/items/${att}/file`);
    expect(new URL(r.headers["location"]!).hostname).toBe("evil.example.com");
    const there = await get(new URL(r.headers["location"]!).pathname, { key: null, origin: "https://evil.example.com" });
    expect(there.status).toBe(200);
    const dav = z.addItem(U, { itemType: "attachment", linkMode: "imported_file", filename: "d.pdf" }, { file: { bytes, storage: "webdav" } });
    expect((await get(`/users/42/items/${dav}/file`)).status).toBe(404);
    const linked = z.addItem(U, { itemType: "attachment", linkMode: "linked_url", url: "https://example.org" });
    expect((await get(`/users/42/items/${linked}/file`)).status).toBe(404);
    expect((await get("/users/42/items/ZZZZZZZZ/file")).status).toBe(404);
  });

  it("states the md5 it was given, even a wrong one, and marks compressed files", async () => {
    const wrong = z.addItem(U, { itemType: "attachment", linkMode: "imported_file", filename: "w.pdf" }, { file: { bytes, md5: "0".repeat(32) } });
    expect(((await get(`/users/42/items/${wrong}`)).json() as { data: { md5: string } }).data.md5).toBe("0".repeat(32));
    const zipped = z.addItem(U, { itemType: "attachment", linkMode: "imported_file", filename: "z.pdf" }, { file: { bytes, compressed: true } });
    const r = await get(`/users/42/items/${zipped}/file`);
    expect(r.headers["zotero-file-compressed"]).toBe("Yes");
    const loc = new URL(r.headers["location"]!);
    const body = await get(loc.pathname + loc.search, { key: null, origin: loc.origin });
    expect(body.text.startsWith("PK")).toBe(true);
  });
});

describe("FakeZotero: collections and settings", () => {
  it("serves collections (with since), and tag colours only once set", async () => {
    const top = z.addCollection(U, "Shelf");
    const sub = z.addCollection(U, "Drawer", top);
    const rows = (await get("/users/42/collections")).json() as Array<{ key: string; version: number; data: { name: string; parentCollection: string | false } }>;
    expect(rows.find((r) => r.key === sub)!.data).toMatchObject({ name: "Drawer", parentCollection: top });
    expect(rows.find((r) => r.key === top)!.data.parentCollection).toBe(false);
    expect(((await get("/users/42/collections?since=1")).json() as unknown[]).length).toBe(1);
    expect((await get("/users/42/settings/tagColors")).status).toBe(404);
    z.setTagColors(U, [{ name: "urgent", color: "#ff0000" }]);
    expect((await get("/users/42/settings/tagColors")).json()).toMatchObject({ value: [{ name: "urgent", color: "#ff0000" }] });
  });
});

describe("FakeZotero: containment", () => {
  it("any method but GET answers 405 and is recorded", async () => {
    z.addItem(U, article("A"));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await request(new URL("/users/42/items", API), { method, headers: { "zotero-api-key": z.key }, body: method === "DELETE" ? undefined : "{}", dispatcher: z.agent });
      await res.body.dump();
      expect(res.statusCode, method).toBe(405);
    }
    expect(z.requests.filter((q) => q.method !== "GET").map((q) => q.method)).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
    expect(z.libraryVersion(U)).toBe(1); // nothing was changed
  });

  it("an unknown path is an error, not a 200", async () => {
    const r = await get("/users/42/searches");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.text).toMatch(/not modelled by the stand-in/iu);
    expect((await get("/nowhere")).status).toBeGreaterThanOrEqual(400);
    expect((await get("/users/42/items?sort=title")).status).toBe(400);
    // and the real network stays shut: a host nobody mounted cannot be reached
    await expect(request(new URL("https://example.org/"), { dispatcher: z.agent })).rejects.toThrow();
  });

  it("the recorded requests never hold the key", async () => {
    z.addItem(U, article("A"));
    await get("/users/42/items");
    await get(`/users/42/items?key=${z.key}&format=keys`, { key: null });
    await get("/users/42/items", { key: null, headers: { authorization: `Bearer ${z.key}` } });
    await get("/users/42/items", { key: "SomeOtherWrongKey000000" });
    expect(z.requests.length).toBe(4);
    expect(JSON.stringify(z.requests)).not.toContain(z.key);
    expect(JSON.stringify(z.requests)).not.toContain("SomeOtherWrongKey000000");
    expect(z.requests[0]).toEqual({ method: "GET", path: "/users/42/items", headers: expect.objectContaining({ "zotero-api-key": KEY_MARKER }) });
    expect(z.requests[1]!.path).toBe(`/users/42/items?key=${KEY_MARKER}&format=keys`);
  });

  it("the pure handler answers the same without an agent", () => {
    z.addItem(U, article("A"));
    const h = fakeZoteroHandler(z);
    const ok = h({ method: "GET", path: "/users/42/items?format=keys", headers: { "Zotero-API-Key": z.key } });
    expect(ok.status).toBe(200);
    expect(ok.headers["last-modified-version"]).toBe("1");
    expect(h({ method: "POST", path: "/users/42/items", headers: {} }).status).toBe(405);
    expect(h({ method: "GET", path: "/users/42/items", headers: {} }).status).toBe(403);
    expect(h({ method: "GET", path: "/zoterofilestorage/nothing", headers: {} }).status).toBe(404);
  });
});

describe("the existing client against the stand-in", () => {
  let tmp: string;
  let secrets: ReturnType<typeof useMemorySecrets>;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ao-fakez-"));
    secrets = useMemorySecrets();
  });
  afterEach(async () => {
    secrets.restore();
    await rm(tmp, { recursive: true, force: true });
  });

  async function scan(opts: { since?: number } = {}): Promise<{ items: ScanItem[]; notes: string[] }> {
    await setSecret("zotero-api-key", z.key);
    const work = join(tmp, "work");
    await mkdir(work, { recursive: true, mode: 0o700 });
    const notes: string[] = [];
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {}, ...opts });
    const items: ScanItem[] = [];
    const ctx: ScanContext = { workDir: async () => work, note: (t) => notes.push(t) };
    for await (const i of a.scan(new AbortController().signal, ctx)) items.push(i);
    expect(a.scanResult().completed).toBe(true);
    return { items, notes };
  }

  it("the existing client can scan a library served by the stand-in", async () => {
    const coll = z.addCollection(U, "Lagos");
    const keys: string[] = [];
    for (let i = 0; i < 240; i++) keys.push(z.addItem(U, article(`Article ${i}`, { collections: i % 2 ? [coll] : [], tags: [{ tag: `t${i % 3}` }] })));
    // ten items with a child note each
    for (let i = 0; i < 10; i++) z.addItem(U, { itemType: "note", note: `<p>Note ${i}</p>` }, { parent: keys[i]! });
    // one item with a stored PDF
    const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
    const withFile = z.addItem(U, article("With a file"));
    z.addItem(U, { itemType: "attachment", linkMode: "imported_file", filename: "paper.pdf", contentType: "application/pdf" }, { parent: withFile, file: { bytes: pdf } });
    // one binned item, which a full scan must not bring in
    const binned = z.addItem(U, article("In the bin"));
    z.trash(U, binned);
    z.setTagColors(U, [{ name: "t1", color: "#336699" }]);

    const { items } = await scan();
    expect(items).toHaveLength(241); // 240 articles and the one with a file; the binned one is not brought in
    expect(items.some((i) => i.unreadable)).toBe(false);
    const byKey = new Map(items.map((i) => [i.key, i]));
    expect(byKey.has(`zotero:${binned}`)).toBe(false);
    const f = byKey.get(`zotero:${withFile}`)!;
    expect(f.files).toHaveLength(1);
    expect(f.files[0]!.bytes).toBe(pdf.length);
    expect(byKey.get(`zotero:${keys[0]!}`)!.annotations?.[0]).toMatchObject({ kind: "note" });
    expect(byKey.get(`zotero:${keys[1]!}`)).toMatchObject({ folderPath: ["Lagos"], tags: ["t1"], tagColors: { t1: "#336699" } });
    expect(byKey.get(`zotero:${keys[1]!}`)!.version?.id).toBe(`user:42/${keys[1]!}`);
    // every request the client made was a GET, and none carried the key into a recorded line
    expect(z.requests.every((q) => q.method === "GET")).toBe(true);
    expect(JSON.stringify(z.requests)).not.toContain(z.key);
    const file = z.requests.find((q) => q.path.startsWith("/zoterofilestorage/"))!;
    expect(file.headers["zotero-api-key"]).toBeUndefined();
    // paged: 100 per page
    expect(z.requests.filter((q) => q.path.startsWith("/users/42/items?") && q.path.includes("limit=100")).length).toBeGreaterThanOrEqual(3);
  });

  it("an incremental scan sees only what changed, and counts what was deleted", async () => {
    const a = z.addItem(U, article("A"));
    z.addItem(U, article("B"));
    const v = z.libraryVersion(U);
    z.editItem(U, a, { title: "A, revised" });
    const { items, notes } = await scan({ since: v });
    expect(items.map((i) => i.key)).toEqual([`zotero:${a}`]);
    expect(notes).toEqual([]);
    const v2 = z.libraryVersion(U);
    z.remove(U, a);
    const gone = await scan({ since: v2 });
    expect(gone.items).toEqual([]);
    expect(gone.notes.join(" ")).toMatch(/1 item was deleted in Zotero/u);
  });
});

describe("fix round 1: groups (I1, M8)", () => {
  it("lists public groups the key has no permission for, whose library still answers 403", async () => {
    z.addGroup(7, "Reading group");
    z.addGroup(8, "Closed private group");
    z.addGroup(9, "Open public group", { type: "PublicOpen" });
    z.addGroup(10, "Closed public group", { type: "PublicClosed" });
    z.setKeyAccess({ groups: {} });
    const rows = (await get("/users/42/groups")).json() as Array<{ id: number; data: { type: string; libraryReading: string } }>;
    expect(rows.map((g) => [g.id, g.data.type])).toEqual([
      [9, "PublicOpen"],
      [10, "PublicClosed"],
    ]);
    expect(rows[0]!.data.libraryReading).toBe("all");
    expect((await get("/groups/9/items")).status).toBe(403); // listed, but the key may not read it
    expect((await get("/groups/7/items")).status).toBe(403);
    z.setKeyAccess({ groups: "all" });
    expect(((await get("/users/42/groups")).json() as Array<{ id: number }>).map((g) => g.id)).toEqual([7, 8, 9, 10]);
  });

  it("renames and removes groups; the version moves; a removed group is 404", async () => {
    z.addGroup(7, "Old name");
    const v1 = ((await get("/users/42/groups")).json() as Array<{ version: number }>)[0]!.version;
    z.renameGroup(7, "New name");
    const g = ((await get("/users/42/groups")).json() as Array<{ version: number; data: { name: string; version: number } }>)[0]!;
    expect(g.data.name).toBe("New name");
    expect(g.version).toBeGreaterThan(v1);
    expect(g.data.version).toBe(g.version);
    expect((await get("/users/42/groups?format=versions")).json()).toEqual({ "7": g.version });
    z.removeGroup(7);
    expect((await get("/groups/7/items")).status).toBe(404);
    expect((await get("/users/42/groups")).json()).toEqual([]);
  });
});

describe("fix round 1: where the redirect points (I2)", () => {
  const bytes = Buffer.from("%PDF-1.4 redirect me");
  const add = (redirect?: string) => z.addItem(U, { itemType: "attachment", linkMode: "imported_file", filename: "a.pdf" }, { file: { bytes, ...(redirect ? { redirect } : {}) } });
  const locationOf = async (att: string) => (await get(`/users/42/items/${att}/file`)).headers["location"]!;

  it("defaults to the bucket host; the account's base can be path-style, another bucket, files.zotero.net or an unlisted host", async () => {
    const att = add();
    expect(await locationOf(att)).toMatch(/^https:\/\/zoterofilestorage\.s3\.amazonaws\.com\/zoterofilestorage\/[0-9a-f]{32}\?sig=x$/u);
    for (const base of ["https://s3.amazonaws.com/zoterofilestorage/", "https://s3.amazonaws.com/otherbucket/", "https://files.zotero.net/", "https://unlisted.example.net/files/"]) {
      z.redirectBase = base;
      const loc = new URL(await locationOf(att));
      expect(loc.href.startsWith(base)).toBe(true);
      const file = await get(loc.pathname + loc.search, { key: null, origin: loc.origin });
      expect([base, file.status, file.text]).toEqual([base, 200, bytes.toString()]);
    }
  });

  it("a single file can have its own redirect, and an http loopback origin is served by the agent and by the handler", async () => {
    const own = add("http://127.0.0.1:8123/blobs/");
    const other = add();
    expect((await locationOf(own)).startsWith("http://127.0.0.1:8123/blobs/")).toBe(true);
    expect((await locationOf(other)).startsWith("https://zoterofilestorage.s3.amazonaws.com/")).toBe(true);
    const loc = new URL(await locationOf(own));
    expect((await get(loc.pathname + loc.search, { key: null, origin: loc.origin })).text).toBe(bytes.toString());
    // the pure handler, one origin for both, finds storage by the configured path
    const h = fakeZoteroHandler(z);
    expect(h({ method: "GET", path: loc.pathname + loc.search, headers: {} })).toMatchObject({ status: 200 });
    z.redirectBase = "http://127.0.0.1:9000/zoterofilestorage/";
    const loc2 = new URL(await locationOf(other));
    expect(loc2.protocol).toBe("http:");
    expect(loc2.port).toBe("9000");
    expect(h({ method: "GET", path: loc2.pathname + loc2.search, headers: {} })).toMatchObject({ status: 200 });
    expect(h({ method: "GET", path: "/users/42/items?format=keys", headers: { "zotero-api-key": z.key } }).status).toBe(200);
  });
});

describe("fix round 1: WebDAV, both ways (I3)", () => {
  const bytes = Buffer.from("current file");
  const md5 = createHash("md5").update(bytes).digest("hex");

  it("a WebDAV attachment keeps its md5 and mtime and answers 404 on /file", async () => {
    const dav = z.addItem(U, { itemType: "attachment", linkMode: "imported_file", filename: "d.pdf" }, { file: { bytes, storage: "webdav" } });
    const data = ((await get(`/users/42/items/${dav}`)).json() as { data: { md5: string; mtime: number } }).data;
    expect(data.md5).toBe(md5);
    expect(typeof data.mtime).toBe("number");
    expect((await get(`/users/42/items/${dav}/file`)).status).toBe(404);
  });

  it("an older copy can be served whose bytes do not match the item's md5 (ETag of those bytes)", async () => {
    const old = Buffer.from("an older copy in Zotero storage");
    const att = z.addItem(U, { itemType: "attachment", linkMode: "imported_file", filename: "d.pdf" }, { file: { bytes, storage: "webdav", stale: old } });
    expect(((await get(`/users/42/items/${att}`)).json() as { data: { md5: string } }).data.md5).toBe(md5);
    const r = await get(`/users/42/items/${att}/file`);
    expect(r.status).toBe(302);
    const loc = new URL(r.headers["location"]!);
    const body = await get(loc.pathname + loc.search, { key: null, origin: loc.origin });
    expect(body.text).toBe(old.toString());
    expect(body.headers["etag"]).toBe(`"${createHash("md5").update(old).digest("hex")}"`);
    expect(body.headers["etag"]).not.toContain(md5);
  });
});

describe("fix round 1: one file or the storage host failing (I4)", () => {
  const bytes = Buffer.from("0123456789".repeat(20));
  const att = () => z.addItem(U, { itemType: "attachment", linkMode: "imported_file", filename: "a.pdf" }, { file: { bytes } });
  const fetchFile = async (k: string) => {
    const r = await get(`/users/42/items/${k}/file`);
    if (r.status !== 302) return { api: r.status };
    const loc = new URL(r.headers["location"]!);
    const f = await get(loc.pathname + loc.search, { key: null, origin: loc.origin });
    return { api: 302, storage: f.status, text: f.text };
  };

  it("fails one file on the API side (403, 404, 500) and leaves the others alone", async () => {
    const a = att();
    const b = att();
    for (const status of [403, 404, 500] as const) {
      z.failFile(U, a, { api: status });
      expect(await fetchFile(a)).toEqual({ api: status });
      expect(await fetchFile(b)).toMatchObject({ api: 302, storage: 200 });
    }
    z.failFile(U, a, null);
    expect(await fetchFile(a)).toMatchObject({ storage: 200 });
  });

  it("fails one file on the storage host (403, 404, 500), once when asked", async () => {
    const a = att();
    const b = att();
    for (const status of [403, 404, 500] as const) {
      z.failFile(U, a, { storage: status, times: 1 });
      expect(await fetchFile(a)).toMatchObject({ api: 302, storage: status });
      expect(await fetchFile(a)).toMatchObject({ storage: 200 }); // times: 1 has run out
      expect(await fetchFile(b)).toMatchObject({ storage: 200 });
    }
  });

  it("cuts a file in mid-body or drops the connection, for one file or the whole host", async () => {
    const a = att();
    const b = att();
    const via = async (k: string) => {
      const loc = new URL((await get(`/users/42/items/${k}/file`)).headers["location"]!);
      return get(loc.pathname + loc.search, { key: null, origin: loc.origin });
    };
    z.failFile(U, a, { storage: "cut" });
    await expect(via(a)).rejects.toThrow();
    expect((await via(b)).text).toBe(bytes.toString());
    z.failFile(U, a, { storage: "drop" });
    await expect(via(a)).rejects.toThrow();
    z.failFile(U, a, null);
    z.failStorage("cut");
    await expect(via(b)).rejects.toThrow();
    z.failStorage(500);
    expect((await via(b)).status).toBe(500);
    z.failStorage(null);
    expect((await via(b)).status).toBe(200);
    expect(await fetchFile(a)).toMatchObject({ api: 302, storage: 200 }); // the API side was never affected
  });

  it("cuts a JSON page in mid-body, and counts pages only on the path asked for", async () => {
    for (let i = 0; i < 150; i++) z.addItem(U, article(`Item ${i}`));
    z.dropConnectionOnPage(2, { mode: "midBody" });
    expect((await get("/users/42/items?limit=100&start=0")).status).toBe(200);
    await expect(get("/users/42/items?limit=100&start=100")).rejects.toThrow();
    expect((await get("/users/42/items?limit=100&start=100")).status).toBe(200);
    z.dropConnectionOnPage(1, { path: "/users/42/items/top" });
    expect((await get("/users/42/items?limit=100")).status).toBe(200); // a different path
    await expect(get("/users/42/items/top?limit=100")).rejects.toThrow();
  });
});

describe("fix round 1: If-Unmodified-Since-Version on reads (M2)", () => {
  it("can be ignored; the existing client still restarts through Last-Modified-Version", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ao-fakez-"));
    const secrets = useMemorySecrets();
    try {
      await setSecret("zotero-api-key", z.key);
      z.honourIfUnmodifiedSince = false;
      const keys = Array.from({ length: 250 }, (_, i) => z.addItem(U, article(`Article ${i}`)));
      expect((await get("/users/42/items", { headers: { "if-unmodified-since-version": "0" } })).status).toBe(200);
      let edited = false;
      z.backoffOnce(1); // after page 1 the client calls sleep(): the library changes there
      const work = join(tmp, "work");
      await mkdir(work, { recursive: true, mode: 0o700 });
      const a = zoteroWebAdapter({
        libraryType: "user",
        libraryId: "42",
        dispatcher: z.agent,
        sleep: async () => {
          if (!edited) {
            edited = true;
            z.editItem(U, keys[0]!, { title: "Revised" });
          }
        },
      });
      const items: ScanItem[] = [];
      for await (const i of a.scan(new AbortController().signal, { workDir: async () => work })) items.push(i);
      expect(edited).toBe(true);
      expect(a.scanResult().completed).toBe(true);
      expect(new Set(items.map((i) => i.key)).size).toBe(250);
      expect(JSON.stringify(items.find((i) => i.key === `zotero:${keys[0]!}`)!.referenceMetadata)).toContain("Revised");
      expect(z.requests.filter((q) => q.path.includes("start=0")).length).toBeGreaterThanOrEqual(2); // it restarted
      expect(a.scanResult().libraryVersion).toBe(z.libraryVersion(U));
    } finally {
      secrets.restore();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("fix round 1: the key never leaks (M5, M6, M7) and what is not modelled (M4, M9)", () => {
  it("a path holding the key is redacted in the log and in the error body", async () => {
    const r = await get(`/keys/${z.key}`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.text).not.toContain(z.key);
    expect(JSON.stringify(z.requests)).not.toContain(z.key);
    expect(z.requests[0]!.path).toBe(`/keys/${KEY_MARKER}`);
    const bad = await get(`/users/42/items?q=${z.key}`);
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain(z.key);
    expect(bad.text).toMatch(/not modelled by the stand-in/u);
  });

  it("an unmounted host with the key in its URL fails without the key in the message or stack", async () => {
    let err: unknown;
    try {
      await request(new URL(`https://example.org/x?key=${z.key}`), { dispatcher: z.agent });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(z.key);
    expect(String((err as Error).stack)).not.toContain(z.key);
  });

  it("guardNetwork refuses a request that bypasses the stand-in, and puts the old dispatcher back", async () => {
    const before = getGlobalDispatcher();
    const restore = guardNetwork();
    try {
      const during = getGlobalDispatcher();
      expect(during).not.toBe(before);
      // The mock agent's own refusal, not a DNS or connection error: a broken guard would fail with another code.
      await expect(request(new URL("https://nowhere.invalid/x"))).rejects.toMatchObject({ code: "UND_MOCK_ERR_MOCK_NOT_MATCHED" });
    } finally {
      restore();
    }
    expect(getGlobalDispatcher()).toBe(before);
  });

  it("numChildren does not count notes the key cannot see", async () => {
    const a = z.addItem(U, article("A"));
    z.addItem(U, { itemType: "note", note: "<p>n</p>" }, { parent: a });
    z.setKeyAccess({ notes: false });
    expect(((await get(`/users/42/items/${a}`)).json() as { meta: Record<string, unknown> }).meta.numChildren).toBeUndefined();
  });
});

describe("fix round 2: errors are never mutated (I5), and the smaller findings", () => {
  const bytes = Buffer.from("0123456789".repeat(20));
  const att = () => z.addItem(U, { itemType: "attachment", linkMode: "imported_file", filename: "a.pdf" }, { file: { bytes } });
  const text = (e: unknown) => `${(e as Error).name} ${(e as Error).message} ${(e as Error).stack ?? ""} ${String((e as { cause?: unknown }).cause ?? "")}`;

  it("an aborted request rejects with an AbortError, as undici does without the stand-in", async () => {
    z.addItem(U, article("A"));
    const ac = new AbortController();
    ac.abort();
    let err: any;
    try {
      await request(new URL("/users/42/items", API), { headers: { "zotero-api-key": z.key }, signal: ac.signal, dispatcher: z.agent });
    } catch (e) {
      err = e;
    }
    expect(err?.name).toBe("AbortError");
    expect(text(err)).not.toContain(z.key);
  });

  it("undici fetch follows the 302 to the storage host and gets the bytes", async () => {
    const k = att();
    const res = await fetch(new URL(`/users/42/items/${k}/file`, API), { headers: { "zotero-api-key": z.key }, redirect: "follow", dispatcher: z.agent });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(bytes.toString());
  });

  it("fetch of a cut file rejects promptly with a network error and no key", async () => {
    const k = att();
    z.failFile(U, k, { storage: "cut" });
    // (fetch with redirect "follow" that is cut AFTER the redirect never settles under a mock: a known limit, see the stand-in's agent)
    const first = await fetch(new URL(`/users/42/items/${k}/file`, API), { headers: { "zotero-api-key": z.key }, redirect: "manual", dispatcher: z.agent });
    const location = first.headers.get("location")!;
    const t0 = Date.now();
    let err: unknown;
    try {
      const res = await fetch(location, { dispatcher: z.agent });
      await res.arrayBuffer();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(text(err)).not.toContain(z.key);
  });

  it("a request to an unmounted host with the key in its URL keeps the error's name and code, and not the key", async () => {
    let err: any;
    try {
      await request(new URL(`https://example.org/x?key=${z.key}`), { dispatcher: z.agent });
    } catch (e) {
      err = e;
    }
    expect(err.name).toBe("MockNotMatchedError");
    expect(err.code).toBe("UND_MOCK_ERR_MOCK_NOT_MATCHED");
    expect(text(err)).not.toContain(z.key);
    // fetch wraps it; its cause must not carry the key either
    let ferr: any;
    try {
      await fetch(new URL(`https://example.org/x?key=${z.key}`), { dispatcher: z.agent });
    } catch (e) {
      ferr = e;
    }
    expect(ferr).toBeInstanceOf(Error);
    expect(text(ferr)).not.toContain(z.key);
    expect(text(ferr.cause)).not.toContain(z.key);
  });

  it("a percent-encoded key in a path is not recorded either", async () => {
    await get(`/keys/${[...z.key].map((c) => "%" + c.charCodeAt(0).toString(16)).join("")}`);
    expect(JSON.stringify(z.requests)).not.toContain(z.key);
    expect(z.requests[0]!.path).toContain(KEY_MARKER);
  });

  it("a public group can be readable by anyone, with no key at all; the default stays 403", async () => {
    z.addGroup(9, "Open public group", { type: "PublicOpen", publicRead: true });
    z.addGroup(10, "Open but key-only", { type: "PublicOpen" });
    z.setKeyAccess({ groups: {} });
    expect((await get("/groups/9/items", { key: null })).status).toBe(200);
    expect((await get("/groups/9/items")).status).toBe(200); // a key without permission may read it too
    expect((await get("/groups/10/items", { key: null })).status).toBe(403);
    expect((await get("/groups/10/items")).status).toBe(403);
    expect((await get("/users/42/items", { key: null })).status).toBe(403); // the personal library never
  });

  it("the handler's answer is a FakeResponse (cut included) and storage cannot share the API origin", async () => {
    const k = att();
    z.failFile(U, k, { storage: "cut" });
    const h = fakeZoteroHandler(z);
    const loc = new URL((await get(`/users/42/items/${k}/file`)).headers["location"]!);
    const r: FakeResponse = h({ method: "GET", path: loc.pathname, headers: {} });
    expect(r.cut).toBe(true);
    expect(() => {
      z.redirectBase = "https://api.zotero.org/files/";
    }).toThrow(/API origin/u);
  });
});
