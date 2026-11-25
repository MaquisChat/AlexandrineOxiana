import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dispatcher, MockAgent } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCATION_NEEDS_ENCRYPTION, type Project, type SourceFile } from "@ao/core";
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
  zoteroFileHostAllowed,
  zoteroWebAdapter,
  zoteroWebSince,
  type ZoteroWebOptions,
  type ZoteroWebScanResult,
} from "./zotero-web.js";
import { FakeZotero, guardNetwork, type FakeResponse } from "../../tests/zotero/fake-zotero.js";

const FAST = 2 ** 10;
const KEY = "AbCdEfGh0123456789zyxwvu";
const API = "https://api.zotero.org";
const STORAGE = `https://${ZOTERO_STORAGE_HOSTS[0]}`;
const JSON_HEADERS = { "content-type": "application/json" };

let tmp: string;
let agent: MockAgent;
let secrets: ReturnType<typeof useMemorySecrets>;

/** The stand-ins made by the current test (see newFake); their requests are checked after every test. */
const fakes: FakeZotero[] = [];
/** How many requests the after-each check has seen, over the whole file (all must be GET). */
const checked = { requests: 0, tests: 0 };

const newFake = (o?: ConstructorParameters<typeof FakeZotero>[0]): FakeZotero => {
  const z = new FakeZotero(o);
  fakes.push(z);
  return z;
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-zweb-"));
  agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableCallHistory();
  secrets = useMemorySecrets();
  await setSecret("zotero-api-key", KEY);
});

afterEach(async () => {
  vi.useRealTimers();
  // One way only (Global Constraints): every request this test made, to a stand-in or through the plain
  // mock agent, was a GET. Checked at the end of EVERY test, not once.
  const methods = [...fakes.flatMap((z) => z.requests.map((r) => r.method)), ...(agent.getCallHistory()?.calls() ?? []).map((c) => c.method)];
  checked.requests += methods.length;
  checked.tests++;
  expect(methods.filter((m) => m !== "GET")).toEqual([]);
  for (const z of fakes.splice(0)) await z.agent.close();
  secrets.restore();
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

// Guard: nothing in this suite may reach the network, even through a forgotten dispatcher option.
let unguard: () => void;
beforeAll(() => {
  unguard = guardNetwork();
});

afterAll(async () => {
  unguard();
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
    volume: "61",
    issue: "4",
    pages: "777-799",
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

/** The library answers a small keyed check (`/items/top`), so nothing but the scan itself can stop gone items. */
function serveKeyCheck(prefix = "/users/42") {
  agent.get(API).intercept({ path: (p) => p.startsWith(`${prefix}/items/top?`), method: "GET" }).reply(200, "{}", { headers: { ...JSON_HEADERS, "last-modified-version": "40" } }).persist();
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
      volume: "61",
      issue: "4",
      page: "777-799",
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

  it("annotationSortIndex is carried", async () => {
    const parent = article("PARENT07", "Sorted", 4);
    const att: WebItem = { key: "ATTACH07", version: 4, data: { key: "ATTACH07", version: 4, itemType: "attachment", parentItem: "PARENT07", linkMode: "imported_file", contentType: "application/pdf", filename: "z.pdf", tags: [] } };
    const mk = (key: string, sortIndex: unknown): WebItem => ({
      key, version: 21,
      data: { key, version: 21, itemType: "annotation", parentItem: "ATTACH07", annotationType: "highlight", annotationText: "t", annotationSortIndex: sortIndex, annotationPosition: JSON.stringify({ pageIndex: 2, rects: [[1, 2, 3, 4]] }), tags: [] },
    });
    const anns = [mk("ANNO0071", "00002|000120|00300"), mk("ANNO0072", "not a sort index")];
    const reply = (items: WebItem[], v = 21) => ({ statusCode: 200, data: JSON.stringify(items), responseOptions: { headers: { ...JSON_HEADERS, "total-results": String(items.length), "last-modified-version": String(v) } } });
    agent
      .get(API)
      .intercept({ path: (p) => p.startsWith("/users/42/"), method: "GET" })
      .reply((req) => {
        const q = page(req.path);
        const path = req.path.split("?")[0]!;
        if (path === "/users/42/items" && q.get("since") === "20") return reply(anns);
        if (path === "/users/42/items" && q.get("itemKey") === "ATTACH07") return reply([att]);
        if (path === "/users/42/items" && q.get("itemKey") === "PARENT07") return reply([parent]);
        if (path === "/users/42/items/PARENT07/children") return reply([att]);
        if (path === "/users/42/items/ATTACH07/children") return reply(anns);
        if (path === "/users/42/items/ATTACH07/file") return { statusCode: 404, data: "Not found" };
        if (path === "/users/42/collections") return reply([]);
        if (path === "/users/42/deleted") return { statusCode: 200, data: JSON.stringify({ items: [] }), responseOptions: { headers: JSON_HEADERS } };
        return { statusCode: 404, data: "Not found" };
      })
      .persist();
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: agent, sleep: async () => {}, since: 20 });
    const out: ScanItem[] = [];
    const work = join(tmp, "work");
    await mkdir(work, { recursive: true });
    for await (const i of a.scan(new AbortController().signal, { workDir: async () => work, note: () => {} })) out.push(i);
    const byKey = new Map((out[0]!.annotations ?? []).map((x) => [x.key, x]));
    expect(byKey.get("zotero:ANNO0071")?.anchor).toEqual({ kind: "pdf", page: 3, rects: [{ x: 1, y: 2, w: 2, h: 2 }], sortIndex: "00002|000120|00300" });
    expect(byKey.get("zotero:ANNO0072")?.anchor).toEqual({ kind: "pdf", page: 3, rects: [{ x: 1, y: 2, w: 2, h: 2 }] });
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
    expect(a.scanResult()).toEqual({ libraryVersion: 21, deletedInZotero: 3, completed: true, downloadsFailed: 0, refusedHosts: [], goneKeys: { deleted: 0, bin: 0 } });
    // None of the three is known here, so the note (which counts items you have here, A5) is not given.
    expect(notes.filter((t) => /deleted in Zotero/u.test(t))).toEqual([]);
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

  it("a compressed file is unpacked and its MD5 checked after decompression (a mismatch is tried 3 times, then noted)", async () => {
    const z = newFake();
    await setSecret("zotero-api-key", z.key);
    const pdf = await buildPdf({ extra: "zipped" });
    const md5 = createHash("md5").update(pdf).digest("hex");
    const good = z.addItem("user:42", { itemType: "journalArticle", title: "Good zip" });
    z.addItem("user:42", { itemType: "attachment", contentType: "application/pdf", filename: "z.pdf" }, { parent: good, file: { bytes: pdf, compressed: true } });
    const bad = z.addItem("user:42", { itemType: "journalArticle", title: "Bad zip", DOI: "10.5555/other" });
    const badAtt = z.addItem("user:42", { itemType: "attachment", contentType: "application/pdf", filename: "z.pdf" }, { parent: bad, file: { bytes: pdf, compressed: true, md5: "0".repeat(32) } });
    const { items } = await collect({ dispatcher: z.agent });
    const ok = items.find((i) => i.key === `zotero:${good}`)!;
    expect(ok.files).toHaveLength(1);
    expect(createHash("md5").update(await readFile(ok.files[0]!.path)).digest("hex")).toBe(md5);
    const no = items.find((i) => i.key === `zotero:${bad}`)!;
    expect(no.files).toEqual([]);
    expect(no.fileNotes).toEqual([ZOTERO_WEB_FILE_NOTES.checksum]);
    expect(z.requests.filter((r) => r.path.endsWith(`/items/${badAtt}/file`))).toHaveLength(3);
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

describe("unattended scans against the stand-in (Z2)", () => {
  const U = "user:42";
  let z: FakeZotero;
  let n = 0;
  beforeEach(async () => {
    z = newFake();
    await setSecret("zotero-api-key", z.key);
  });

  const art = (title: string, extra: Record<string, unknown> = {}) => ({ itemType: "journalArticle", title, ...extra });
  const pdfAttachment = async (parent: string, o: { storage?: "zotero" | "webdav"; stale?: boolean; redirect?: string; extra?: string } = {}) => {
    const bytes = await buildPdf({ extra: o.extra ?? `file of ${parent}` });
    return z.addItem(U, { itemType: "attachment", contentType: "application/pdf", filename: `${parent}.pdf` }, {
      parent,
      file: { bytes, ...(o.storage ? { storage: o.storage } : {}), ...(o.stale ? { stale: await buildPdf({ extra: `older copy of ${parent}` }) } : {}), ...(o.redirect ? { redirect: o.redirect } : {}) },
    });
  };
  const highlight = (attachment: string, text = "informal markets") =>
    z.addItem(U, { itemType: "annotation", annotationType: "highlight", annotationText: text, annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[10, 20, 110, 40]] }) }, { parent: attachment });

  /** Known here: ids of this library ("user:42/<key>") unless given in full. */
  const known = (...ids: string[]) => () => new Set(ids.map((k) => (k.includes("/") ? k : `${U}/${k}`)));

  async function scanFake(opts: Partial<ZoteroWebOptions> = {}, ctx: Partial<ScanContext> = {}): Promise<{ items: ScanItem[]; notes: string[]; result: ZoteroWebScanResult }> {
    const work = join(tmp, `work-${++n}`);
    await mkdir(work, { recursive: true, mode: 0o700 });
    const notes: string[] = [];
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {}, ...opts });
    const items: ScanItem[] = [];
    for await (const i of a.scan(new AbortController().signal, { workDir: async () => work, note: (t) => notes.push(t), ...ctx })) items.push(i);
    return { items, notes, result: a.scanResult() };
  }
  const goneOf = (items: ScanItem[]) => items.filter((i) => i.gone).map((i) => [i.key, i.gone]);
  const contentOf = (items: ScanItem[]) => items.filter((i) => !i.gone && !i.unreadable).map((i) => i.key);
  const itemRequests = () => z.requests.filter((r) => /^\/users\/42\/items(\?|\/[A-Z0-9]+\/children)/u.test(r.path)).map((r) => r.path);

  it("incremental runs ask with includeTrashed=1 and yield a binned item as gone", async () => {
    const a = z.addItem(U, art("Binned"));
    const b = z.addItem(U, art("Edited"));
    const never = z.addItem(U, art("Never imported here, binned"));
    const since = z.libraryVersion(U);
    z.trash(U, a);
    z.trash(U, never); // not known here: neither content nor gone
    z.editItem(U, b, { title: "Edited again" });
    const { items, result } = await scanFake({ since }, { knownIds: known(a, b) });
    expect(goneOf(items)).toEqual([[`zotero:${a}`, "bin"]]);
    expect(contentOf(items)).toEqual([`zotero:${b}`]);
    const g = items.find((i) => i.gone)!;
    expect(g).toEqual({ key: `zotero:${a}`, files: [], gone: "bin", version: { id: `${U}/${a}`, version: expect.any(String) } });
    expect(result.goneKeys).toEqual({ deleted: 0, bin: 1 });
    const asked = itemRequests();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((p) => page(p).get("includeTrashed") === "1")).toBe(true);
    expect(result.completed).toBe(true);
  });

  it("/deleted keys are yielded as gone: deleted (child keys counted, never yielded)", async () => {
    const a = z.addItem(U, art("Deleted with its note"));
    const note = z.addItem(U, { itemType: "note", note: "<p>child</p>" }, { parent: a });
    const b = z.addItem(U, art("Stays"));
    const since = z.libraryVersion(U);
    z.remove(U, a); // a and its note are listed in /deleted
    const { items, notes, result } = await scanFake({ since }, { knownIds: known(a, b) });
    expect(goneOf(items)).toEqual([[`zotero:${a}`, "deleted"]]);
    expect(items.map((i) => i.key)).not.toContain(`zotero:${note}`);
    expect(result.deletedInZotero).toBe(2);
    expect(result.goneKeys).toEqual({ deleted: 1, bin: 0 });
    // The note counts only top-level items known here (a, not its note), and says nothing it did not do (A5).
    expect(notes.filter((t) => /deleted in Zotero/u.test(t))).toEqual(["1 item you have here was deleted in Zotero since the last sync; nothing was deleted here."]);
  });

  it("the deletion note counts only items you have here, in the plural too", async () => {
    const keys = [z.addItem(U, art("One")), z.addItem(U, art("Two")), z.addItem(U, art("Never here"))];
    const since = z.libraryVersion(U);
    for (const k of keys) z.remove(U, k);
    const { notes, result } = await scanFake({ since }, { knownIds: known(keys[0]!, keys[1]!) });
    expect(result.deletedInZotero).toBe(3);
    expect(notes.filter((t) => /deleted in Zotero/u.test(t))).toEqual(["2 items you have here were deleted in Zotero since the last sync; nothing was deleted here."]);
    // None known here: no note at all.
    const none = await scanFake({ since }, { knownIds: known() });
    expect(none.notes.filter((t) => /deleted in Zotero/u.test(t))).toEqual([]);
  });

  it("a full completed run yields known but unseen items as gone", async () => {
    const a = z.addItem(U, art("Here"));
    const c = z.addItem(U, art("In the bin"));
    z.trash(U, c);
    const { items, result } = await scanFake({}, { knownIds: known(a, c, "GONEGONE") });
    expect(contentOf(items)).toEqual([`zotero:${a}`]);
    expect(goneOf(items).sort()).toEqual([
      [`zotero:${c}`, "bin"],
      ["zotero:GONEGONE", "deleted"],
    ]);
    expect(result).toMatchObject({ completed: true, goneKeys: { deleted: 1, bin: 1 } });
    // A full run reads the bin too.
    expect(itemRequests().every((p) => page(p).get("includeTrashed") === "1")).toBe(true);
    // Absence was checked against the library's complete key list, bin included, in one listing (A5).
    const keyLists = z.requests.filter((r) => r.path.startsWith("/users/42/items?") && page(r.path).get("format") === "versions");
    expect(keyLists).toHaveLength(1);
    expect(page(keyLists[0]!.path).get("includeTrashed")).toBe("1");
    expect(page(keyLists[0]!.path).has("limit")).toBe(false);
  });

  /** Rewrites the stand-in's answers to the key list (`format=versions` on /items); everything else as served. */
  const onKeyList = (change: (r: FakeResponse) => FakeResponse) => {
    const serve = z.serve.bind(z);
    z.serve = (req, host) => {
      const r = serve(req, host);
      return /^\/users\/42\/items\?/u.test(req.path) && page(req.path).get("format") === "versions" ? change(r) : r;
    };
  };
  const keyListAsks = () => z.requests.filter((r) => r.path.startsWith("/users/42/items?") && page(r.path).get("format") === "versions").length;
  const withoutHeader = (r: FakeResponse, h: string): FakeResponse => ({ ...r, headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => k !== h)) });
  const keysOnly = (r: FakeResponse, keep: (k: string) => boolean, total?: number): FakeResponse => {
    const kept = Object.fromEntries(Object.entries(JSON.parse(String(r.body)) as Record<string, number>).filter(([k]) => keep(k)));
    return { ...r, body: JSON.stringify(kept), headers: { ...r.headers, "total-results": String(total ?? Object.keys(kept).length) } };
  };

  it("a key list taken after the library changed still decides: the deleted item is gone, the added one is not content (A6)", async () => {
    const a = z.addItem(U, art("Here"));
    let added: string | undefined;
    // Called in the content loop, after the scan read the library (since A7 the key list is asked for before that loop).
    const skip = () => {
      added ??= z.addItem(U, art("Added after the read"));
      return false;
    };
    const { items, result } = await scanFake({}, { knownIds: known(a, "GONEGONE"), skip });
    expect(added).toBeDefined();
    expect(goneOf(items)).toEqual([["zotero:GONEGONE", "deleted"]]);
    expect(contentOf(items)).toEqual([`zotero:${a}`]);
    expect(result.completed).toBe(true);
  });

  it("a key list that cannot be had (3 tries) yields nobody gone by absence and the full run is not finished (A6)", async () => {
    const a = z.addItem(U, art("Here"));
    onKeyList(() => ({ status: 500, headers: { "content-type": "text/plain" }, body: "busy" }));
    const { items, result } = await scanFake({ maxRetries: 0 }, { knownIds: known(a, "GONEGONE") });
    expect(goneOf(items)).toEqual([]);
    expect(items.some((i) => i.unreadable)).toBe(false);
    expect(keyListAsks()).toBe(3);
    expect(result.completed).toBe(false);
  });

  it("a key list without Total-Results is not whole: nobody gone (I5)", async () => {
    const a = z.addItem(U, art("Here"));
    onKeyList((r) => withoutHeader(r, "total-results"));
    const { items, result } = await scanFake({}, { knownIds: known(a, "GONEGONE") });
    expect(goneOf(items)).toEqual([]);
    expect(result.completed).toBe(false);
  });

  it("an empty key list where the scan saw items is not whole, even with Total-Results: 0 (I5)", async () => {
    const a = z.addItem(U, art("Here"));
    onKeyList((r) => keysOnly(r, () => false));
    const { items, result } = await scanFake({}, { knownIds: known(a, "GONEGONE") });
    expect(goneOf(items)).toEqual([]);
    expect(result.completed).toBe(false);
  });

  it("a key list lacking a key the scan saw is not whole (I5)", async () => {
    const a = z.addItem(U, art("Seen, missing from the list"));
    const b = z.addItem(U, art("Seen"));
    onKeyList((r) => keysOnly(r, (k) => k !== a));
    const { items, result } = await scanFake({}, { knownIds: known(a, b, "GONEGONE") });
    expect(goneOf(items)).toEqual([]);
    expect(result.completed).toBe(false);
  });

  it("item pages that understate their total and a short key list without a total: nobody gone (the reviewer's S2, I5)", async () => {
    const keys = Array.from({ length: 250 }, (_, i) => z.addItem(U, art(`Item ${i}`)));
    const serve = z.serve.bind(z);
    z.serve = (req, host) => {
      const r = serve(req, host);
      if (!/^\/users\/42\/items\?/u.test(req.path)) return r;
      if (page(req.path).get("format") === "versions") return withoutHeader(keysOnly(r, (k) => keys.indexOf(k) >= 100), "total-results");
      // The item pages hide 100 items and say there are 150, so the scan itself looks complete.
      const body = page(req.path).get("start") === "100" ? JSON.stringify((JSON.parse(String(r.body)) as unknown[]).slice(0, 50)) : r.body;
      return { ...r, body, headers: { ...r.headers, "total-results": "150" } };
    };
    const { items } = await scanFake({}, { knownIds: known(...keys) });
    expect(contentOf(items)).toHaveLength(150);
    expect(goneOf(items)).toEqual([]);
  });

  it("a key list whose length is not its Total-Results is not whole (I5)", async () => {
    const a = z.addItem(U, art("Here"));
    onKeyList((r) => ({ ...r, headers: { ...r.headers, "total-results": "7" } }));
    const { items, result } = await scanFake({}, { knownIds: known(a, "GONEGONE") });
    expect(goneOf(items)).toEqual([]);
    expect(result.completed).toBe(false);
  });

  it("knownIds of another library are never yielded", async () => {
    z.addItem(U, art("Here"));
    const since = z.libraryVersion(U);
    const other = z.addItem(U, art("Removed"));
    z.remove(U, other);
    const ids = [`group:777/${other}`, "user:4200/ABCDEFGH", "user:42", "user:42/", "user:42/not a key!", "group:777/GONEGONE"];
    const full = await scanFake({}, { knownIds: known(...ids) });
    expect(goneOf(full.items)).toEqual([]);
    expect(full.result.completed).toBe(true);
    const inc = await scanFake({ since }, { knownIds: known(...ids) });
    expect(goneOf(inc.items)).toEqual([]);
    expect(inc.result.deletedInZotero).toBe(1);
  });

  it("an item binned and restored within one interval is not gone", async () => {
    const a = z.addItem(U, art("Back again"));
    const since = z.libraryVersion(U);
    z.trash(U, a);
    z.restore(U, a);
    const { items } = await scanFake({ since }, { knownIds: known(a) });
    expect(goneOf(items)).toEqual([]);
    expect(contentOf(items)).toEqual([`zotero:${a}`]);
  });

  it("an item binned and then removed from the bin within one interval is gone as deleted, not bin", async () => {
    const a = z.addItem(U, art("Emptied"));
    const since = z.libraryVersion(U);
    z.trash(U, a);
    z.remove(U, a);
    const { items } = await scanFake({ since }, { knownIds: known(a) });
    expect(goneOf(items)).toEqual([[`zotero:${a}`, "deleted"]]);
  });

  it("a scan cut on a later page yields no gone item", async () => {
    for (let i = 0; i < 650; i++) z.addItem(U, art(`Item ${i}`));
    z.dropConnectionOnPage(7, { mode: "midBody" });
    const cut = await scanFake({ maxRetries: 0 }, { knownIds: known("GONEGONE") });
    expect(goneOf(cut.items)).toEqual([]);
    expect(cut.items.at(-1)).toEqual({ key: "zotero-web:", files: [], unreadable: ZOTERO_WEB_REASONS.unavailable });
    expect(cut.result.completed).toBe(false);
    // Dropped before any answer, with no retry left: the same.
    z.dropConnectionOnPage(7);
    const dropped = await scanFake({ maxRetries: 0 }, { knownIds: known("GONEGONE") });
    expect(goneOf(dropped.items)).toEqual([]);
    expect(dropped.result.completed).toBe(false);
    // Dropped once and read again on the retry: the picture is whole, so the unseen item is gone.
    z.dropConnectionOnPage(7);
    const retried = await scanFake({}, { knownIds: known("GONEGONE") });
    expect(goneOf(retried.items)).toEqual([["zotero:GONEGONE", "deleted"]]);
  });

  it("a page cut in the middle of its body is read again (M7)", async () => {
    for (let i = 0; i < 250; i++) z.addItem(U, art(`Item ${i}`));
    z.dropConnectionOnPage(2, { mode: "midBody" });
    const { items, result } = await scanFake({}, { knownIds: known("GONEGONE") });
    expect(items.some((i) => i.unreadable)).toBe(false);
    expect(contentOf(items)).toHaveLength(250);
    expect(goneOf(items)).toEqual([["zotero:GONEGONE", "deleted"]]);
    expect(result.completed).toBe(true);
    expect(z.requests.filter((r) => r.path.startsWith("/users/42/items?") && page(r.path).get("start") === "100" && page(r.path).get("format") === "json")).toHaveLength(2);
  });

  it("a key revoked half-way yields no gone item and ends as key-refused", async () => {
    const parents = [z.addItem(U, art("One")), z.addItem(U, art("Two")), z.addItem(U, art("Three"))];
    for (const p of parents) await pdfAttachment(p);
    let calls = 0;
    // Revoked between the first and the second download.
    const freeSpace = async () => {
      if (++calls === 2) z.revokeKey();
      return 1e12;
    };
    const { items, result } = await scanFake({ freeSpace }, { knownIds: known("GONEGONE") });
    expect(goneOf(items)).toEqual([]);
    expect(items.at(-1)).toEqual({ key: "zotero-web:", files: [], unreadable: ZOTERO_WEB_REASONS.keyRefused });
    expect(items.some((i) => i.fileNotes?.includes(ZOTERO_WEB_FILE_NOTES.noFileAccess))).toBe(false);
    expect(result.completed).toBe(false);

    // Revoked after the last request of the scan itself: the check before any gone item catches it.
    z = newFake();
    await setSecret("zotero-api-key", z.key);
    z.addItem(U, art("Only"));
    const late = await scanFake({}, { knownIds: known("GONEGONE"), skip: () => (z.revokeKey(), false) });
    expect(goneOf(late.items)).toEqual([]);
    expect(late.items.at(-1)).toEqual({ key: "zotero-web:", files: [], unreadable: ZOTERO_WEB_REASONS.keyRefused });
  });

  it("a library that changes during the scan restarts it; the whole read after the restart is complete (A5)", async () => {
    for (let i = 0; i < 150; i++) z.addItem(U, art(`Item ${i}`));
    const first = z.addItem(U, art("Edited mid-scan"));
    z.backoffOnce(1); // after page 1 the client waits (sleep): the library changes there
    let edited = false;
    const sleep = async () => {
      if (!edited) {
        edited = true;
        z.editItem(U, first, { title: "Revised" });
      }
    };
    const { items, result } = await scanFake({ sleep }, { knownIds: known(first, "GONEGONE") });
    expect(edited).toBe(true);
    expect(z.requests.filter((q) => q.path.startsWith("/users/42/items?") && q.path.includes("start=0")).length).toBeGreaterThanOrEqual(2); // it restarted
    expect(contentOf(items)).toHaveLength(151);
    expect(JSON.stringify(items.find((i) => i.key === `zotero:${first}`)!.referenceMetadata)).toContain("Revised");
    // The back-off was waited out (A4) and the restart read everything at one version: whole.
    expect(goneOf(items)).toEqual([["zotero:GONEGONE", "deleted"]]);
    expect(result.completed).toBe(true);
    expect(result.backoffUntil).toBeDefined();
  });

  it("with no Total-Results, a short page makes the scan incomplete and no item gone (P2b)", async () => {
    // The stand-in always sends Total-Results, so this listing comes from the plain mock agent.
    const all = Array.from({ length: 250 }, (_, i) => article(`NOTOT${String(i).padStart(3, "0")}`, `Item ${i}`));
    agent
      .get(API)
      .intercept({ path: (q) => q.startsWith("/users/42/items?"), method: "GET" })
      .reply((req) => {
        const start = Number(page(req.path).get("start") ?? 0);
        // Page 2 comes back short (50 of 100), and no answer says how many there are.
        const body = start === 100 ? all.slice(100, 150) : all.slice(start, start + 100);
        return { statusCode: 200, data: JSON.stringify(body), responseOptions: { headers: { ...JSON_HEADERS, "last-modified-version": "40" } } };
      })
      .persist();
    serveCollections([]);
    serveTagColors();
    serveKeyCheck();
    const work = join(tmp, "work2");
    await mkdir(work, { recursive: true });
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: agent, sleep: async () => {} });
    const items: ScanItem[] = [];
    // Every one of the 250 is known here: the 100 never read must not be taken as deleted.
    for await (const i of a.scan(new AbortController().signal, { workDir: async () => work, knownIds: () => new Set(all.map((x) => `user:42/${x.key}`)) })) items.push(i);
    expect(items.filter((i) => i.gone)).toEqual([]);
    expect(a.scanResult().completed).toBe(false);
  });

  it("items that do not add up to Total-Results make the scan incomplete and no item gone", async () => {
    const all = Array.from({ length: 120 }, (_, i) => article(`SHORT${String(i).padStart(3, "0")}`, `Item ${i}`));
    agent
      .get(API)
      .intercept({ path: (q) => q.startsWith("/users/42/items?"), method: "GET" })
      .reply((req) => {
        const start = Number(page(req.path).get("start") ?? 0);
        return { statusCode: 200, data: JSON.stringify(all.slice(start, start + 100)), responseOptions: { headers: { ...JSON_HEADERS, "total-results": "300", "last-modified-version": "40" } } };
      })
      .persist();
    serveCollections([]);
    serveTagColors();
    serveKeyCheck();
    const work = join(tmp, "work3");
    await mkdir(work, { recursive: true });
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: agent, sleep: async () => {} });
    const out: ScanItem[] = [];
    for await (const i of a.scan(new AbortController().signal, { workDir: async () => work, knownIds: () => new Set(["user:42/GONEGONE"]) })) out.push(i);
    expect(out.filter((i) => i.gone)).toEqual([]);
    expect(out.filter((i) => !i.gone && !i.unreadable)).toHaveLength(120);
    expect(a.scanResult().completed).toBe(false);
  });

  it("tag colours that fail for a passing reason make the scan incomplete (M4)", async () => {
    serveItems([article("COLOUR01", "Coloured")], 7);
    serveCollections([]);
    agent.get(API).intercept({ path: "/users/42/settings/tagColors", method: "GET" }).reply(503, "busy").persist();
    const work = join(tmp, "work4");
    await mkdir(work, { recursive: true });
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: agent, sleep: async () => {}, maxRetries: 0 });
    const out: ScanItem[] = [];
    for await (const i of a.scan(new AbortController().signal, { workDir: async () => work })) out.push(i);
    expect(out.map((i) => i.key)).toEqual(["zotero:COLOUR01"]);
    expect(a.scanResult().completed).toBe(false);
  });

  it("an item the context skips is never downloaded", async () => {
    const p = z.addItem(U, art("Skipped"));
    const att = await pdfAttachment(p);
    highlight(att);
    const q = z.addItem(U, art("Taken"));
    const qatt = await pdfAttachment(q);
    const skip = (k: string) => k === `zotero:${p}`;
    const full = await scanFake({}, { skip });
    expect(contentOf(full.items)).toEqual([`zotero:${q}`]);
    expect(z.requests.some((r) => r.path.includes(`/items/${att}/`))).toBe(false);
    expect(z.requests.some((r) => r.path.includes(`/items/${qatt}/file`))).toBe(true);
    // Incremental: nothing listed under the skipped item either.
    const since = z.libraryVersion(U);
    z.editItem(U, p, { title: "Skipped, edited" });
    z.editItem(U, q, { title: "Taken, edited" });
    z.requests.length = 0;
    const inc = await scanFake({ since }, { skip });
    expect(contentOf(inc.items)).toEqual([`zotero:${q}`]);
    expect(z.requests.some((r) => r.path.includes(`/items/${p}/`) || r.path.includes(`/items/${att}/`))).toBe(false);
    // A gone item the context skips is not yielded either.
    z.trash(U, p);
    const binned = await scanFake({ since }, { skip, knownIds: known(p) });
    expect(goneOf(binned.items)).toEqual([]);
  });

  it("a 403 on a file is a per-file note, not a refused key", async () => {
    z.setKeyAccess({ files: false });
    const p = z.addItem(U, art("No file access"));
    const att = await pdfAttachment(p);
    highlight(att, "still here");
    z.addItem(U, { itemType: "note", note: "<p>my reading</p>" }, { parent: p });
    const q = z.addItem(U, art("Second"));
    await pdfAttachment(q);
    const { items, result } = await scanFake();
    expect(items.some((i) => i.unreadable)).toBe(false);
    const it0 = items.find((i) => i.key === `zotero:${p}`)!;
    expect(it0.fileNotes).toEqual([ZOTERO_WEB_FILE_NOTES.noFileAccess]);
    expect(ZOTERO_WEB_FILE_NOTES.noFileAccess).toBe("attached file was not fetched: the Zotero key may not read files");
    expect(it0.files).toEqual([]);
    expect(it0.annotations?.map((a) => [a.kind, a.quote ?? a.body, a.file])).toEqual(
      expect.arrayContaining([
        ["highlight", "still here", undefined],
        ["note", expect.stringContaining("my reading"), undefined],
      ]),
    );
    expect(items.find((i) => i.key === `zotero:${q}`)!.fileNotes).toEqual([ZOTERO_WEB_FILE_NOTES.noFileAccess]);
    expect(result).toMatchObject({ completed: true, downloadsFailed: 0 });

    // files: false asks for no file at all, and says so once.
    z.requests.length = 0;
    const off = await scanFake({ files: false });
    expect(z.requests.some((r) => r.path.endsWith("/file"))).toBe(false);
    expect(off.items.every((i) => !i.fileNotes)).toBe(true);
    expect(off.notes.filter((t) => /not fetched/u.test(t))).toEqual(["2 attached files were not fetched: the Zotero key may not read files."]);
  });

  it("a WebDAV library's items come in with their highlights, unanchored, and say the file is not in Zotero's online storage", async () => {
    expect(ZOTERO_WEB_FILE_NOTES.checksum).toBe(
      "attached file did not match Zotero's checksum after 3 tries and was not brought in (the copy in Zotero's storage may be damaged or out of date, or the file may be kept elsewhere, for example on a WebDAV server)",
    );
    expect(ZOTERO_WEB_FILE_NOTES.notInStorage).toBe("attached file is not in Zotero's online storage (it may be kept on a WebDAV server)");
    const p = z.addItem(U, art("On WebDAV"));
    const att = await pdfAttachment(p, { storage: "webdav" });
    highlight(att, "webdav highlight");
    const q = z.addItem(U, art("Older copy in Zotero storage"));
    const qatt = await pdfAttachment(q, { storage: "webdav", stale: true });
    highlight(qatt, "stale highlight");
    const { items, result } = await scanFake();
    for (const [key, quote, note] of [
      [p, "webdav highlight", ZOTERO_WEB_FILE_NOTES.notInStorage],
      [q, "stale highlight", ZOTERO_WEB_FILE_NOTES.checksum], // Zotero has a copy; it never matches
    ] as const) {
      const it0 = items.find((i) => i.key === `zotero:${key}`)!;
      expect(it0.files).toEqual([]);
      expect(it0.fileNotes).toEqual([note]);
      expect(it0.annotations).toEqual([expect.objectContaining({ kind: "highlight", quote })]);
      // Unanchored: no file to anchor in (the engine stores it without an anchor; its page stays as a label).
      expect(it0.annotations![0]).not.toHaveProperty("file");
    }
    // The older copy fails its checksum on each of the bounded tries, then it is noted.
    expect(z.requests.filter((r) => r.path.endsWith(`/items/${qatt}/file`))).toHaveLength(3);
    expect(result).toMatchObject({ completed: true, downloadsFailed: 0 });
  });

  it("a path-style s3 URL outside /zoterofilestorage/ is refused; files.zotero.net is followed", async () => {
    const yes = ["https://zoterofilestorage.s3.amazonaws.com/abc?sig=1", "https://s3.amazonaws.com/zoterofilestorage/abc?sig=1", "https://files.zotero.net/any/path?x=1", "https://FILES.zotero.net:443/a"];
    const no = [
      "https://s3.amazonaws.com/other-bucket/abc",
      "https://s3.amazonaws.com/zoterofilestorage", // the folder itself, not a file under it
      "https://s3.amazonaws.com/zoterofilestorageX/abc",
      "http://zoterofilestorage.s3.amazonaws.com/abc",
      "https://zoterofilestorage.s3.amazonaws.com:8443/abc",
      "https://user:pw@files.zotero.net/abc",
      "https://evil.example.com/zoterofilestorage/abc",
      "https://zoterofilestorage.s3.amazonaws.com.evil.example/abc",
      "https://files.zotero.net.evil.example/abc",
    ];
    for (const u of yes) expect(zoteroFileHostAllowed(new URL(u)), u).toBe(true);
    for (const u of no) expect(zoteroFileHostAllowed(new URL(u)), u).toBe(false);

    const p = z.addItem(U, art("On a path-style URL elsewhere"));
    await pdfAttachment(p, { redirect: "https://s3.amazonaws.com/other-bucket/" });
    const q = z.addItem(U, art("On files.zotero.net"));
    await pdfAttachment(q, { redirect: "https://files.zotero.net/files/" });
    const { items, result } = await scanFake();
    expect(items.find((i) => i.key === `zotero:${p}`)!.fileNotes).toEqual([ZOTERO_WEB_FILE_NOTES.redirectRefused]);
    const got = items.find((i) => i.key === `zotero:${q}`)!;
    expect(got.files).toHaveLength(1);
    expect(got.fileNotes).toBeUndefined();
    expect(z.requests.some((r) => r.path.startsWith("/other-bucket/"))).toBe(false); // nothing was asked of the refused URL
    expect(z.requests.some((r) => r.path.startsWith("/files/"))).toBe(true);
    expect(result.refusedHosts).toEqual(["s3.amazonaws.com"]);
    // The key never went to a file host.
    expect(z.requests.filter((r) => !/^\/(users|groups|keys)\//u.test(r.path)).every((r) => r.headers["zotero-api-key"] === undefined)).toBe(true);
  });

  it("refused hosts are names only, at most 5", async () => {
    for (let i = 0; i < 7; i++) {
      const p = z.addItem(U, art(`Elsewhere ${i}`));
      await pdfAttachment(p, { redirect: `https://host${i}.example.org/zoterofilestorage/` });
    }
    const { result } = await scanFake();
    expect(result.refusedHosts).toHaveLength(5);
    expect(result.refusedHosts.every((h) => /^host\d\.example\.org$/u.test(h))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/sig=|zoterofilestorage|\//u);
  });

  it("the longest Backoff or Retry-After asked for sets backoffUntil", async () => {
    z.addItem(U, art("Slow"));
    const before = Date.now();
    z.failNext(1, 429, 90);
    const { result: r1 } = await scanFake();
    expect(r1.backoffUntil).toBeGreaterThanOrEqual(before + 90_000);
    expect(r1.backoffUntil).toBeLessThan(Date.now() + 91_000);
    z.backoffOnce(3600);
    const { result: r2, items } = await scanFake();
    expect(contentOf(items)).toHaveLength(1);
    expect(r2.backoffUntil).toBeGreaterThanOrEqual(before + 3_600_000);
    const { result: r3 } = await scanFake();
    expect(r3.backoffUntil).toBeUndefined();
    // A wait beyond a day is reported as a day (M6).
    z.backoffOnce(999_999_999);
    const { result: r4 } = await scanFake();
    expect(r4.backoffUntil).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000);
    expect(r4.backoffUntil).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it("the scan result holds no key, path or title", async () => {
    const p = z.addItem(U, art("A title that must not leak"));
    await pdfAttachment(p, { redirect: `https://refused.example.org/zoterofilestorage/` });
    const { result } = await scanFake({}, { knownIds: known("GONEGONE") });
    const text = JSON.stringify(result);
    expect(text).not.toContain(z.key);
    expect(text).not.toContain("title");
    // Only numbers, host names, a version and booleans (R78).
    for (const k of Object.keys(result)) expect(["backoffUntil", "completed", "deletedInZotero", "downloadsFailed", "goneKeys", "libraryVersion", "refusedHosts"]).toContain(k);
    expect(result.refusedHosts).toEqual(["refused.example.org"]);
  });

  // ---- Task Z4: no file downloaded twice (adapter level) ----------------------------------------------

  const sha256Of = (b: Uint8Array | Buffer) => createHash("sha256").update(b).digest("hex");
  const fileRequests = (att: string) => z.requests.filter((r) => r.path.endsWith(`/items/${att}/file`)).length;
  const storageRequests = () => z.requests.filter((r) => r.path.startsWith("/zoterofilestorage/")).length;

  it("a skipped file makes no request: a known attachment at its version is not fetched, its highlights carry the stored hash, and the token is the downloaded one (Z4)", async () => {
    const p = z.addItem(U, art("Known file"));
    const att = await pdfAttachment(p);
    highlight(att, "anchored in the stored copy");
    // First: downloaded, as today. Its part names the attachment's version and the hash of the bytes.
    const first = await scanFake();
    const got = first.items.find((i) => i.key === `zotero:${p}`)!;
    expect(got.files).toHaveLength(1);
    const sha = sha256Of(await readFile(got.files[0]!.path));
    const attVersion = z.libraryVersion(U) - 1; // the attachment was the second-to-last write (the highlight the last)
    expect(got.version!.parts).toEqual({ [att]: { v: attVersion, sha256: sha } });
    expect(got.annotations![0]).toMatchObject({ file: got.files[0]!.path });
    expect(got.annotations![0]).not.toHaveProperty("assetSha256");
    // Then: the engine says the attachment at that version is stored (with its hash). Nothing is asked for.
    z.requests.length = 0;
    const asked: Array<[string, string, number]> = [];
    const fileKnown = (id: string, k: string, v: number) => {
      asked.push([id, k, v]);
      return k === att && v === attVersion ? { sha256: sha } : undefined;
    };
    const second = await scanFake({}, { fileKnown });
    expect(asked).toEqual([[`${U}/${p}`, att, attVersion]]);
    expect(fileRequests(att)).toBe(0);
    expect(storageRequests()).toBe(0); // not even the redirect
    const skipped = second.items.find((i) => i.key === `zotero:${p}`)!;
    expect(skipped.files).toEqual([]);
    expect(skipped.fileNotes).toBeUndefined();
    expect(skipped.version!.parts).toEqual({ [att]: { v: attVersion, sha256: sha } });
    expect(skipped.annotations![0]).toMatchObject({ quote: "anchored in the stored copy", assetSha256: sha, anchor: { kind: "pdf", page: 1 } });
    expect(skipped.annotations![0]).not.toHaveProperty("file");
    // The version token is computed exactly as today: a known file counts as brought in.
    expect(skipped.version!.version).toBe(got.version!.version);
    expect(second.result).toMatchObject({ completed: true, downloadsFailed: 0 });
    // Another version of the attachment is not known: it is downloaded.
    z.editItem(U, att, { title: "renamed in Zotero" });
    z.requests.length = 0;
    const third = await scanFake({}, { fileKnown });
    expect(fileRequests(att)).toBe(1);
    expect(third.items.find((i) => i.key === `zotero:${p}`)!.files).toHaveLength(1);
  });

  it("a failed download leaves no part; a known file under a standalone attachment item is still yielded (Z4)", async () => {
    const p = z.addItem(U, art("Fails"));
    const att = await pdfAttachment(p);
    z.failFile(U, att, { api: 500 });
    const { items } = await scanFake({ maxRetries: 0 });
    const it0 = items.find((i) => i.key === `zotero:${p}`)!;
    expect(it0.fileNotes).toEqual([ZOTERO_WEB_FILE_NOTES.failed]);
    expect(it0.version!.parts ?? {}).toEqual({});
    // A standalone attachment (no parent item) whose file is known: yielded with its part, nothing fetched.
    z.failFile(U, att, null);
    const bytes = await buildPdf({ extra: "standalone" });
    const solo = z.addItem(U, { itemType: "attachment", contentType: "application/pdf", filename: "solo.pdf" }, { file: { bytes } });
    const v = z.libraryVersion(U);
    z.requests.length = 0;
    const known2 = await scanFake({}, { fileKnown: (_id, k, ver) => (k === solo && ver === v ? { sha256: sha256Of(bytes) } : undefined) });
    expect(fileRequests(solo)).toBe(0);
    expect(known2.items.find((i) => i.key === `zotero:${solo}`)!.version!.parts).toEqual({ [solo]: { v, sha256: sha256Of(bytes) } });
  });

  // ---- Amendment A7 (Ruling R215): the key list before the downloads -----------------------------------

  it("the key list is taken before any download, at the pinned version (A7)", async () => {
    const a = z.addItem(U, art("Here"));
    await pdfAttachment(a);
    await scanFake({}, { knownIds: known(a, "GONEGONE") });
    const keyList = z.requests.findIndex((r) => r.path.startsWith("/users/42/items?") && page(r.path).get("format") === "versions");
    const firstFile = z.requests.findIndex((r) => r.path.endsWith("/file"));
    expect(keyList).toBeGreaterThanOrEqual(0);
    expect(firstFile).toBeGreaterThan(keyList);
    expect(z.requests[keyList]!.headers["if-unmodified-since-version"]).toBe(String(z.libraryVersion(U)));
  });

  it("a library that changes during the downloads: the run still finishes, the right items are gone, the version is the pinned one (A7)", async () => {
    const seen = z.addItem(U, art("Seen, then deleted in Zotero during the downloads"));
    const withPdf = z.addItem(U, art("Has a file"));
    const att = await pdfAttachment(withPdf);
    const pinned = z.libraryVersion(U);
    // While the file is downloaded the researcher goes on using Zotero: an unrelated item added, a seen item deleted.
    const serve = z.serve.bind(z);
    let changed = false;
    z.serve = (req, host) => {
      if (!changed && req.path.endsWith(`/items/${att}/file`)) {
        changed = true;
        z.addItem(U, art("Added during the downloads"));
        z.remove(U, seen);
      }
      return serve(req, host);
    };
    const { items, result, notes } = await scanFake({}, { knownIds: known(seen, withPdf, "GONEGONE") });
    expect(changed).toBe(true);
    expect(goneOf(items)).toEqual([["zotero:GONEGONE", "deleted"]]);
    expect(contentOf(items).sort()).toEqual([`zotero:${seen}`, `zotero:${withPdf}`].sort());
    expect(result).toMatchObject({ completed: true, libraryVersion: pinned });
    expect(notes.some((t) => /could not confirm/u.test(t))).toBe(false);
  });

  it("a restart re-takes the key list (A7)", async () => {
    const a = z.addItem(U, art("Here"));
    const serve = z.serve.bind(z);
    let asks = 0;
    z.serve = (req, host) => {
      if (req.path.startsWith("/users/42/items?") && page(req.path).get("format") === "versions" && ++asks === 1) z.addItem(U, art("Added while the list was asked for"));
      return serve(req, host);
    };
    const { items, result } = await scanFake({}, { knownIds: known(a, "GONEGONE") });
    expect(asks).toBe(2); // the first answer was refused (412: the library moved on), the scan restarted and asked again
    expect(z.requests.filter((r) => r.path.startsWith("/users/42/items?") && page(r.path).get("format") === "json" && page(r.path).get("start") === "0")).toHaveLength(2);
    expect(goneOf(items)).toEqual([["zotero:GONEGONE", "deleted"]]);
    expect(contentOf(items)).toHaveLength(2);
    expect(result.completed).toBe(true);
  });

  it("a key list that fails three times: nobody gone, not finished, and the run says so once (A7)", async () => {
    const a = z.addItem(U, art("Here"));
    onKeyList(() => ({ status: 500, headers: { "content-type": "text/plain" }, body: "busy" }));
    const { items, result, notes } = await scanFake({ maxRetries: 0 }, { knownIds: known(a, "GONEGONE") });
    expect(goneOf(items)).toEqual([]);
    expect(result.completed).toBe(false);
    expect(notes.filter((t) => t === "This sync could not confirm which items were deleted in Zotero, so the next sync will read the whole library again.")).toHaveLength(1);
  });

  describe("FR-A21 (R392): the total the scan tells", () => {
    /** The scan's items and the totals it told, each with how many items had been yielded by then. */
    async function told(opts: Partial<ZoteroWebOptions> = {}, ctx: Partial<ScanContext> = {}) {
      const totals: Array<{ n: number; after: number }> = [];
      let yielded = 0;
      const work = join(tmp, `work-${++n}`);
      await mkdir(work, { recursive: true, mode: 0o700 });
      const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {}, ...opts });
      const items: ScanItem[] = [];
      for await (const i of a.scan(new AbortController().signal, { workDir: async () => work, total: (t) => totals.push({ n: t, after: yielded }), ...ctx })) {
        items.push(i);
        yielded++;
      }
      return { items, totals };
    }

    it("a full run: the items it will yield (children, notes and the bin not counted; a known binned item is), told before the first", async () => {
      const a = z.addItem(U, art("With a file"));
      const att = await pdfAttachment(a);
      highlight(att);
      const b = z.addItem(U, art("With a note"));
      z.addItem(U, { itemType: "note", note: "<p>child</p>" }, { parent: b });
      z.addItem(U, { itemType: "note", note: "<p>standalone</p>" });
      const binned = z.addItem(U, art("Binned, known here"));
      const never = z.addItem(U, art("Binned, never here"));
      z.trash(U, binned);
      z.trash(U, never);
      z.addItem(U, art("Plain"));
      const { items, totals } = await told({}, { knownIds: known(a, binned) });
      expect(items).toHaveLength(4); // three articles, and the known binned one as gone
      expect(totals).toEqual([{ n: 4, after: 0 }]);
    });

    it("a sync asking only for what changed: the changed items (and gone ones) it will yield", async () => {
      const a = z.addItem(U, art("Edited"));
      const b = z.addItem(U, art("Untouched"));
      const c = z.addItem(U, art("Deleted"));
      const d = z.addItem(U, art("Binned"));
      const since = z.libraryVersion(U);
      z.editItem(U, a, { title: "Edited again" });
      z.remove(U, c);
      z.trash(U, d);
      z.addItem(U, art("New"));
      const { items, totals } = await told({ since }, { knownIds: known(a, b, c, d) });
      expect(items).toHaveLength(4); // edited, new, deleted (gone), binned (gone)
      expect(totals).toEqual([{ n: 4, after: 0 }]);
    });
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

  it("R83/R85 M5: a located photo goes through the shared location flow: in this unencrypted coarsen project its store is denied", async () => {
    const p = await project();
    await serveLocatedPhoto("LOCPHOT1", "LOCATT01", 40);
    const h = await startZoteroWebImport(bulkDeps(), p.id, web);
    const r = await h.done;
    expect(r.counts.failed).toBe(1);
    expect((await createBulkImport(bulkDeps()).batchReport(p.id, h.batchId)).failures).toEqual([{ item: expect.stringContaining("LOCPHOT1"), reason: LOCATION_NEEDS_ENCRYPTION }]);
    expect((await sources(p)).some((s) => s.source.provenance.externalKeys?.zoteroKey === "LOCPHOT1")).toBe(false);
  });

  it("R83 allowed path: in an encrypted coarsen project the located photo is stored encrypted, with a coarsened proxy pending", async () => {
    const p = (await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: GOV, encryption: { enabled: true, passphrase: "pw" } })).project;
    await serveLocatedPhoto("LOCPHOT2", "LOCATT02", 41);
    const h = await startZoteroWebImport(bulkDeps(), p.id, web);
    const r = await h.done;
    expect(r.counts).toMatchObject({ failed: 0, created: 1 });
    const report = await createBulkImport(bulkDeps()).batchReport(p.id, h.batchId);
    expect(report.failures).toEqual([]);
    expect(report.notes).toContain(LOCATION_REASON);
    const sf = (await sources(p)).find((s) => s.source.provenance.externalKeys?.zoteroKey === "LOCPHOT2")!;
    const photo = sf.assets.find((a) => a.role === "original" && a.kind === "image")!;
    expect(photo.encrypted).toBe(true);
    expect(sf.pendingProxies?.map((j) => [j.type, j.location, j.assetId])).toEqual([["image.proxy", "coarsen", photo.id]]);
    // The original (with its GPS) is on disk only as an encrypted file.
    expect(photo.path).toMatch(/\.enc$/u);
    expect((await readFile(join(lib.root, photo.path))).subarray(0, 4).toString("latin1")).not.toBe("II*\0");
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

  /** A Zotero item with a stored PDF and one highlight carrying a sort index, served in full (R196 b). */
  async function serveHighlighted(): Promise<void> {
    const pdf = await buildPdf({ extra: "sort index" });
    const items: WebItem[] = [
      article("SORT0001", "Sorted", 7),
      { key: "SORTATT1", version: 7, data: { key: "SORTATT1", version: 7, itemType: "attachment", parentItem: "SORT0001", linkMode: "imported_file", contentType: "application/pdf", filename: "s.pdf", tags: [] } },
      { key: "SORTANN1", version: 7, data: { key: "SORTANN1", version: 7, itemType: "annotation", parentItem: "SORTATT1", annotationType: "highlight", annotationText: "informal markets", annotationSortIndex: "00000|000100|00200", annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[10, 20, 110, 40]] }), dateAdded: "2024-02-02T09:00:00Z", tags: [] } },
    ];
    serveItems(items, 30, { times: 20 });
    serveCollections([]);
    serveTagColors();
    agent.get(API).intercept({ path: "/users/42/items/SORTATT1/file", method: "GET" }).reply(302, "", { headers: { location: `${STORAGE}/sorted` } }).persist();
    agent.get(STORAGE).intercept({ path: "/sorted", method: "GET" }).reply(200, pdf, { headers: { "content-type": "application/pdf", "content-length": String(pdf.length) } }).persist();
  }
  const sortedSource = async (p: Project) => (await sources(p)).find((s) => s.source.provenance.externalKeys?.zoteroKey === "SORT0001")!;
  const stripIndex = async (p: Project, id: string) => {
    const { importChange } = await import("../repo/repo.js");
    await importChange(repo, p.id, { action: "store", store: { identifiable: false, hasLocation: false } }, async (ops) => {
      const cur = await ops.readSource(id);
      await ops.writeSource(cur, { ...cur, annotations: cur.annotations.map((a) => ({ ...a, anchors: a.anchors.map((x) => (x.kind === "pdf" ? { id: x.id, kind: x.kind, assetId: x.assetId, page: x.page, rects: x.rects } : x)) })) });
    }, { op: "test.strip-sort-index" });
  };

  it("R196 (b): a FULL run back-fills the sort index of an unchanged item, writes nothing the second time, and reports no change", async () => {
    const p = await project();
    await serveHighlighted();
    await (await startZoteroWebImport(bulkDeps(), p.id, { ...web, full: true })).done;
    const s0 = await sortedSource(p);
    expect(s0.annotations[0]!.anchors[0]).toMatchObject({ sortIndex: "00000|000100|00200" });
    await stripIndex(p, s0.source.id);
    const before = await sortedSource(p);
    expect(before.annotations[0]!.anchors[0]).not.toHaveProperty("sortIndex");
    const h = await startZoteroWebImport(bulkDeps(), p.id, { ...web, full: true });
    const r = await h.done;
    expect(r.counts).toMatchObject({ updated: 0, created: 0, failed: 0, unchanged: 1 });
    const after = await sortedSource(p);
    expect(after.annotations[0]!.anchors[0]).toMatchObject({ sortIndex: "00000|000100|00200" });
    expect(after.annotations[0]!.externalHash).toBe(before.annotations[0]!.externalHash);
    expect(after.source.modifiedAt).toBe(before.source.modifiedAt);
    const folder = join(lib.root, after.source.folder);
    const m1 = (await stat(join(folder, "annotations.json"))).mtimeMs;
    await new Promise((res) => setTimeout(res, 30));
    await (await startZoteroWebImport(bulkDeps(), p.id, { ...web, full: true })).done;
    expect((await stat(join(folder, "annotations.json"))).mtimeMs).toBe(m1);
    await createBulkImport(bulkDeps()).undoBatch(p.id, h.batchId);
    expect((await sortedSource(p)).annotations[0]!.anchors[0]).not.toHaveProperty("sortIndex");
  });

  it("R196 (b): an INCREMENTAL run does not fetch unchanged items, back-fills nothing and breaks nothing", async () => {
    const p = await project();
    await serveHighlighted();
    await (await startZoteroWebImport(bulkDeps(), p.id, { ...web, full: true })).done;
    await stripIndex(p, (await sortedSource(p)).source.id);
    agent
      .get(API)
      .intercept({ path: (q) => q.startsWith("/users/42/items?") && page(q).get("since") === "30", method: "GET" })
      .reply(200, "[]", { headers: { ...JSON_HEADERS, "total-results": "0", "last-modified-version": "30" } })
      .persist();
    agent
      .get(API)
      .intercept({ path: (q) => q.startsWith("/users/42/deleted?"), method: "GET" })
      .reply(200, JSON.stringify({ collections: [], items: [], searches: [], tags: [], settings: [] }), { headers: { ...JSON_HEADERS, "last-modified-version": "30" } })
      .persist();
    const r = await (await startZoteroWebImport(bulkDeps(), p.id, web)).done;
    expect(r.state).toBe("finished");
    expect(r.counts.failed).toBe(0);
    expect((await sortedSource(p)).annotations[0]!.anchors[0]).not.toHaveProperty("sortIndex");
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

  describe("what holds since back (Z2), against the stand-in", () => {
    const U = "user:42";
    let z: FakeZotero;
    let zweb: ZoteroWebOptions;
    beforeEach(async () => {
      z = newFake();
      await setSecret("zotero-api-key", z.key);
      zweb = { libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {} };
    });
    const withFile = async (title: string, o: { storage?: "webdav"; stale?: boolean; redirect?: string } = {}) => {
      const p = z.addItem(U, { itemType: "journalArticle", title });
      const att = z.addItem(U, { itemType: "attachment", contentType: "application/pdf", filename: "f.pdf" }, {
        parent: p,
        file: { bytes: await buildPdf({ extra: title }), ...(o.storage ? { storage: o.storage } : {}), ...(o.stale ? { stale: await buildPdf({ extra: `old ${title}` }) } : {}), ...(o.redirect ? { redirect: o.redirect } : {}) },
      });
      return { p, att };
    };
    /** Runs once with the trouble in place; returns since afterwards and the scan result. */
    const runOnce = async (p: Project, o: Partial<ZoteroWebOptions> = {}) => {
      const h = await startZoteroWebImport(bulkDeps(), p.id, { ...zweb, ...o });
      const r = await h.done;
      return { r, since: zoteroWebSince(repo, p.id, U), batchId: h.batchId };
    };

    it("a refused redirect names the host only and does not hold since back", async () => {
      const p = await project();
      await withFile("Elsewhere", { redirect: "https://unknown-host.example.net/zoterofilestorage/" });
      const { r, since } = await runOnce(p);
      expect(r.state).toBe("finished");
      expect(since).toBe(z.libraryVersion(U));
      const report = await createBulkImport(bulkDeps()).batchReport(p.id, (await createBulkImport(bulkDeps()).listBatches(p.id))[0]!.batchId);
      expect(JSON.stringify(report)).not.toMatch(/sig=|unknown-host\.example\.net\/|zoterofilestorage/u);
      // The scan result names the host, and nothing more.
      const a = zoteroWebAdapter(zweb);
      const work = join(tmp, "w-refused");
      await mkdir(work, { recursive: true });
      for await (const _ of a.scan(new AbortController().signal, { workDir: async () => work })) void _;
      expect(a.scanResult().refusedHosts).toEqual(["unknown-host.example.net"]);
    });

    it("a missing (WebDAV) file does not hold since back; the item comes in with its highlight, unanchored", async () => {
      const p = await project();
      const { p: key, att } = await withFile("On WebDAV", { storage: "webdav" });
      z.addItem(U, { itemType: "annotation", annotationType: "highlight", annotationText: "kept", annotationPosition: JSON.stringify({ pageIndex: 2, rects: [[1, 2, 3, 4]] }) }, { parent: att });
      const { r, since } = await runOnce(p);
      expect(r.counts.failed).toBe(0);
      expect(since).toBe(z.libraryVersion(U));
      const sf = (await sources(p)).find((s) => s.source.provenance.externalKeys?.zoteroKey === key)!;
      expect(sf.assets).toEqual([]);
      expect(sf.annotations.map((a) => [a.kind, a.quote, a.anchors])).toEqual([["highlight", "kept", []]]);
    });

    it("a file whose checksum never matches is noted after N tries and does not hold since back", async () => {
      const p = await project();
      const { att } = await withFile("Older copy", { storage: "webdav", stale: true });
      const { r, since, batchId } = await runOnce(p);
      expect(r.state).toBe("finished");
      expect(z.requests.filter((q) => q.path.endsWith(`/items/${att}/file`))).toHaveLength(3);
      expect(since).toBe(z.libraryVersion(U));
      const report = await createBulkImport(bulkDeps()).batchReport(p.id, batchId);
      expect(JSON.stringify(report)).toContain(ZOTERO_WEB_FILE_NOTES.checksum);
    });

    it("a key that may not read files does not hold since back", async () => {
      const p = await project();
      z.setKeyAccess({ files: false });
      await withFile("No file access");
      const { r, since } = await runOnce(p);
      expect(r.counts.failed).toBe(0);
      expect(since).toBe(z.libraryVersion(U));
    });

    it("a 5xx on a file holds since back", async () => {
      const p = await project();
      const { att } = await withFile("Server error");
      z.failFile(U, att, { api: 500 });
      const { r, since } = await runOnce(p, { maxRetries: 1 });
      expect(r.state).toBe("finished");
      expect(since).toBeUndefined();
    });

    it("a connection cut in the middle of a file holds since back", async () => {
      const p = await project();
      const { att } = await withFile("Cut");
      z.failFile(U, att, { storage: "cut" });
      const { r, since } = await runOnce(p, { maxRetries: 1 });
      expect(r.state).toBe("finished");
      expect(since).toBeUndefined();
    });

    it("a back-off that was waited out does not hold since back (A4)", async () => {
      const p = await project();
      z.addItem(U, { itemType: "book", title: "Slowly" });
      z.backoffOnce(30);
      const { r, since } = await runOnce(p);
      expect(r.state).toBe("finished");
      expect(r.counts.created + r.counts.needsReview).toBe(1);
      expect(since).toBe(z.libraryVersion(U));
      // A 429 with Retry-After that then succeeded: the same.
      const p2 = await project();
      z.failNext(1, 429, 5);
      expect((await runOnce(p2)).since).toBe(z.libraryVersion(U));
    });

    it("a full run whose key list cannot be had records no version; the next run is full and makes the check (M11, A6)", async () => {
      const p = await project();
      // A first full run that does not record the version (its one file fails for a passing reason).
      const keep = z.addItem(U, { itemType: "journalArticle", title: "Stays" });
      const { att } = await withFile("Its file fails first");
      const removed = z.addItem(U, { itemType: "journalArticle", title: "Deleted in Zotero before the next run" });
      z.failFile(U, att, { api: 500 });
      expect((await runOnce(p, { maxRetries: 0 })).since).toBeUndefined();
      z.failFile(U, att, null);
      z.remove(U, removed);
      // The second run is full (nothing recorded); its key list fails every time.
      const serve = z.serve.bind(z);
      const isKeyList = (path: string) => path.startsWith("/users/42/items?") && page(path).get("format") === "versions";
      let refused = 0;
      z.serve = (req, host) => {
        const r = serve(req, host); // recorded as usual
        if (!isKeyList(req.path)) return r;
        refused++;
        return { status: 500, headers: { "content-type": "text/plain" }, body: "busy" };
      };
      const second = await runOnce(p, { maxRetries: 0 });
      expect(second.r.counts.failed).toBe(0);
      expect(refused).toBe(3);
      expect(second.since).toBeUndefined(); // not finished: the version is not recorded (A6)
      // The third run is full again; the key list answers: the version is recorded, and the deleted item is gone.
      z.serve = serve;
      z.requests.length = 0;
      const third = await runOnce(p);
      expect(z.requests.filter((q) => q.path.startsWith("/users/42/items?") && page(q.path).get("format") === "json").every((q) => !page(q.path).has("since"))).toBe(true);
      expect(z.requests.filter((q) => isKeyList(q.path))).toHaveLength(1);
      expect(third.since).toBe(z.libraryVersion(U));
      // What that full run yields for the removed item (the engine passes gone items by until Z5): gone.
      const a = zoteroWebAdapter(zweb);
      const work = join(tmp, "w-m11");
      await mkdir(work, { recursive: true });
      const gone: ScanItem[] = [];
      for await (const i of a.scan(new AbortController().signal, { workDir: async () => work, knownIds: () => new Set([`${U}/${keep}`, `${U}/${removed}`]) })) if (i.gone) gone.push(i);
      expect(gone.map((i) => [i.key, i.gone])).toEqual([[`zotero:${removed}`, "deleted"]]);
    });

    it("a 429 that outlasts its retries holds since back", async () => {
      const p = await project();
      z.addItem(U, { itemType: "book", title: "Too busy" });
      z.failNext(10, 429, 5);
      const { r, since } = await runOnce(p, { maxRetries: 1 });
      expect(r.counts.failed).toBe(1);
      expect(since).toBeUndefined();
    });

    it("imports, records the library version, then asks only since it; Zotero deletions are yielded as gone and only marked here (Z5)", async () => {
      const p = await project();
      const a1 = z.addItem(U, { itemType: "journalArticle", title: "First title" });
      const a2 = z.addItem(U, { itemType: "journalArticle", title: "Second", DOI: "10.5555/ao.web.2024.002" });
      const r = await (await startZoteroWebImport(bulkDeps(), p.id, zweb)).done;
      expect(r.counts.created + r.counts.needsReview).toBe(2);
      const v1 = z.libraryVersion(U);
      expect(zoteroWebSince(repo, p.id, U)).toBe(v1);
      const sfs = await sources(p);
      expect(sfs.every((sf) => sf.source.provenance.captureMethod === "zotero_import" && sf.source.provenance.tool.name === "zotero-web-import")).toBe(true);
      const audit = (await readdir(join(lib.root, p.folder, "audit"))).map((f) => join(lib.root, p.folder, "audit", f));
      expect((await Promise.all(audit.map((f) => readFile(f, "utf8")))).join("\n")).toContain("project.import-settings.zotero-web");
      const before = await Promise.all(repo.listSourceIds(p.id).map((id) => repo.getSource(p.id, id)));
      z.editItem(U, a1, { title: "First title, revised" });
      z.remove(U, a2);
      z.requests.length = 0;
      const h2 = await startZoteroWebImport(bulkDeps(), p.id, zweb);
      const r2 = await h2.done;
      expect(z.requests.filter((q) => q.path.startsWith("/users/42/items?")).every((q) => page(q.path).get("since") === String(v1))).toBe(true);
      expect(r2.counts).toMatchObject({ updated: 1, created: 0, failed: 0 });
      expect(repo.listSourceIds(p.id)).toHaveLength(2); // the Zotero deletion was not applied here
      // Z5: the source is kept and marked; nothing else of it changes.
      const second = (await sources(p)).find((sf) => sf.source.provenance.externalKeys?.zoteroKey === a2)!;
      const was = before.find((sf) => sf.source.provenance.externalKeys?.zoteroKey === a2)!;
      expect(second.source.availability).toEqual({ status: "unavailable-on-platform", zotero: "deleted", firstNoticedAt: expect.any(String) });
      expect({ ...second, source: { ...second.source, availability: was.source.availability } }).toEqual(was);
      const report = await createBulkImport(bulkDeps()).batchReport(p.id, h2.batchId);
      expect(report.notes).toContain("1 item you have here was deleted in Zotero since the last sync; it was kept here and marked.");
      expect(r2.counts).toMatchObject({ goneInZotero: 1 });
      expect(zoteroWebSince(repo, p.id, U)).toBe(z.libraryVersion(U));
      const rec = JSON.parse(await readFile(join(lib.root, p.folder, "imports", "batch-0002", "batch.json"), "utf8"));
      expect(rec.adapterOptions).toEqual({ zoteroSince: v1, zoteroFiles: true, zoteroReadVersions: [z.libraryVersion(U)] });
      expect(rec.recordedLibraryVersion).toBe(z.libraryVersion(U));
    });
  });

  describe("no file downloaded twice (Z4), against the stand-in", () => {
    const U = "user:42";
    const REMOVED_NOTE = "An attached file you removed here was not brought in again.";
    const NOT_CONFIRMED = "This sync could not confirm which items were deleted in Zotero, so the next sync will read the whole library again.";
    let z: FakeZotero;
    let zweb: ZoteroWebOptions;
    beforeEach(async () => {
      z = newFake();
      await setSecret("zotero-api-key", z.key);
      zweb = { libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {} };
    });
    const pos = (page: number) => JSON.stringify({ pageIndex: page - 1, rects: [[10, 20, 110, 40]] });
    /** An article with a stored PDF and one highlight on page 1. */
    const withHighlightedFile = async (title: string) => {
      const p = z.addItem(U, { itemType: "journalArticle", title, tags: [{ tag: "first" }] });
      const att = z.addItem(U, { itemType: "attachment", contentType: "application/pdf", filename: "f.pdf" }, { parent: p, file: { bytes: await buildPdf({ extra: title }) } });
      const ann = z.addItem(U, { itemType: "annotation", annotationType: "highlight", annotationText: "informal markets", annotationColor: "#ffd400", annotationPosition: pos(1) }, { parent: att });
      return { p, att, ann };
    };
    const run = async (p: Project, o: Partial<ZoteroWebOptions> = {}) => {
      const h = await startZoteroWebImport(bulkDeps(), p.id, { ...zweb, ...o });
      const r = await h.done;
      return { r, batchId: h.batchId, report: await createBulkImport(bulkDeps()).batchReport(p.id, h.batchId) };
    };
    const fileRequests = (att: string) => z.requests.filter((q) => q.path.endsWith(`/items/${att}/file`)).length;
    const storageRequests = () => z.requests.filter((q) => q.path.startsWith("/zoterofilestorage/")).length;
    const sourceOf = async (p: Project, key: string) => (await sources(p)).find((s) => s.source.provenance.externalKeys?.zoteroKey === key)!;
    const journalPath = (p: Project, n: number) => join(lib.root, p.folder, "imports", `batch-${String(n).padStart(4, "0")}`, "journal.jsonl");
    const journal = async (p: Project, n: number) => (await readFile(journalPath(p, n), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
    /** Rewrites a batch's journal lines (an unencrypted project's journal is plain JSON lines). */
    const rewriteJournal = async (p: Project, n: number, change: (e: Record<string, any>) => Record<string, any>) => {
      const { writeFile } = await import("node:fs/promises");
      const lines = await journal(p, n);
      await writeFile(journalPath(p, n), lines.map((e) => JSON.stringify(change(e))).join("\n") + "\n");
    };
    /** A new file version uploaded in Zotero: new bytes, md5 and version (the stand-in's public replaceFile, M7). */
    const uploadNewFile = (att: string, bytes: Uint8Array) => z.replaceFile(U, att, bytes);

    it("a tag added in Zotero does not download the PDF again", async () => {
      const p = await project();
      const { p: key, att } = await withHighlightedFile("Tagged later");
      const first = await run(p);
      expect(first.r.counts.failed).toBe(0);
      expect(fileRequests(att)).toBe(1);
      const before = await sourceOf(p, key);
      expect(before.assets).toHaveLength(1);
      const asset = before.assets[0]!;
      expect(before.annotations[0]!.anchors[0]).toMatchObject({ kind: "pdf", assetId: asset.id, page: 1 });
      // The journal records the attachment's version and the hash of the asset it became.
      const line = (await journal(p, 1)).find((e) => e.ext?.id === `${U}/${key}`)!;
      expect(line.ext.parts).toEqual({ [att]: { v: expect.any(Number), sha256: asset.sha256 } });
      z.editItem(U, key, { tags: [{ tag: "first" }, { tag: "added in Zotero" }] });
      z.requests.length = 0;
      const second = await run(p);
      expect(second.r.counts).toMatchObject({ updated: 1, failed: 0 });
      expect(fileRequests(att)).toBe(0);
      expect(storageRequests()).toBe(0);
      const after = await sourceOf(p, key);
      expect(after.assets.map((a) => a.id)).toEqual([asset.id]);
      expect(after.annotations.map((a) => [a.id, a.anchors[0]?.assetId, a.externalHash])).toEqual(before.annotations.map((a) => [a.id, a.anchors[0]?.assetId, a.externalHash]));
      expect(after.source.tagIds.length).toBe(before.source.tagIds.length + 1);
      // The part is carried into the new line, so the run after that skips it too.
      const line2 = (await journal(p, 2)).find((e) => e.ext?.id === `${U}/${key}`)!;
      expect(line2.ext.parts).toEqual(line.ext.parts);
      expect(zoteroWebSince(repo, p.id, U)).toBe(z.libraryVersion(U));
    });

    it("a changed highlight on a known file anchors in the stored asset", async () => {
      const p = await project();
      const { p: key, att, ann } = await withHighlightedFile("Highlight changed");
      await run(p);
      const asset = (await sourceOf(p, key)).assets[0]!;
      z.editItem(U, ann, { annotationText: "informal markets and credit", annotationPosition: pos(2) });
      z.addItem(U, { itemType: "annotation", annotationType: "highlight", annotationText: "a new one", annotationPosition: pos(3) }, { parent: att });
      z.requests.length = 0;
      const second = await run(p);
      expect(second.r.counts).toMatchObject({ updated: 1, failed: 0 });
      expect(fileRequests(att)).toBe(0);
      const sf = await sourceOf(p, key);
      expect(sf.assets.map((a) => a.id)).toEqual([asset.id]);
      expect(sf.annotations.map((a) => [a.quote, a.anchors.map((x) => (x.kind === "pdf" ? [x.assetId, x.page] : null))]).sort()).toEqual(
        [
          ["a new one", [[asset.id, 3]]],
          ["informal markets and credit", [[asset.id, 2]]],
        ].sort(),
      );
    });

    it("a new file version is downloaded", async () => {
      const p = await project();
      const { p: key, att } = await withHighlightedFile("New file version");
      await run(p);
      const old = (await sourceOf(p, key)).assets[0]!;
      const fresh = await buildPdf({ extra: "the second version of the file" });
      uploadNewFile(att, fresh);
      z.requests.length = 0;
      const second = await run(p);
      expect(second.r.counts.failed).toBe(0);
      expect(fileRequests(att)).toBe(1);
      const sf = await sourceOf(p, key);
      expect(sf.assets.map((a) => a.sha256).sort()).toEqual([old.sha256, createHash("sha256").update(fresh).digest("hex")].sort());
      // The newer part is recorded: the run after that does not fetch it again.
      z.editItem(U, key, { title: "Retitled" });
      z.requests.length = 0;
      await run(p);
      expect(fileRequests(att)).toBe(0);
    });

    it("a part that failed is downloaded again next run", async () => {
      const p = await project();
      const { p: key, att } = await withHighlightedFile("Fails first");
      z.failFile(U, att, { api: 500 });
      const first = await run(p, { maxRetries: 0 });
      expect(first.r.counts.failed).toBe(0);
      const line = (await journal(p, 1)).find((e) => e.ext?.id === `${U}/${key}`)!;
      expect(line.ext.parts).toBeUndefined(); // a failed download leaves no part
      expect(zoteroWebSince(repo, p.id, U)).toBeUndefined();
      z.failFile(U, att, null);
      z.requests.length = 0;
      await run(p);
      expect(fileRequests(att)).toBe(1);
      const sf = await sourceOf(p, key);
      expect(sf.assets).toHaveLength(1);
      expect(sf.annotations[0]!.anchors[0]).toMatchObject({ assetId: sf.assets[0]!.id });
      z.requests.length = 0;
      await run(p, { full: true });
      expect(fileRequests(att)).toBe(0);
    });

    it("an item imported before this task matches as unchanged; a journal line without parts downloads once more, then never", async () => {
      const p = await project();
      const { p: key, att } = await withHighlightedFile("Imported before Z4");
      await run(p);
      const before = await sourceOf(p, key);
      // The journal line as the code BEFORE this task wrote it for this very item (I3): `ext` with the id and the
      // token that code computed, and no parts. The token below was produced by the pre-Z4 adapter (7ca50c9's
      // zotero-web.ts, scanning the same stand-in library: the stand-in's keys and versions are deterministic),
      // and is written here literally, so that any change to the token's computation makes this item "updated".
      const OLD_EXT = { id: "user:42/22222DD5", version: "w1-0fb11037c4fab05f" };
      expect(`${U}/${key}`).toBe(OLD_EXT.id);
      // The new code computes the same token for the same item (an "unchanged" count alone would not show it:
      // a changed token on an unchanged item also ends "unchanged", through the update path).
      expect((await journal(p, 1)).find((e) => e.ext)!.ext.version).toBe(OLD_EXT.version);
      await rewriteJournal(p, 1, (e) => (e.ext ? { ...e, ext: OLD_EXT } : e));
      expect((await journal(p, 1)).filter((e) => e.ext).map((e) => e.ext)).toEqual([OLD_EXT]);
      z.requests.length = 0;
      const second = await run(p, { full: true });
      // The same token: unchanged. The file is fetched once more (nothing says it is stored) and dropped by its hash.
      expect(second.r.counts).toMatchObject({ unchanged: 1, updated: 0, created: 0, failed: 0 });
      expect(fileRequests(att)).toBe(1);
      const after = await sourceOf(p, key);
      expect(after.assets.map((a) => a.id)).toEqual(before.assets.map((a) => a.id));
      expect(after).toEqual(before);
      // That run matched the old line's token (no update) and wrote the part: never again.
      const line2 = (await journal(p, 2)).find((e) => e.ext?.id === `${U}/${key}`)!;
      expect(line2.ext.version).toBe(OLD_EXT.version);
      expect(line2.snapshot).toBeUndefined(); // nothing was written to the source
      expect(line2.ext.parts).toEqual({ [att]: { v: expect.any(Number), sha256: before.assets[0]!.sha256 } });
      z.requests.length = 0;
      const third = await run(p, { full: true });
      expect(third.r.counts).toMatchObject({ unchanged: 1, failed: 0 });
      expect(fileRequests(att)).toBe(0);
    });

    it("an asset the researcher removed here is not brought back, and the run says so", async () => {
      const p = await project();
      const { p: key, att } = await withHighlightedFile("Destroyed here");
      await run(p);
      const before = await sourceOf(p, key);
      const { destroyRaw } = await import("../retention.js");
      await destroyRaw(repo, p.id, [before.assets[0]!.id], "Researcher");
      const destroyed = await sourceOf(p, key);
      expect(destroyed.assets[0]!.status).toBe("destroyed");
      // An unchanged item in a full run, then a changed one in the next: neither fetches the file nor brings it back.
      z.requests.length = 0;
      const second = await run(p, { full: true });
      expect(second.r.counts).toMatchObject({ unchanged: 1, failed: 0 });
      expect(fileRequests(att)).toBe(0);
      expect(second.report.notes.filter((n) => n === REMOVED_NOTE)).toHaveLength(1);
      expect(second.report.fileNotes).toEqual([{ item: expect.any(String), note: "an attached file you removed here was not brought in again" }]);
      z.editItem(U, key, { title: "Retitled in Zotero" });
      z.requests.length = 0;
      const third = await run(p);
      expect(third.r.counts).toMatchObject({ updated: 1, failed: 0 });
      expect(fileRequests(att)).toBe(0);
      expect(third.report.notes).toContain(REMOVED_NOTE);
      const after = await sourceOf(p, key);
      expect(after.assets).toEqual(destroyed.assets);
      // Its highlight stays as it was (anchored in the same asset entry, as before).
      expect(after.annotations).toEqual(destroyed.annotations);
    });

    it("a hash that matches no asset of the source is not anchored by guess: the file is downloaded and its copy's hash finds the asset (I1)", async () => {
      const p = await project();
      const { p: key, att } = await withHighlightedFile("Journal disagrees");
      await run(p);
      const before = await sourceOf(p, key);
      // The journal names a hash no asset of the source has: nothing says the researcher removed anything.
      await rewriteJournal(p, 1, (e) => (e.ext?.parts ? { ...e, ext: { ...e.ext, parts: { [att]: { ...e.ext.parts[att], sha256: "0".repeat(64) } } } } : e));
      z.addItem(U, { itemType: "annotation", annotationType: "highlight", annotationText: "added in Zotero", annotationPosition: pos(4) }, { parent: att });
      z.requests.length = 0;
      const second = await run(p);
      expect(second.r.counts.failed).toBe(0);
      expect(fileRequests(att)).toBe(1); // not known: fetched as any missing file is
      const sf = await sourceOf(p, key);
      expect(sf.assets).toEqual(before.assets); // the copy is dropped by its hash: the asset was there all along
      // Both highlights are anchored in the real asset, found by the downloaded copy's hash, never by the journal's.
      expect(sf.annotations.map((a) => [a.quote, a.anchors.map((x) => (x.kind === "pdf" ? x.assetId : null))]).sort()).toEqual(
        [
          ["added in Zotero", [before.assets[0]!.id]],
          ["informal markets", [before.assets[0]!.id]],
        ].sort(),
      );
      expect(second.report.notes).not.toContain(REMOVED_NOTE);
      // That run recorded the true hash: the next one skips the file.
      z.editItem(U, key, { title: "Retitled" });
      z.requests.length = 0;
      await run(p);
      expect(fileRequests(att)).toBe(0);
    });

    it("an undone batch's file comes back with its highlights anchored, even when a later sync carried its part; a file the researcher removed here does not (I1)", async () => {
      const p = await project();
      const undone = await withHighlightedFile("Its file was brought in by a batch later undone");
      const removed = await withHighlightedFile("Its file the researcher removed here");
      // 1: the first file fails, so its item comes in without it (and the version is not recorded).
      z.failFile(U, undone.att, { api: 500 });
      await run(p, { maxRetries: 0 });
      z.failFile(U, undone.att, null);
      // 2: the file is added to the existing source (an update); this is the batch that will be undone.
      const second = await run(p);
      expect((await sourceOf(p, undone.p)).assets).toHaveLength(1);
      // 3: a tag changed in Zotero; the file is skipped, its part carried into this line.
      z.editItem(U, undone.p, { tags: [{ tag: "first" }, { tag: "later" }] });
      z.requests.length = 0;
      await run(p);
      expect(fileRequests(undone.att)).toBe(0);
      // The researcher destroys the other item's file here (retention); batch 2 is undone.
      const { destroyRaw } = await import("../retention.js");
      await destroyRaw(repo, p.id, [(await sourceOf(p, removed.p)).assets[0]!.id], "Researcher");
      await createBulkImport(bulkDeps()).undoBatch(p.id, second.batchId);
      expect((await sourceOf(p, undone.p)).assets).toEqual([]);
      // 4: a full run. The undone file is downloaded again and its highlight anchored in it; the removed one is not.
      z.editItem(U, undone.p, { title: "Retitled in Zotero" });
      z.requests.length = 0;
      const fourth = await run(p, { full: true });
      expect(fourth.r.counts.failed).toBe(0);
      expect(fileRequests(undone.att)).toBe(1);
      expect(fileRequests(removed.att)).toBe(0);
      const back = await sourceOf(p, undone.p);
      expect(back.assets).toHaveLength(1);
      expect(back.annotations[0]!.anchors[0]).toMatchObject({ kind: "pdf", assetId: back.assets[0]!.id });
      expect((await sourceOf(p, removed.p)).assets.map((a) => a.status)).toEqual(["destroyed"]);
      // The run says so for the removed one only: once.
      expect(fourth.report.notes.filter((n) => n === REMOVED_NOTE)).toHaveLength(1);
      expect(fourth.report.fileNotes).toEqual([{ item: expect.any(String), note: "an attached file you removed here was not brought in again" }]);
    });

    it("a source deleted here: a full run does not download its file and keeps it deleted; with includeDeleted the file comes in again (M1)", async () => {
      const p = await project();
      const { p: key, att } = await withHighlightedFile("Deleted here");
      await run(p);
      await repo.deleteSource(p.id, (await sourceOf(p, key)).source.id);
      z.requests.length = 0;
      const second = await run(p, { full: true });
      expect(second.r.counts).toMatchObject({ deletedHere: 1, created: 0, failed: 0 });
      expect(fileRequests(att)).toBe(0);
      expect(repo.listSourceIds(p.id)).toEqual([]);
      // Brought back on request: the file is needed then, and fetched.
      z.requests.length = 0;
      const h = await startZoteroWebImport(bulkDeps(), p.id, { ...zweb, full: true }, { includeDeleted: true });
      expect((await h.done).counts.created + (await h.done).counts.needsReview).toBe(1);
      expect(fileRequests(att)).toBe(1);
      const back = await sourceOf(p, key);
      expect(back.annotations[0]!.anchors[0]).toMatchObject({ assetId: back.assets[0]!.id });
    });

    it("a downloaded file the engine does not store records no part, and the next full run asks for it again (I2)", async () => {
      const p = await project();
      const key = z.addItem(U, { itemType: "journalArticle", title: "Its file is not a supported kind" });
      // Zotero says PDF; the bytes are plain text: the engine leaves the file out (not supported).
      const att = z.addItem(U, { itemType: "attachment", contentType: "application/pdf", filename: "f.pdf" }, { parent: key, file: { bytes: Buffer.from("just some words, not a PDF\n") } });
      const first = await run(p);
      expect(first.r.counts.failed).toBe(0);
      expect((await sourceOf(p, key)).assets).toEqual([]);
      expect(fileRequests(att)).toBe(1);
      const line = (await journal(p, 1)).find((e) => e.ext?.id === `${U}/${key}`)!;
      expect(line.ext.parts).toBeUndefined();
      z.requests.length = 0;
      await run(p, { full: true });
      expect(fileRequests(att)).toBe(1);
    });

    it("a recoloured highlight on a known file keeps its colour after a run in which the file was skipped", async () => {
      const p = await project();
      const { p: key, att } = await withHighlightedFile("Recoloured here");
      await run(p);
      const sf0 = await sourceOf(p, key);
      await repo.updateAnnotation(p.id, sf0.source.id, sf0.annotations[0]!.id, { colorName: "blue" });
      z.editItem(U, key, { tags: [{ tag: "first" }, { tag: "second" }] });
      z.requests.length = 0;
      await run(p);
      expect(fileRequests(att)).toBe(0);
      z.requests.length = 0;
      await run(p, { full: true });
      expect(fileRequests(att)).toBe(0);
      const sf = await sourceOf(p, key);
      expect(sf.annotations[0]).toMatchObject({ colorName: "blue", id: sf0.annotations[0]!.id });
      expect(sf.annotations[0]!.anchors[0]).toMatchObject({ assetId: sf0.assets[0]!.id });
    });

    it("a run suspended and resumed fetches no file twice, the one in hand at the suspend included", async () => {
      const p = await project();
      const atts: string[] = [];
      for (let i = 0; i < 6; i++) atts.push((await withHighlightedFile(`Item ${i}`)).att);
      const h = await startZoteroWebImport(bulkDeps(), p.id, zweb);
      for await (const e of h.progress) {
        if (e.done >= 2) {
          await h.suspend();
          break;
        }
      }
      expect((await h.done).state).toBe("paused");
      // The resume rebuilds the adapter from the batch record (no test seams): the stand-in serves as the global dispatcher.
      const { getGlobalDispatcher, setGlobalDispatcher } = await import("undici");
      const previous = getGlobalDispatcher();
      setGlobalDispatcher(z.agent);
      let r;
      try {
        const { resumeZoteroWebImport } = await import("./zotero-web.js");
        r = await (await resumeZoteroWebImport(bulkDeps(), p.id, h.batchId)).done;
      } finally {
        setGlobalDispatcher(previous);
      }
      expect(r.state).toBe("finished");
      expect(r.counts.created + r.counts.needsReview).toBe(6);
      expect(atts.map((a) => fileRequests(a))).toEqual(atts.map(() => 1));
      expect(storageRequests()).toBe(6);
      expect(zoteroWebSince(repo, p.id, U)).toBe(z.libraryVersion(U));
    });

    it("a key list that cannot be had: the run's notes say so once, and no version is recorded (A7)", async () => {
      const p = await project();
      z.addItem(U, { itemType: "journalArticle", title: "Stays" });
      const gone = z.addItem(U, { itemType: "journalArticle", title: "Deleted in Zotero" });
      const { att } = await withHighlightedFile("Its file fails first");
      z.failFile(U, att, { api: 500 });
      await run(p, { maxRetries: 0 }); // not finished: the next run is full
      z.failFile(U, att, null);
      z.remove(U, gone);
      const serve = z.serve.bind(z);
      z.serve = (req, host) => {
        const r = serve(req, host);
        return req.path.startsWith("/users/42/items?") && page(req.path).get("format") === "versions" ? { status: 500, headers: { "content-type": "text/plain" }, body: "busy" } : r;
      };
      const second = await run(p, { maxRetries: 0 });
      expect(second.r.state).toBe("finished");
      expect(second.report.notes.filter((n) => n === NOT_CONFIRMED)).toHaveLength(1);
      expect(zoteroWebSince(repo, p.id, U)).toBeUndefined();
    });
  });

  describe("an annotation's author is only the one Zotero gave (D22), against the stand-in", () => {
    const U = "user:42";
    let z: FakeZotero;
    let zweb: ZoteroWebOptions;
    beforeEach(async () => {
      z = newFake();
      await setSecret("zotero-api-key", z.key);
      zweb = { libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {} };
    });
    const pos = (page: number) => JSON.stringify({ pageIndex: page - 1, rects: [[10, 20, 110, 40]] });
    const sourceOf = async (p: Project, key: string) => (await sources(p)).find((s) => s.source.provenance.externalKeys?.zoteroKey === key)!;
    const highlight = (parent: string, text: string, author?: string) =>
      z.addItem(U, { itemType: "annotation", annotationType: "highlight", annotationText: text, annotationColor: "#ffd400", annotationPosition: pos(1), ...(author ? { annotationAuthorName: author } : {}) }, { parent });
    const run = async (p: Project, o: Partial<ZoteroWebOptions> = {}) => {
      const h = await startZoteroWebImport(bulkDeps(), p.id, { ...zweb, ...o });
      return { r: await h.done, report: await createBulkImport(bulkDeps()).batchReport(p.id, h.batchId) };
    };

    it("an annotation without an author in Zotero has none here; one with an author keeps it", async () => {
      const p = await project();
      const key = z.addItem(U, { itemType: "journalArticle", title: "Whose highlight" });
      const att = z.addItem(U, { itemType: "attachment", contentType: "application/pdf", filename: "f.pdf" }, { parent: key, file: { bytes: await buildPdf({ extra: "whose" }) } });
      const none = highlight(att, "nobody's");
      const named = highlight(att, "a colleague's", "Ngozi Okafor");
      const note = z.addItem(U, { itemType: "note", note: "<p>A child note</p>" }, { parent: key });
      await run(p);
      const sf = await sourceOf(p, key);
      const by = (k: string) => sf.annotations.find((a) => a.externalKey === `zotero:${k}`)!;
      expect(by(none)).not.toHaveProperty("author");
      expect(by(named).author).toBe("Ngozi Okafor");
      expect(by(note)).not.toHaveProperty("author");
      // The repository's actor (here "tester"; the computer's account name in the app) is nowhere in the annotations.
      expect(await readFile(join(lib.root, sf.source.folder, "annotations.json"), "utf8")).not.toContain("tester");
    });

    it("a re-import over annotations stored with the old fallback changes nothing the researcher did", async () => {
      const p = await project();
      const key = z.addItem(U, { itemType: "journalArticle", title: "Stored before the fix" });
      const att = z.addItem(U, { itemType: "attachment", contentType: "application/pdf", filename: "f.pdf" }, { parent: key, file: { bytes: await buildPdf({ extra: "before" }) } });
      const recoloured = highlight(att, "recoloured here");
      const deleted = highlight(att, "deleted here");
      const untouched = highlight(att, "untouched");
      const changed = highlight(att, "changed in Zotero");
      await run(p);
      const id = (await sourceOf(p, key)).source.id;
      // As stored before D22 was fixed: every imported annotation carries the computer's account name.
      const { importChange } = await import("../repo/repo.js");
      await importChange(repo, p.id, { action: "store", store: { identifiable: false, hasLocation: false } }, async (ops) => {
        const cur = await ops.readSource(id);
        await ops.writeSource(cur, { ...cur, annotations: cur.annotations.map((a) => ({ ...a, author: "root" })) });
      }, { op: "test.old-fallback" });
      const ext = (k: string) => (sf: SourceFile) => sf.annotations.find((a) => a.externalKey === `zotero:${k}`);
      const sf0 = await repo.getSource(p.id, id);
      await repo.updateAnnotation(p.id, id, ext(recoloured)(sf0)!.id, { colorName: "purple", body: "my note" });
      await repo.deleteAnnotation(p.id, id, ext(deleted)(sf0)!.id);
      const annFile = join(lib.root, sf0.source.folder, "annotations.json");

      // A full re-import with nothing changed in Zotero changes nothing: the old author is not a change by anyone.
      const bytes = await readFile(annFile);
      const quiet = await run(p, { full: true });
      expect(quiet.r.counts).toMatchObject({ unchanged: 1, updated: 0, failed: 0 });
      expect(await readFile(annFile)).toEqual(bytes);

      // Zotero changes one highlight: only that one is updated, keeping its stored author; the rest is as it was.
      z.editItem(U, changed, { annotationText: "changed in Zotero, revised" });
      const before = await repo.getSource(p.id, id);
      const { r, report } = await run(p);
      expect(r.counts).toMatchObject({ updated: 1, failed: 0 });
      expect(report.keptFields).toEqual([]);
      const after = await repo.getSource(p.id, id);
      expect(ext(changed)(after)).toMatchObject({ quote: "changed in Zotero, revised", author: "root" });
      expect(ext(recoloured)(after)).toEqual(ext(recoloured)(before));
      expect(ext(recoloured)(after)).toMatchObject({ colorName: "purple", body: "my note", author: "root" });
      expect(ext(untouched)(after)).toEqual(ext(untouched)(before));
      expect(ext(deleted)(after)).toBeUndefined();
      expect(after.annotations).toHaveLength(3);
    });
  });

  it("every request in this suite is a GET", async () => {
    // The after-each hook checks every request of every test (stand-ins and the plain mock agent). This
    // test makes requests of its own, so it proves the hook's input is there even when run alone (M9).
    const z = newFake();
    await setSecret("zotero-api-key", z.key);
    z.addItem("user:42", { itemType: "book", title: "Checked" });
    const work = join(tmp, "w-get");
    await mkdir(work, { recursive: true });
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {} });
    for await (const _ of a.scan(new AbortController().signal, { workDir: async () => work })) void _;
    expect(z.requests.length).toBeGreaterThan(0);
    expect(z.requests.every((r) => r.method === "GET")).toBe(true);
    expect(checked.requests >= checked.tests).toBe(true);
  });
});

// FR-764: a Zotero sync that is stopped hands nothing more to the network: the wait before a storage retry ends at once,
// and a stop that lands while the storage redirect is read keeps its request from the storage host.
describe("FR-764: a stopped sync asks the storage host nothing more", () => {
  /** Counts the requests handed to the network for the storage host; `abortAfter` aborts as one answer has ended. */
  class Watched extends Dispatcher {
    storage = 0;
    abortAfter?: { path: string; abort: () => void };
    constructor(private readonly inner: Dispatcher) {
      super();
    }
    override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      if (String(opts.origin) === STORAGE) this.storage++;
      const after = this.abortAfter;
      if (!after || String(opts.path) !== after.path) return this.inner.dispatch(opts, handler);
      // The answer ends first (its signal is let go), and the stop lands right after it.
      const wrapped = new Proxy(handler, {
        get(t, k) {
          if (k === "onResponseEnd" || k === "onComplete") {
            const f = Reflect.get(t, k) as ((...a: unknown[]) => unknown) | undefined;
            if (!f) return undefined;
            return (...a: unknown[]) => {
              const out = f.apply(t, a);
              after.abort();
              return out;
            };
          }
          const v = Reflect.get(t, k) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
      return this.inner.dispatch(opts, wrapped);
    }
    override close(): Promise<void> {
      return this.inner.close();
    }
    override destroy(): Promise<void> {
      return this.inner.destroy();
    }
  }

  async function serveOneFile(key: string): Promise<string> {
    const pdf = await buildPdf({ extra: `fr764 ${key}` });
    const md5 = createHash("md5").update(pdf).digest("hex");
    serveItems(
      [
        article(`P${key}`, "Stopped while its file came"),
        { key: `A${key}`, version: 9, data: { key: `A${key}`, version: 9, itemType: "attachment", parentItem: `P${key}`, linkMode: "imported_file", contentType: "application/pdf", filename: "f.pdf", md5, tags: [] } },
      ],
      9,
    );
    serveCollections([]);
    serveTagColors();
    agent.get(API).intercept({ path: `/users/42/items/A${key}/file`, method: "GET" }).reply(302, "", { headers: { location: `${STORAGE}/signed/${key}?sig=1` } }).persist();
    return `/users/42/items/A${key}/file`;
  }

  async function scanWith(net: Dispatcher, signal: AbortSignal, sleep: (ms: number) => Promise<void>): Promise<void> {
    const work = join(tmp, "work");
    await mkdir(work, { recursive: true, mode: 0o700 });
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: net, sleep });
    for await (const _ of a.scan(signal, { workDir: async () => work })) void _;
  }

  it("a sync stopped during the wait before a storage retry ends there, and the storage host is not asked again", async () => {
    await serveOneFile("WAIT64");
    agent.get(STORAGE).intercept({ path: "/signed/WAIT64?sig=1", method: "GET" }).reply(503, "busy").persist();
    const net = new Watched(agent);
    const ac = new AbortController();
    const reason = new Error("the sync was stopped");
    const waits: number[] = [];
    // Every other wait passes at once; the storage retry's wait never ends by itself: only the stop can end it.
    const sleep = (ms: number) => {
      if (net.storage === 0) return Promise.resolve();
      waits.push(ms);
      ac.abort(reason);
      return new Promise<void>(() => {});
    };
    await expect(scanWith(net, ac.signal, sleep)).rejects.toBe(reason);
    expect(waits).toHaveLength(1);
    expect(net.storage).toBe(1);
  });

  it("a sync stopped while the storage redirect is read asks the storage host nothing", async () => {
    const filePath = await serveOneFile("GAP64");
    const storageAnswers = vi.fn(() => ({ statusCode: 200, data: "x" }));
    agent.get(STORAGE).intercept({ path: "/signed/GAP64?sig=1", method: "GET" }).reply(storageAnswers).persist();
    const net = new Watched(agent);
    const ac = new AbortController();
    const reason = new Error("the sync was stopped");
    net.abortAfter = { path: filePath, abort: () => ac.abort(reason) };
    await expect(scanWith(net, ac.signal, async () => {})).rejects.toBe(reason);
    expect(net.storage).toBe(0);
    expect(storageAnswers).not.toHaveBeenCalled();
  });
});
