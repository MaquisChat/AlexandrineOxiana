import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
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
import { FakeZotero, guardNetwork } from "../../tests/zotero/fake-zotero.js";

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
    expect(notes).toContain("3 items were deleted in Zotero since the last sync; they were kept here and marked.");
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
    expect(no.fileNotes).toEqual([ZOTERO_WEB_FILE_NOTES.notInStorage]);
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
    const since = z.libraryVersion(U);
    z.trash(U, a);
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
    expect(notes).toContain("2 items were deleted in Zotero since the last sync; they were kept here and marked.");
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
    const cut = await scanFake({}, { knownIds: known("GONEGONE") });
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

  it("a library that changes during the scan (restarted) yields no unseen item as gone, and does not count as complete", async () => {
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
    expect(goneOf(items)).toEqual([]);
    expect(result.completed).toBe(false);
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
    expect(it0.annotations?.map((a) => [a.kind, a.quote ?? a.body, a.anchor])).toEqual(
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
    expect(ZOTERO_WEB_FILE_NOTES.notInStorage).toBe("attached file is not in Zotero's online storage (it may be kept on a WebDAV server)");
    const p = z.addItem(U, art("On WebDAV"));
    const att = await pdfAttachment(p, { storage: "webdav" });
    highlight(att, "webdav highlight");
    const q = z.addItem(U, art("Older copy in Zotero storage"));
    const qatt = await pdfAttachment(q, { storage: "webdav", stale: true });
    highlight(qatt, "stale highlight");
    const { items, result } = await scanFake();
    for (const [key, quote] of [
      [p, "webdav highlight"],
      [q, "stale highlight"],
    ] as const) {
      const it0 = items.find((i) => i.key === `zotero:${key}`)!;
      expect(it0.files).toEqual([]);
      expect(it0.fileNotes).toEqual([ZOTERO_WEB_FILE_NOTES.notInStorage]);
      expect(it0.annotations).toEqual([expect.objectContaining({ kind: "highlight", quote })]);
      expect(it0.annotations![0]).not.toHaveProperty("anchor");
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

    it("a missing (WebDAV) file does not hold since back", async () => {
      const p = await project();
      await withFile("On WebDAV", { storage: "webdav" });
      const { r, since } = await runOnce(p);
      expect(r.counts.failed).toBe(0);
      expect(since).toBe(z.libraryVersion(U));
    });

    it("a file whose checksum never matches is noted after N tries and does not hold since back", async () => {
      const p = await project();
      const { att } = await withFile("Older copy", { storage: "webdav", stale: true });
      const { r, since, batchId } = await runOnce(p);
      expect(r.state).toBe("finished");
      expect(z.requests.filter((q) => q.path.endsWith(`/items/${att}/file`))).toHaveLength(3);
      expect(since).toBe(z.libraryVersion(U));
      const report = await createBulkImport(bulkDeps()).batchReport(p.id, batchId);
      expect(JSON.stringify(report)).toContain(ZOTERO_WEB_FILE_NOTES.notInStorage);
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

    it("a back-off holds since back (and the run still finishes)", async () => {
      const p = await project();
      z.addItem(U, { itemType: "book", title: "Slowly" });
      z.backoffOnce(30);
      const { r, since } = await runOnce(p);
      expect(r.state).toBe("finished");
      expect(r.counts.created + r.counts.needsReview).toBe(1);
      expect(since).toBeUndefined();
      // The next run, with no back-off, moves it on.
      const again = await runOnce(p);
      expect(again.r.counts.unchanged).toBe(1);
      expect(again.since).toBe(z.libraryVersion(U));
    });

    it("imports, records the library version, then asks only since it; Zotero deletions are yielded as gone and change nothing here", async () => {
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
      const second = (await sources(p)).find((sf) => sf.source.provenance.externalKeys?.zoteroKey === a2)!;
      expect(second).toEqual(before.find((sf) => sf.source.provenance.externalKeys?.zoteroKey === a2));
      const report = await createBulkImport(bulkDeps()).batchReport(p.id, h2.batchId);
      expect(report.notes.join(" ")).toMatch(/1 item was deleted in Zotero since the last sync/u);
      expect(zoteroWebSince(repo, p.id, U)).toBe(z.libraryVersion(U));
      const rec = JSON.parse(await readFile(join(lib.root, p.folder, "imports", "batch-0002", "batch.json"), "utf8"));
      expect(rec.adapterOptions).toEqual({ zoteroSince: v1, zoteroFiles: true });
      expect(rec.recordedLibraryVersion).toBe(z.libraryVersion(U));
    });
  });

  it("every request in this suite is a GET", () => {
    // The after-each hook checks every request of every test; this proves it has been checking.
    expect(checked.tests).toBeGreaterThan(20);
    expect(checked.requests).toBeGreaterThan(100);
  });
});
