import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SourceFile } from "@ao/core";
import { buildCameraTiff, buildPdf, buildZip } from "../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { shutdownExtractors } from "../extract/index.js";
import { IndexHandle } from "../index/db.js";
import { createIndexSink } from "../index/sink.js";
import { createLibrary, type Library } from "../library.js";
import { HttpClient } from "../lookup/index.js";
import type { Repo } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import { SECRET_STORE_UNAVAILABLE, getSecret, setSecret } from "../secrets.js";
import { useMemorySecrets, useNoSecretStore } from "../secrets-testing.js";
import { BatchRefusedError, createBulkImport, type ScanContext, type ScanItem } from "./bulk/index.js";
import { LOCATION_REASON } from "./common.js";
import {
  ZOTERO_STORAGE_HOSTS,
  ZOTERO_WEB_FILE_NOTES,
  ZOTERO_WEB_REASONS,
  splitDownloadPath,
  startZoteroWebImport,
  zoteroWebAdapter,
  zoteroWebSince,
  type ZoteroWebOptions,
} from "./zotero-web.js";

const FAST = 2 ** 10;
const KEY = "AbCdEfGh0123456789zyxwvu";
const API = "https://api.zotero.org";
const STORAGE = `https://${ZOTERO_STORAGE_HOSTS[0]}`;
const JSON_HEADERS = { "content-type": "application/json" };

let tmp: string;
let agent: MockAgent;
let secrets: ReturnType<typeof useMemorySecrets>;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-zweb-"));
  agent = new MockAgent();
  agent.disableNetConnect();
  secrets = useMemorySecrets();
  await setSecret("zotero-api-key", KEY);
});

afterEach(async () => {
  vi.useRealTimers();
  secrets.restore();
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

// Guard: nothing in this suite may reach the network, even through a forgotten dispatcher option.
let previousDispatcher: Dispatcher;
const guard = new MockAgent();
guard.disableNetConnect();
beforeAll(() => {
  previousDispatcher = getGlobalDispatcher();
  setGlobalDispatcher(guard);
});

afterAll(async () => {
  setGlobalDispatcher(previousDispatcher);
  await guard.close();
  await shutdownExtractors();
});

interface WebItem {
  key: string;
  version: number;
  data: Record<string, unknown>;
}

const article = (key: string, title: string, version = 5, extra: Record<string, unknown> = {}): WebItem => ({
  key,
  version,
  data: {
    key,
    version,
    itemType: "journalArticle",
    title,
    creators: [
      { creatorType: "author", firstName: "Ngozi", lastName: "Okafor" },
      { creatorType: "editor", name: "Lagos Research Group" },
    ],
    date: "2024-03-15",
    publicationTitle: "Urban Studies",
    DOI: "10.5555/ao.web.2024.001",
    tags: [{ tag: "markets" }, { tag: "lagos", type: 1 }],
    collections: [],
    relations: {},
    dateAdded: "2024-01-02T10:00:00Z",
    dateModified: "2024-01-03T10:00:00Z",
    ...extra,
  },
});

const page = (path: string) => new URL(path, API).searchParams;

/** Serves `/users/42/items` (paged by start/limit) from `items`, with the library version header. */
function serveItems(
  items: WebItem[],
  libraryVersion: number,
  opts: { prefix?: string; times?: number; headers?: Record<string, string>; log?: string[]; sent?: Array<Record<string, string>> } = {},
) {
  const prefix = opts.prefix ?? "/users/42";
  agent
    .get(API)
    .intercept({ path: (p) => p.startsWith(`${prefix}/items?`) && !page(p).has("since") && !page(p).has("itemKey"), method: "GET" })
    .reply((req) => {
      const q = page(req.path);
      opts.log?.push(req.path);
      opts.sent?.push(Object.fromEntries(Object.entries(req.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)])));
      const start = Number(q.get("start") ?? 0);
      const limit = Number(q.get("limit") ?? 25);
      return {
        statusCode: 200,
        data: JSON.stringify(items.slice(start, start + limit)),
        responseOptions: { headers: { ...JSON_HEADERS, "total-results": String(items.length), "last-modified-version": String(libraryVersion), ...(opts.headers ?? {}) } },
      };
    })
    .times(opts.times ?? 10);
}

function serveCollections(collections: Array<{ key: string; name: string; parentCollection?: string | false }>, prefix = "/users/42") {
  agent
    .get(API)
    .intercept({ path: (p) => p.startsWith(`${prefix}/collections?`), method: "GET" })
    .reply(200, JSON.stringify(collections.map((c) => ({ key: c.key, version: 1, data: { key: c.key, name: c.name, parentCollection: c.parentCollection ?? false } }))), {
      headers: { ...JSON_HEADERS, "total-results": String(collections.length) },
    })
    .persist();
}

function serveTagColors(prefix = "/users/42") {
  agent.get(API).intercept({ path: `${prefix}/settings/tagColors`, method: "GET" }).reply(404, "Not found").persist();
}

async function collect(opts: Partial<ZoteroWebOptions> = {}, ctx?: Partial<ScanContext>): Promise<{ items: ScanItem[]; notes: string[] }> {
  const work = join(tmp, "work");
  await mkdir(work, { recursive: true, mode: 0o700 });
  const notes: string[] = [];
  const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: agent, sleep: async () => {}, ...opts });
  const items: ScanItem[] = [];
  for await (const i of a.scan(new AbortController().signal, { workDir: async () => work, note: (t) => notes.push(t), ...ctx })) items.push(i);
  return { items, notes };
}

describe("secrets", () => {
  it("keeps the key in the (test) keyring only; no keyring → a plain refusal, never a plaintext fallback", async () => {
    expect(await getSecret("zotero-api-key")).toBe(KEY);
    expect(secrets.values.get("zotero-api-key")).toBe(KEY);
    const none = useNoSecretStore();
    try {
      await expect(setSecret("zotero-api-key", "other")).rejects.toThrow(SECRET_STORE_UNAVAILABLE);
      await expect(getSecret("zotero-api-key")).rejects.toThrow(SECRET_STORE_UNAVAILABLE);
    } finally {
      none.restore();
    }
    // @ts-expect-error unknown names are refused
    await expect(getSecret("something-else")).rejects.toThrow(TypeError);
  });
});

describe("download paths (R82)", () => {
  it("splits Windows paths with the platform's path rules, not on '/'", async () => {
    const { win32, posix } = await import("node:path");
    expect(splitDownloadPath("C:\\Users\\me\\Lib\\.tmp\\batch-1\\zotero-web\\ABCD1234\\paper.pdf", win32)).toEqual({
      dir: "C:\\Users\\me\\Lib\\.tmp\\batch-1\\zotero-web\\ABCD1234",
      name: "paper.pdf",
    });
    expect(splitDownloadPath("/lib/.tmp/zotero-web/K/a.pdf", posix)).toEqual({ dir: "/lib/.tmp/zotero-web/K", name: "a.pdf" });
  });
});

describe("zoteroWebAdapter", () => {
  it("validates the library and builds an https api.zotero.org location without the key", () => {
    expect(() => zoteroWebAdapter({ libraryType: "user", libraryId: "42/../x" })).toThrow(TypeError);
    // @ts-expect-error only user or group
    expect(() => zoteroWebAdapter({ libraryType: "org", libraryId: "1" })).toThrow(TypeError);
    const a = zoteroWebAdapter({ libraryType: "group", libraryId: "777" });
    expect(a.kind).toBe("zotero-web");
    expect(a.location).toBe("group:777");
    expect(a.incremental).toBe(true);
    expect(JSON.stringify(a)).not.toContain(KEY);
  });

  it("paginates 150 items across 2 pages with limit=100, sending the key and API version", async () => {
    const items = Array.from({ length: 150 }, (_, i) => article(`ITEM${String(i).padStart(4, "0")}`, `Item ${i}`));
    const log: string[] = [];
    const seen: Array<Record<string, string>> = [];
    serveItems(items, 900, { log, sent: seen });
    serveCollections([]);
    serveTagColors();
    const { items: out } = await collect();
    expect(out).toHaveLength(150);
    expect(log.map((p) => page(p).get("start"))).toEqual(["0", "100"]);
    expect(log.every((p) => page(p).get("limit") === "100" && page(p).get("format") === "json" && page(p).get("include") === "data")).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((h) => h["zotero-api-key"] === KEY && h["zotero-api-version"] === "3")).toBe(true);
    expect(out[0]).toMatchObject({
      key: "zotero:ITEM0000",
      referenceSource: { kind: "zotero", provider: "zotero-web" },
      externalKeys: expect.objectContaining({ zoteroKey: "ITEM0000", zoteroVersion: "5", libraryId: "user:42" }),
      version: { id: "user:42/ITEM0000", version: expect.any(String) },
      tags: ["markets", "lagos"],
    });
    expect(out[0]!.referenceMetadata).toMatchObject({
      type: "article-journal",
      issued: "2024-03-15",
      identifiers: { doi: "10.5555/ao.web.2024.001" },
      creators: [
        { family: "Okafor", given: "Ngozi", role: "author" },
        { literal: "Lagos Research Group", role: "editor" },
      ],
    });
  });

  it("honours Backoff: waits the given seconds before the next request (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const items = Array.from({ length: 150 }, (_, i) => article(`BACK${String(i).padStart(4, "0")}`, `Item ${i}`));
    const log: string[] = [];
    serveItems(items, 900, { log, headers: { backoff: "2" } });
    serveCollections([]);
    serveTagColors();
    const work = join(tmp, "work");
    await mkdir(work, { recursive: true });
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: agent }); // real (faked) sleep
    const out: ScanItem[] = [];
    const run = (async () => {
      for await (const i of a.scan(new AbortController().signal, { workDir: async () => work })) out.push(i);
    })();
    // First page served; the second waits for the Backoff period.
    await vi.waitFor(() => expect(log).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1900);
    expect(log).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(log).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(out).toHaveLength(150);
  });

  it("retries 429 and 5xx, honouring Retry-After (capped)", async () => {
    const waits: number[] = [];
    agent.get(API).intercept({ path: (p) => p.startsWith("/users/42/items?"), method: "GET" }).reply(429, "slow down", { headers: { "retry-after": "5" } });
    agent.get(API).intercept({ path: (p) => p.startsWith("/users/42/items?"), method: "GET" }).reply(503, "busy", { headers: { "retry-after": "99999" } });
    agent.get(API).intercept({ path: (p) => p.startsWith("/users/42/items?"), method: "GET" }).reply(502, "bad gateway");
    serveItems([article("RETRY001", "Retried")], 3);
    serveCollections([]);
    serveTagColors();
    const { items } = await collect({ sleep: async (ms) => void waits.push(ms), maxWaitMs: 60_000 });
    expect(items.map((i) => i.key)).toEqual(["zotero:RETRY001"]);
    expect(waits.slice(0, 2)).toEqual([5000, 60_000]);
    expect(waits).toHaveLength(3);
  });

  it("a refused key or a missing library is one unreadable item with a plain reason (never the key)", async () => {
    agent.get(API).intercept({ path: (p) => p.startsWith("/users/42/"), method: "GET" }).reply(403, `Invalid key ${KEY}`).persist();
    const { items } = await collect();
    expect(items).toEqual([{ key: "zotero-web:", files: [], unreadable: ZOTERO_WEB_REASONS.keyRefused }]);
    expect(JSON.stringify(items)).not.toContain(KEY);
  });

  it("no keyring → a plain refusal; no key saved → a plain refusal", async () => {
    const none = useNoSecretStore();
    try {
      expect((await collect()).items).toEqual([{ key: "zotero-web:", files: [], unreadable: ZOTERO_WEB_REASONS.noStore }]);
    } finally {
      none.restore();
    }
    secrets.restore();
    secrets = useMemorySecrets();
    expect((await collect()).items).toEqual([{ key: "zotero-web:", files: [], unreadable: ZOTERO_WEB_REASONS.noKey }]);
  });

  it("caps JSON pages (10 MB default; smaller here)", async () => {
    serveItems([article("BIG00001", "x".repeat(5000))], 3);
    serveCollections([]);
    serveTagColors();
    const { items } = await collect({ maxPageBytes: 2000 });
    expect(items).toEqual([{ key: "zotero-web:", files: [], unreadable: ZOTERO_WEB_REASONS.tooLarge }]);
  });

  it("maps collections, notes, attachments (downloaded through the storage redirect) and annotations like the local import", async () => {
    const pdf = await buildPdf({ extra: "web pdf" });
    const md5 = createHash("md5").update(pdf).digest("hex");
    const items: WebItem[] = [
      article("PARENT01", "Feeding the City", 7, { collections: ["COLLB000"], citationKey: "okafor2024feeding" }),
      { key: "ATTACH01", version: 7, data: { key: "ATTACH01", version: 7, itemType: "attachment", parentItem: "PARENT01", linkMode: "imported_file", contentType: "application/pdf", filename: "okafor.pdf", md5, tags: [] } },
      { key: "SNAPSH01", version: 7, data: { key: "SNAPSH01", version: 7, itemType: "attachment", parentItem: "PARENT01", linkMode: "imported_url", contentType: "text/html", filename: "page.html", tags: [] } },
      { key: "LINKURL1", version: 7, data: { key: "LINKURL1", version: 7, itemType: "attachment", parentItem: "PARENT01", linkMode: "linked_url", url: "https://example.org", tags: [] } },
      { key: "NOTE0001", version: 7, data: { key: "NOTE0001", version: 7, itemType: "note", parentItem: "PARENT01", note: "<h1>Reading notes</h1><p>Read <a href=\"https://example.org/lagos\">the dataset</a><script>alert(1)</script></p>", dateAdded: "2024-02-01T09:00:00Z", tags: [] } },
      {
        key: "ANNO0001",
        version: 7,
        data: {
          key: "ANNO0001", version: 7, itemType: "annotation", parentItem: "ATTACH01", annotationType: "highlight", annotationText: "informal markets",
          annotationComment: "key claim", annotationColor: "#ffd400", annotationPageLabel: "1", annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[10, 20, 110, 40]] }),
          dateAdded: "2024-02-02T09:00:00Z", tags: [],
        },
      },
      { key: "ALONE001", version: 2, data: { key: "ALONE001", version: 2, itemType: "note", note: "<p>standalone</p>", tags: [] } },
    ];
    serveItems(items, 30);
    serveCollections([
      { key: "COLLA000", name: "Fieldwork" },
      { key: "COLLB000", name: "Lagos", parentCollection: "COLLA000" },
    ]);
    agent.get(API).intercept({ path: "/users/42/settings/tagColors", method: "GET" }).reply(200, JSON.stringify({ value: [{ name: "markets", color: "#FF6666" }], version: 3 }), { headers: JSON_HEADERS });
    agent.get(API).intercept({ path: "/users/42/items/ATTACH01/file", method: "GET" }).reply(302, "", { headers: { location: `${STORAGE}/signed/abc?sig=1` } });
    const storageRequests: Array<Record<string, string>> = [];
    agent
      .get(STORAGE)
      .intercept({ path: "/signed/abc?sig=1", method: "GET" })
      .reply((req) => {
        storageRequests.push(req.headers as Record<string, string>);
        return { statusCode: 200, data: pdf, responseOptions: { headers: { "content-type": "application/pdf", "content-length": String(pdf.length) } } };
      });
    const { items: out, notes } = await collect();
    expect(out).toHaveLength(1);
    const it0 = out[0]!;
    expect(it0.folderPath).toEqual(["Fieldwork", "Lagos"]);
    expect(it0.tagColors).toEqual({ markets: "#FF6666" });
    expect(it0.referenceMetadata?.citationKey).toBe("okafor2024feeding");
    expect(it0.files).toHaveLength(1);
    expect(it0.files[0]!.mime).toBe("application/pdf");
    expect(createHash("md5").update(await readFile(it0.files[0]!.path)).digest("hex")).toBe(md5);
    expect(it0.files[0]!.path.startsWith(join(tmp, "work"))).toBe(true);
    // The key goes to api.zotero.org only, never to the storage host.
    expect(JSON.stringify(storageRequests)).not.toContain(KEY);
    const note = it0.annotations!.find((a) => a.key === "zotero:NOTE0001")!;
    expect(note.kind).toBe("note");
    expect(note.body).toContain("# Reading notes");
    expect(note.body).not.toContain("alert");
    expect(it0.annotations!.find((a) => a.key === "zotero:ANNO0001")).toMatchObject({
      kind: "highlight", quote: "informal markets", body: "key claim", color: "#ffd400", file: it0.files[0]!.path,
      anchor: { kind: "pdf", page: 1, rects: [{ x: 10, y: 20, w: 100, h: 20 }] },
    });
    expect(notes.join(" ")).toMatch(/1 standalone note/);
    expect(notes.join(" ")).toMatch(/1 linked URL/);
    expect(notes.join(" ")).toMatch(/1 web page snapshot/);
  });

  it("refuses a file redirect to a host that is not Zotero's storage (no request is made there)", async () => {
    serveItems(
      [
        article("PARENT02", "Redirected"),
        { key: "ATTACH02", version: 5, data: { key: "ATTACH02", version: 5, itemType: "attachment", parentItem: "PARENT02", linkMode: "imported_file", contentType: "application/pdf", filename: "x.pdf", tags: [] } },
      ],
      8,
    );
    serveCollections([]);
    serveTagColors();
    agent.get(API).intercept({ path: "/users/42/items/ATTACH02/file", method: "GET" }).reply(302, "", { headers: { location: "https://evil.example.com/steal" } });
    const evil = vi.fn(() => ({ statusCode: 200, data: "x" }));
    agent.get("https://evil.example.com").intercept({ path: "/steal", method: "GET" }).reply(evil);
    // http (not https) to an allowed host is refused too.
    const { items } = await collect();
    expect(items[0]!.files).toEqual([]);
    expect(items[0]!.fileNotes).toEqual([ZOTERO_WEB_FILE_NOTES.redirectRefused]);
    expect(evil).not.toHaveBeenCalled();
  });

  it("refuses a plain-http redirect even to a storage host, and caps a file's size", async () => {
    serveItems(
      [
        article("PARENT03", "Plain"),
        { key: "ATTACH03", version: 5, data: { key: "ATTACH03", version: 5, itemType: "attachment", parentItem: "PARENT03", linkMode: "imported_file", contentType: "application/pdf", filename: "x.pdf", tags: [] } },
        article("PARENT04", "Huge"),
        { key: "ATTACH04", version: 5, data: { key: "ATTACH04", version: 5, itemType: "attachment", parentItem: "PARENT04", linkMode: "imported_file", contentType: "application/pdf", filename: "y.pdf", tags: [] } },
      ],
      8,
    );
    serveCollections([]);
    serveTagColors();
    agent.get(API).intercept({ path: "/users/42/items/ATTACH03/file", method: "GET" }).reply(302, "", { headers: { location: `http://${ZOTERO_STORAGE_HOSTS[0]}/x` } });
    agent.get(API).intercept({ path: "/users/42/items/ATTACH04/file", method: "GET" }).reply(302, "", { headers: { location: `${STORAGE}/big` } });
    agent.get(STORAGE).intercept({ path: "/big", method: "GET" }).reply(200, Buffer.alloc(5000, 1));
    const { items } = await collect({ maxFileBytes: 1000 });
    expect(items.find((i) => i.key === "zotero:PARENT03")!.fileNotes).toEqual([ZOTERO_WEB_FILE_NOTES.redirectRefused]);
    expect(items.find((i) => i.key === "zotero:PARENT04")!.fileNotes).toEqual([ZOTERO_WEB_FILE_NOTES.tooLarge]);
    expect(await readdir(join(tmp, "work"), { recursive: true }).then((l) => l.filter((n) => n.endsWith(".pdf")))).toEqual([]);
  });

  it("incremental: a changed annotation brings in its whole item (parents fetched by key, children listed)", async () => {
    const parent = article("PARENT06", "Changed below", 4);
    const att: WebItem = { key: "ATTACH06", version: 4, data: { key: "ATTACH06", version: 4, itemType: "attachment", parentItem: "PARENT06", linkMode: "imported_file", contentType: "application/pdf", filename: "z.pdf", tags: [] } };
    const ann: WebItem = {
      key: "ANNO0006", version: 21,
      data: { key: "ANNO0006", version: 21, itemType: "annotation", parentItem: "ATTACH06", annotationType: "underline", annotationText: "new", annotationPosition: JSON.stringify({ pageIndex: 2, rects: [[1, 2, 3, 4]] }), tags: [] },
    };
    const reply = (items: WebItem[], v = 21) => ({ statusCode: 200, data: JSON.stringify(items), responseOptions: { headers: { ...JSON_HEADERS, "total-results": String(items.length), "last-modified-version": String(v) } } });
    const seen: string[] = [];
    agent
      .get(API)
      .intercept({ path: (p) => p.startsWith("/users/42/"), method: "GET" })
      .reply((req) => {
        seen.push(req.path);
        const q = page(req.path);
        const path = req.path.split("?")[0]!;
        if (path === "/users/42/items" && q.get("since") === "20") return reply([ann]);
        if (path === "/users/42/items" && q.get("itemKey") === "ATTACH06") return reply([att]);
        if (path === "/users/42/items" && q.get("itemKey") === "PARENT06") return reply([parent]);
        if (path === "/users/42/items/PARENT06/children") return reply([att]);
        if (path === "/users/42/items/ATTACH06/children") return reply([ann]);
        if (path === "/users/42/items/ATTACH06/file") return { statusCode: 404, data: "Not found" };
        if (path === "/users/42/collections") return reply([]);
        if (path === "/users/42/deleted") return { statusCode: 200, data: JSON.stringify({ items: ["X1", "X2", "X3"] }), responseOptions: { headers: JSON_HEADERS } };
        return { statusCode: 404, data: "Not found" };
      })
      .persist();
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: agent, sleep: async () => {}, since: 20 });
    const out: ScanItem[] = [];
    const notes: string[] = [];
    const work = join(tmp, "work");
    await mkdir(work, { recursive: true });
    for await (const i of a.scan(new AbortController().signal, { workDir: async () => work, note: (t) => notes.push(t) })) out.push(i);
    expect(out.map((i) => i.key)).toEqual(["zotero:PARENT06"]);
    expect(out[0]!.fileNotes).toEqual([ZOTERO_WEB_FILE_NOTES.notInStorage]);
    expect(out[0]!.annotations).toEqual([expect.objectContaining({ key: "zotero:ANNO0006", kind: "underline", quote: "new" })]);
    expect(a.scanResult()).toEqual({ libraryVersion: 21, deletedInZotero: 3, completed: true, downloadsFailed: 0 });
    expect(notes).toContain("3 items were deleted in Zotero since the last import; they were not deleted here.");
    expect(seen.filter((p) => p.startsWith("/users/42/items?") && page(p).has("since"))).toHaveLength(1);
  });

  it("pages after the first send If-Unmodified-Since-Version; a library that changes mid-scan restarts it (item 5 removed before page 2)", async () => {
    let items = Array.from({ length: 150 }, (_, i) => article(`MOVE${String(i).padStart(4, "0")}`, `Item ${i}`));
    let version = 10;
    const sent: Array<{ start: string | null; ius: string | undefined }> = [];
    agent
      .get(API)
      .intercept({ path: (p) => p.startsWith("/users/42/items?"), method: "GET" })
      .reply((req) => {
        const q = page(req.path);
        const h = req.headers as Record<string, string>;
        const ius = h["If-Unmodified-Since-Version"] ?? h["if-unmodified-since-version"];
        sent.push({ start: q.get("start"), ius });
        if (q.get("start") === "0" && version === 10 && sent.length === 1) {
          // Page 1 served at version 10; then item 5 is deleted in Zotero (version 11).
          const out = items.slice(0, 100);
          items = items.filter((i) => i.key !== "MOVE0005");
          version = 11;
          return { statusCode: 200, data: JSON.stringify(out), responseOptions: { headers: { ...JSON_HEADERS, "total-results": "150", "last-modified-version": "10" } } };
        }
        if (ius !== undefined && Number(ius) !== version) return { statusCode: 412, data: "Library has been modified since specified version" };
        const start = Number(q.get("start"));
        return {
          statusCode: 200,
          data: JSON.stringify(items.slice(start, start + 100)),
          responseOptions: { headers: { ...JSON_HEADERS, "total-results": String(items.length), "last-modified-version": String(version) } },
        };
      })
      .persist();
    serveCollections([]);
    serveTagColors();
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: agent, sleep: async () => {} });
    const work = join(tmp, "work");
    await mkdir(work, { recursive: true });
    const out: ScanItem[] = [];
    for await (const i of a.scan(new AbortController().signal, { workDir: async () => work })) out.push(i);
    const keys = out.map((i) => i.key);
    expect(new Set(keys).size).toBe(149);
    expect(keys).not.toContain("zotero:MOVE0005");
    expect(keys).toContain("zotero:MOVE0100"); // the item that moved onto page 1 is not missed
    expect(sent[1]).toEqual({ start: "100", ius: "10" });
    expect(sent.filter((x) => x.start === "100").at(-1)!.ius).toBe("11");
    expect(a.scanResult()).toMatchObject({ libraryVersion: 11, completed: true });
  });

  it("a library that keeps changing stops the scan after 3 restarts (since is not recorded)", async () => {
    let version = 1;
    agent
      .get(API)
      .intercept({ path: (p) => p.startsWith("/users/42/items?"), method: "GET" })
      .reply((req) => {
        version++;
        const start = Number(page(req.path).get("start"));
        const items = Array.from({ length: 100 }, (_, i) => article(`BUSY${String(start + i).padStart(4, "0")}`, `x${i}`));
        return { statusCode: 200, data: JSON.stringify(items), responseOptions: { headers: { ...JSON_HEADERS, "total-results": "200", "last-modified-version": String(version) } } };
      })
      .persist();
    serveCollections([]);
    serveTagColors();
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: agent, sleep: async () => {} });
    const out: ScanItem[] = [];
    const work = join(tmp, "work");
    await mkdir(work, { recursive: true });
    for await (const i of a.scan(new AbortController().signal, { workDir: async () => work })) out.push(i);
    expect(out).toEqual([{ key: "zotero-web:", files: [], unreadable: ZOTERO_WEB_REASONS.changing }]);
    expect(a.scanResult().completed).toBe(false);
  });

  it("checks free space before each download", async () => {
    serveItems(
      [
        article("SPACE001", "No room"),
        { key: "SPACEAT1", version: 5, data: { key: "SPACEAT1", version: 5, itemType: "attachment", parentItem: "SPACE001", linkMode: "imported_file", contentType: "application/pdf", filename: "x.pdf", tags: [] } },
      ],
      8,
    );
    serveCollections([]);
    serveTagColors();
    const file = vi.fn(() => ({ statusCode: 302, data: "", responseOptions: { headers: { location: `${STORAGE}/x` } } }));
    agent.get(API).intercept({ path: "/users/42/items/SPACEAT1/file", method: "GET" }).reply(file);
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: agent, sleep: async () => {}, freeSpace: async () => 1024 });
    const out: ScanItem[] = [];
    const work = join(tmp, "work");
    await mkdir(work, { recursive: true });
    for await (const i of a.scan(new AbortController().signal, { workDir: async () => work })) out.push(i);
    expect(out[0]!.fileNotes).toEqual([ZOTERO_WEB_FILE_NOTES.noSpace]);
    expect(ZOTERO_WEB_FILE_NOTES.noSpace).toMatch(/not enough free disk space/u);
    expect(file).not.toHaveBeenCalled();
    expect(a.scanResult().downloadsFailed).toBe(1);
  });

  it("a compressed file is unpacked and its MD5 checked after decompression", async () => {
    const pdf = await buildPdf({ extra: "zipped" });
    const md5 = createHash("md5").update(pdf).digest("hex");
    const zip = buildZip([{ name: "z.pdf", data: pdf }]);
    const att = (key: string, parent: string, m: string): WebItem => ({ key, version: 5, data: { key, version: 5, itemType: "attachment", parentItem: parent, linkMode: "imported_file", contentType: "application/pdf", filename: "z.pdf", md5: m, tags: [] } });
    serveItems([article("ZIPOK001", "Good zip"), att("ZIPATT01", "ZIPOK001", md5), article("ZIPBAD01", "Bad zip", 5, { DOI: "10.5555/other" }), att("ZIPATT02", "ZIPBAD01", "0".repeat(32))], 8);
    serveCollections([]);
    serveTagColors();
    for (const k of ["ZIPATT01", "ZIPATT02"]) {
      agent.get(API).intercept({ path: `/users/42/items/${k}/file`, method: "GET" }).reply(302, "", { headers: { location: `${STORAGE}/${k}`, "zotero-file-compressed": "Yes" } });
      agent.get(STORAGE).intercept({ path: `/${k}`, method: "GET" }).reply(200, zip);
    }
    const { items } = await collect();
    const ok = items.find((i) => i.key === "zotero:ZIPOK001")!;
    expect(ok.files).toHaveLength(1);
    expect(createHash("md5").update(await readFile(ok.files[0]!.path)).digest("hex")).toBe(md5);
    const bad = items.find((i) => i.key === "zotero:ZIPBAD01")!;
    expect(bad.files).toEqual([]);
    expect(bad.fileNotes).toEqual([ZOTERO_WEB_FILE_NOTES.checksum]);
  });

  it("a failed download changes the item's version token, so the next run retries it", async () => {
    const pdf = await buildPdf({ extra: "retry" });
    const items: WebItem[] = [
      article("RETRYDL1", "Retry me"),
      { key: "RETRYAT1", version: 5, data: { key: "RETRYAT1", version: 5, itemType: "attachment", parentItem: "RETRYDL1", linkMode: "imported_file", contentType: "application/pdf", filename: "r.pdf", tags: [] } },
    ];
    serveItems(items, 8, { times: 30 });
    serveCollections([]);
    serveTagColors();
    agent.get(API).intercept({ path: "/users/42/items/RETRYAT1/file", method: "GET" }).reply(500, "boom");
    const first = await collect({ maxRetries: 0 });
    expect(first.items[0]!.fileNotes).toEqual([ZOTERO_WEB_FILE_NOTES.failed]);
    agent.get(API).intercept({ path: "/users/42/items/RETRYAT1/file", method: "GET" }).reply(302, "", { headers: { location: `${STORAGE}/r` } }).times(2);
    agent.get(STORAGE).intercept({ path: "/r", method: "GET" }).reply(200, pdf).times(2);
    await rm(join(tmp, "work"), { recursive: true, force: true });
    const second = await collect();
    await rm(join(tmp, "work"), { recursive: true, force: true });
    const third = await collect();
    expect(second.items[0]!.files).toHaveLength(1);
    expect(second.items[0]!.version!.version).not.toBe(first.items[0]!.version!.version);
    expect(third.items[0]!.version!.version).toBe(second.items[0]!.version!.version);
  });

  it("a group library: group: ids and paths; other members' linked files are left out with a count note", async () => {
    serveItems(
      [
        article("GROUP001", "Shared paper", 3, { collections: ["GCOLL001"] }),
        { key: "GLINK001", version: 3, data: { key: "GLINK001", version: 3, itemType: "attachment", parentItem: "GROUP001", linkMode: "linked_file", path: "/Users/someone-else/paper.pdf", contentType: "application/pdf", tags: [] } },
      ],
      40,
      { prefix: "/groups/777" },
    );
    serveCollections([{ key: "GCOLL001", name: "Shared" }], "/groups/777");
    serveTagColors("/groups/777");
    const { items, notes } = await collect({ libraryType: "group", libraryId: "777" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "zotero:GROUP001",
      folderPath: ["Shared"],
      files: [],
      externalKeys: expect.objectContaining({ libraryId: "group:777" }),
      version: { id: "group:777/GROUP001", version: expect.any(String) },
    });
    expect(items[0]!.fileNotes).toBeUndefined();
    expect(notes.join(" ")).toMatch(/1 linked file in a group library/u);
  });

  it("odd item and creator types never reach Object.prototype", async () => {
    serveItems([article("PROTO001", "Proto", 5, { itemType: "constructor", creators: [{ creatorType: "__proto__", firstName: "A", lastName: "B" }] })], 3);
    serveCollections([]);
    serveTagColors();
    const { items } = await collect();
    expect(items[0]!.referenceMetadata).toMatchObject({ type: "other", creators: [{ family: "B", given: "A", role: "contributor" }] });
  });

  it("a dry run downloads nothing", async () => {
    serveItems(
      [
        article("PARENT05", "Dry"),
        { key: "ATTACH05", version: 5, data: { key: "ATTACH05", version: 5, itemType: "attachment", parentItem: "PARENT05", linkMode: "imported_file", contentType: "application/pdf", filename: "x.pdf", tags: [] } },
      ],
      8,
    );
    serveCollections([]);
    serveTagColors();
    const { items, notes } = await collect({}, { dryRun: true });
    expect(items[0]!.files).toEqual([]);
    expect(notes.join(" ")).toMatch(/1 file .* downloaded/);
  });
});

describe("Zotero Web import through the engine", () => {
  const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [zotero_import]
processing:
  metadata_lookup: []
`;
  let lib: Library;
  let ring: KeyRing;
  let repo: Repo;
  let handle: IndexHandle;

  const deps = (): Deps => ({
    clock: () => new Date(),
    deviceId: "dev-A",
    hostname: "host-A",
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: join(tmp, "config"),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
  });

  beforeEach(async () => {
    ring = new KeyRing();
    lib = await createLibrary(join(tmp, "Library"), "Lib", deps());
    handle = new IndexHandle(lib.root);
    repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  });
  afterEach(async () => {
    handle.close();
    await lib.close();
    ring.clear();
  });

  const project = async (gov = GOV): Promise<Project> =>
    (await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: gov, encryption: { enabled: false } })).project;
  const bulkDeps = () => ({ repo, http: new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 }), index: handle });
  const sources = async (p: Project): Promise<SourceFile[]> => Promise.all(repo.listSourceIds(p.id).map((id) => repo.getSource(p.id, id)));
  let web: ZoteroWebOptions;
  beforeEach(() => {
    web = { libraryType: "user", libraryId: "42", dispatcher: agent, sleep: async () => {} };
  });

  /** Every file under a folder whose bytes contain `needle`. */
  async function filesContaining(dir: string, needle: string): Promise<string[]> {
    const hits: string[] = [];
    for (const name of await readdir(dir, { recursive: true }).catch(() => [] as string[])) {
      const p = join(dir, name);
      const buf = await readFile(p).catch(() => null);
      if (buf?.includes(needle)) hits.push(name);
    }
    return hits;
  }

  it("imports, records the library version (governed), then asks only since it; Zotero deletions are counted, not applied", async () => {
    const p = await project();
    serveItems([article("AAAA0001", "First title"), article("AAAA0002", "Second", 5, { DOI: "10.5555/ao.web.2024.002" })], 10);
    serveCollections([]);
    serveTagColors();
    const h = await startZoteroWebImport(bulkDeps(), p.id, web);
    const r = await h.done;
    expect(r.state).toBe("finished");
    expect(r.counts.created + r.counts.needsReview).toBe(2);
    expect(zoteroWebSince(repo, p.id, "user:42")).toBe(10);
    const sfs = await sources(p);
    expect(sfs.every((sf) => sf.source.provenance.captureMethod === "zotero_import" && sf.source.provenance.tool.name === "zotero-web-import")).toBe(true);
    const audit = (await readdir(join(lib.root, p.folder, "audit"))).map((f) => join(lib.root, p.folder, "audit", f));
    const events = (await Promise.all(audit.map((f) => readFile(f, "utf8")))).join("\n");
    expect(events).toContain("project.import-settings.zotero-web");

    // Second run: since=10; one item changed, one deleted in Zotero.
    const sinceLog: string[] = [];
    agent
      .get(API)
      .intercept({ path: (q) => q.startsWith("/users/42/items?") && page(q).get("since") === "10", method: "GET" })
      .reply((req) => {
        sinceLog.push(req.path);
        return { statusCode: 200, data: JSON.stringify([article("AAAA0001", "First title, revised", 11)]), responseOptions: { headers: { ...JSON_HEADERS, "total-results": "1", "last-modified-version": "12" } } };
      })
      .persist();
    agent
      .get(API)
      .intercept({ path: (q) => q.startsWith("/users/42/deleted?") && page(q).get("since") === "10", method: "GET" })
      .reply(200, JSON.stringify({ collections: [], items: ["AAAA0002", "GONE0003"], searches: [], tags: [], settings: [] }), { headers: { ...JSON_HEADERS, "last-modified-version": "12" } })
      .persist();
    agent
      .get(API)
      .intercept({ path: (q) => q.startsWith("/users/42/items/AAAA0001/children?"), method: "GET" })
      .reply(200, "[]", { headers: { ...JSON_HEADERS, "total-results": "0", "last-modified-version": "12" } })
      .persist();
    const h2 = await startZoteroWebImport(bulkDeps(), p.id, web);
    const r2 = await h2.done;
    expect(sinceLog.length).toBeGreaterThan(0);
    expect(r2.counts).toMatchObject({ updated: 1, created: 0 });
    expect(repo.listSourceIds(p.id)).toHaveLength(2); // the Zotero deletion was not applied here
    const report = await createBulkImport(bulkDeps()).batchReport(p.id, h2.batchId);
    expect(report.notes.join(" ")).toMatch(/2 items were deleted in Zotero/);
    expect(zoteroWebSince(repo, p.id, "user:42")).toBe(12);
    const first = (await sources(p)).find((sf) => sf.source.provenance.externalKeys?.zoteroKey === "AAAA0001")!;
    expect(first.source.title.variants[0]!.value).toBe("First title, revised");
  });

  /** A Zotero item with a located camera photo attached (GPS 40.6892, -74.0445). */
  async function serveLocatedPhoto(key: string, attKey: string, version: number): Promise<void> {
    const tiffPath = join(tmp, `camera-${key}.tif`);
    await buildCameraTiff(tiffPath);
    serveItems(
      [
        article(key, "Located photo"),
        { key: attKey, version: 5, data: { key: attKey, version: 5, itemType: "attachment", parentItem: key, linkMode: "imported_file", contentType: "image/tiff", filename: "c.tif", tags: [] } },
      ],
      version,
    );
    serveCollections([]);
    serveTagColors();
    agent.get(API).intercept({ path: `/users/42/items/${attKey}/file`, method: "GET" }).reply(302, "", { headers: { location: `${STORAGE}/${attKey}` } });
    agent.get(STORAGE).intercept({ path: `/${attKey}`, method: "GET" }).reply(200, await readFile(tiffPath));
  }

  it("R83: a located photo goes through the shared location flow: stored as the decision allows, its coarsened proxy pending (no worker)", async () => {
    const p = await project();
    await serveLocatedPhoto("LOCPHOT1", "LOCATT01", 40);
    const h = await startZoteroWebImport(bulkDeps(), p.id, web);
    const r = await h.done;
    expect(r.counts.failed).toBe(0);
    const sf = (await sources(p)).find((s) => s.source.provenance.externalKeys?.zoteroKey === "LOCPHOT1")!;
    const photo = sf.assets.find((a) => a.kind === "image")!;
    expect(sf.pendingProxies?.map((j) => [j.type, j.location, j.assetId])).toEqual([["image.proxy", "coarsen", photo.id]]);
    expect((await createBulkImport(bulkDeps()).batchReport(p.id, h.batchId)).notes).toContain(LOCATION_REASON);
  });

  it("since is recorded only when nothing failed: a failed item or a failed download leaves it unchanged", async () => {
    // Location data the project requires to be coarsened, with encryption off: the engine denies the store.
    const p = await project(GOV.replace("atRest: optional", "atRest: \"off\""));
    const tiffPath = join(tmp, "camera.tif");
    await buildCameraTiff(tiffPath);
    const tiff = await readFile(tiffPath);
    serveItems(
      [
        article("FAIL0001", "Located photo"),
        { key: "FAILATT1", version: 5, data: { key: "FAILATT1", version: 5, itemType: "attachment", parentItem: "FAIL0001", linkMode: "imported_file", contentType: "image/tiff", filename: "c.tif", tags: [] } },
      ],
      30,
    );
    serveCollections([]);
    serveTagColors();
    agent.get(API).intercept({ path: "/users/42/items/FAILATT1/file", method: "GET" }).reply(302, "", { headers: { location: `${STORAGE}/c` } });
    agent.get(STORAGE).intercept({ path: "/c", method: "GET" }).reply(200, tiff);
    const r = await (await startZoteroWebImport(bulkDeps(), p.id, web)).done;
    expect(r.state).toBe("finished");
    expect(r.counts.failed).toBe(1);
    expect(zoteroWebSince(repo, p.id, "user:42")).toBeUndefined();

    const p2 = await project();
    serveItems(
      [
        article("DLFAIL01", "Download fails"),
        { key: "DLFAILA1", version: 5, data: { key: "DLFAILA1", version: 5, itemType: "attachment", parentItem: "DLFAIL01", linkMode: "imported_file", contentType: "application/pdf", filename: "d.pdf", tags: [] } },
      ],
      31,
    );
    agent.get(API).intercept({ path: "/users/42/items/DLFAILA1/file", method: "GET" }).reply(503, "busy").persist();
    const r2 = await (await startZoteroWebImport(bulkDeps(), p2.id, { ...web, maxRetries: 0 })).done;
    expect(r2.counts.failed).toBe(0);
    expect(zoteroWebSince(repo, p2.id, "user:42")).toBeUndefined();
  });

  it("a source deleted here is not brought back by a later full Web import (R73)", async () => {
    const p = await project();
    serveItems([article("TOMB0001", "Tombstoned")], 4);
    serveCollections([]);
    serveTagColors();
    await (await startZoteroWebImport(bulkDeps(), p.id, web)).done;
    const [id] = repo.listSourceIds(p.id);
    await repo.deleteSource(p.id, id!);
    const r = await (await startZoteroWebImport(bulkDeps(), p.id, { ...web, full: true })).done;
    expect(r.counts).toMatchObject({ created: 0, deletedHere: 1 });
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("the API key is never written anywhere: library, batch records, reports, journal, audit, app settings", async () => {
    const p = await project();
    const pdf = await buildPdf({ extra: "key check" });
    serveItems(
      [
        article("KEYS0001", "Keyed"),
        { key: "KEYSATT1", version: 5, data: { key: "KEYSATT1", version: 5, itemType: "attachment", parentItem: "KEYS0001", linkMode: "imported_file", contentType: "application/pdf", filename: "k.pdf", tags: [] } },
      ],
      6,
    );
    serveCollections([]);
    serveTagColors();
    agent.get(API).intercept({ path: "/users/42/items/KEYSATT1/file", method: "GET" }).reply(302, "", { headers: { location: `${STORAGE}/k?sig=${KEY}x` } });
    agent.get(STORAGE).intercept({ path: (q) => q.startsWith("/k?"), method: "GET" }).reply(200, pdf);
    const r = await (await startZoteroWebImport(bulkDeps(), p.id, web)).done;
    expect(r.state).toBe("finished");
    // A failing run too: the error must not carry the key.
    agent.get(API).intercept({ path: (q) => q.startsWith("/users/42/"), method: "GET" }).reply(500, `server error ${KEY}`).persist();
    await (await startZoteroWebImport(bulkDeps(), p.id, { ...web, full: true, maxRetries: 0 })).done;
    expect(await filesContaining(lib.root, KEY)).toEqual([]);
    expect(await filesContaining(join(tmp, "config"), KEY)).toEqual([]);
  });

  it("no keyring: the import is refused up front with a plain message and nothing is written", async () => {
    const p = await project();
    const none = useNoSecretStore();
    try {
      await expect(startZoteroWebImport(bulkDeps(), p.id, web)).rejects.toThrow(new BatchRefusedError(ZOTERO_WEB_REASONS.noStore));
    } finally {
      none.restore();
    }
    expect(repo.listSourceIds(p.id)).toEqual([]);
    expect(await readdir(join(lib.root, p.folder)).then((l) => l.includes("imports"))).toBe(false);
  });
});
