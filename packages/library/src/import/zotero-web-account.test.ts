import { MockAgent } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setSecret } from "../secrets.js";
import { useMemorySecrets, useNoSecretStore } from "../secrets-testing.js";
import { FakeZotero, guardNetwork } from "../../tests/zotero/fake-zotero.js";
import { ZOTERO_ACCOUNT_MAX_WAIT_MS, ZOTERO_KEY_CHECK_TIMEOUT_MS, ZOTERO_UNCHANGED_TIMEOUT_MS, ZoteroAccountError, capGroupName, checkZoteroKey, parseKeyAnswer, zoteroLibraryUnchanged } from "./zotero-web-account.js";

const KEY = "AccountKeyAbCd0123456789Zz";
const API = "https://api.zotero.org";

let unguard: () => void;
let secrets: ReturnType<typeof useMemorySecrets>;
let z: FakeZotero;
const toClose: MockAgent[] = [];
const sleeps: number[] = [];
const sleep = async (ms: number): Promise<void> => {
  sleeps.push(ms);
};

beforeAll(() => {
  unguard = guardNetwork();
});
afterAll(() => unguard());

beforeEach(async () => {
  secrets = useMemorySecrets();
  await setSecret("zotero-api-key", KEY);
  z = new FakeZotero({ key: KEY, userId: 42 });
  z.agent.enableCallHistory();
  sleeps.length = 0;
});
afterEach(async () => {
  vi.useRealTimers();
  secrets.restore();
  await z.agent.close();
  for (const a of toClose.splice(0)) await a.close();
  vi.restoreAllMocks();
});

const check = (o: Partial<NonNullable<Parameters<typeof checkZoteroKey>[0]>> = {}) => checkZoteroKey({ dispatcher: z.agent, sleep, ...o });
const unchanged = (ref: string, since: number) => zoteroLibraryUnchanged({ ref, since, dispatcher: z.agent, sleep });
const caught = async (p: Promise<unknown>): Promise<ZoteroAccountError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ZoteroAccountError);
    return e as ZoteroAccountError;
  }
  throw new Error("expected a ZoteroAccountError");
};

/** A server that answers /keys/current with exactly `body` (a string is sent as it is), and nothing else. */
function rawKeyServer(body: unknown, status = 200, headers: Record<string, string> = {}): MockAgent {
  const m = new MockAgent();
  m.disableNetConnect();
  m.get(API)
    .intercept({ path: "/keys/current", method: "GET" })
    .reply(status, typeof body === "string" ? body : JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } })
    .persist();
  toClose.push(m);
  return m;
}

/** A key with all-groups access, and a group list that answers `pages` one after the other (start=0, 100, ...) with the given Total-Results. */
function rawGroupsServer(total: number | undefined, pages: unknown[][], extra: Record<string, string> = {}): MockAgent {
  const m = new MockAgent();
  m.disableNetConnect();
  toClose.push(m);
  const hdr = { "content-type": "application/json" };
  m.get(API).intercept({ path: "/keys/current", method: "GET" }).reply(200, JSON.stringify({ userID: 42, access: { user: { library: true }, groups: { all: { library: true, write: false } } } }), { headers: hdr }).persist();
  pages.forEach((rows, i) => {
    m.get(API)
      .intercept({ path: `/users/42/groups?limit=100&start=${i * 100}`, method: "GET" })
      .reply(200, JSON.stringify(rows), { headers: { ...hdr, ...(total === undefined ? {} : { "total-results": String(total) }), ...extra } })
      .persist();
  });
  return m;
}

describe("checkZoteroKey", () => {
  it("a read-only key reads the library and two groups", async () => {
    z.addGroup(100, "Reading group");
    z.addGroup(101, "Lab");
    const got = await check();
    expect(got).toEqual({
      userId: "42",
      personal: { library: true, files: true, notes: true, write: false },
      groups: [
        { ref: "group:100", name: "Reading group", write: false },
        { ref: "group:101", name: "Lab", write: false },
      ],
    });
  });

  it("a key without files or notes says so", async () => {
    z.setKeyAccess({ files: false, notes: false });
    const got = await check();
    expect(got.personal).toEqual({ library: true, files: false, notes: false, write: false });
  });

  it("a key that may write says so, as information only", async () => {
    z.addGroup(100, "Lab");
    z.setKeyAccess({ write: true });
    const got = await check();
    expect(got.personal.write).toBe(true);
    expect(got.groups).toEqual([{ ref: "group:100", name: "Lab", write: true }]);
  });

  it("the key's own value never appears in the result, an error or a debug line", async () => {
    const lines: string[] = [];
    const grab = (...a: unknown[]): void => void lines.push(a.map(String).join(" "));
    for (const k of ["log", "info", "warn", "error", "debug", "trace"] as const) vi.spyOn(console, k).mockImplementation(grab);
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => (lines.push(String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => (lines.push(String(c)), true));
    const seen: string[] = [];
    const everything = (e: unknown): string => {
      const o = e as Record<string, unknown>;
      return JSON.stringify([e, Object.getOwnPropertyNames(e).map((n) => [n, String(o[n])]), String((e as Error).stack), String((e as { cause?: unknown }).cause ?? "")]);
    };
    z.addGroup(100, "Lab");
    seen.push(JSON.stringify(await check()));
    // every error path
    z.revokeKey();
    seen.push(everything(await caught(check())));
    seen.push(everything(await caught(unchanged("user:42", 1))));
    const z2 = new FakeZotero({ key: KEY, userId: 42 });
    z2.failNext(20, 503);
    seen.push(everything(await caught(checkZoteroKey({ dispatcher: z2.agent, sleep }))));
    z2.failNext(20, 429, 3600);
    seen.push(everything(await caught(checkZoteroKey({ dispatcher: z2.agent, sleep }))));
    await z2.agent.close();
    seen.push(everything(await caught(checkZoteroKey({ dispatcher: rawKeyServer("not json {" + KEY), sleep }))));
    seen.push(everything(await caught(checkZoteroKey({ dispatcher: rawKeyServer({ key: KEY, userID: "x", access: 7 }), sleep }))));
    secrets.values.clear();
    seen.push(everything(await caught(check())));
    const ns = useNoSecretStore();
    seen.push(everything(await caught(check())));
    ns.restore();
    for (const s of [...seen, ...lines]) expect(s).not.toContain(KEY);
    expect(seen.join("")).not.toContain("fake-user");
    // the recorded requests carry the key only as the stand-in's marker
    expect(JSON.stringify(z.requests)).not.toContain(KEY);
  });

  it("a public group the key cannot read is left out", async () => {
    z.addGroup(100, "Mine");
    z.addGroup(200, "Somebody else's public group", { type: "PublicClosed" });
    z.setKeyAccess({ groups: { "100": { library: true, write: false } } });
    // the stand-in does list the public group (as the documents say): the filter is the key's own access
    const got = await check();
    expect(z.requests.some((r) => r.path.startsWith("/users/42/groups"))).toBe(true);
    expect(got.groups.map((g) => g.ref)).toEqual(["group:100"]);
    expect(JSON.stringify(got)).not.toContain("public group");
  });

  it("the per-group access shape and the all shape give the same result", async () => {
    const make = (access: Parameters<FakeZotero["setKeyAccess"]>[0]): FakeZotero => {
      const f = new FakeZotero({ key: KEY, userId: 42 });
      f.addGroup(100, "A");
      f.addGroup(101, "B");
      f.setKeyAccess(access);
      return f;
    };
    const a = make({ groups: "all" });
    const b = make({ groups: { "100": { library: true, write: false }, "101": { library: true, write: false } } });
    const ra = await checkZoteroKey({ dispatcher: a.agent, sleep });
    const rb = await checkZoteroKey({ dispatcher: b.agent, sleep });
    expect(rb).toEqual(ra);
    expect(ra.groups).toHaveLength(2);
    // a per-group entry says write per group
    const c = make({ groups: { "100": { library: true, write: true }, "101": { library: true, write: false } } });
    expect((await checkZoteroKey({ dispatcher: c.agent, sleep })).groups.map((g) => g.write)).toEqual([true, false]);
    // a group named with library: false is not readable even though listed
    const d = make({ groups: { "100": { library: true, write: false }, "101": { library: false, write: false } } });
    expect((await checkZoteroKey({ dispatcher: d.agent, sleep })).groups.map((g) => g.ref)).toEqual(["group:100"]);
    for (const f of [a, b, c, d]) await f.agent.close();
  });

  it("a key with no personal library access but one group", async () => {
    z.addGroup(100, "Lab");
    z.addGroup(101, "Other");
    z.setKeyAccess({ library: false, files: false, notes: false, groups: { "100": { library: true, write: false } } });
    const got = await check();
    expect(got.personal.library).toBe(false);
    expect(got.groups).toEqual([{ ref: "group:100", name: "Lab", write: false }]);
  });

  it("a key with no group access (groups missing, and groups empty)", async () => {
    z.addGroup(100, "Lab");
    z.setKeyAccess({ groups: {} });
    expect((await check()).groups).toEqual([]);
    // `groups` missing altogether: the group list is not even asked for (the raw server has no route for it)
    const missing = await checkZoteroKey({ dispatcher: rawKeyServer({ userID: 42, access: { user: { library: true, files: true, notes: false, write: false } } }), sleep });
    expect(missing).toEqual({ userId: "42", personal: { library: true, files: true, notes: false, write: false }, groups: [] });
    // `all` with library: false is no access either
    const none = await checkZoteroKey({ dispatcher: rawKeyServer({ userID: 42, access: { user: { library: true }, groups: { all: { library: false, write: false } } } }), sleep });
    expect(none.groups).toEqual([]);
    // no `user` part: no personal access
    const noUser = await checkZoteroKey({ dispatcher: rawKeyServer({ userID: 42, access: { groups: {} } }), sleep });
    expect(noUser.personal).toEqual({ library: false, files: false, notes: false, write: false });
  });

  it("a group name of 300 characters is cut to 200 by characters", async () => {
    z.addGroup(100, "x".repeat(150) + "\u{1F600}".repeat(150));
    z.addGroup(101, "a".repeat(199) + "é" + "zzz");
    z.addGroup(102, "short");
    const [g100, g101, g102] = (await check()).groups;
    expect(Array.from(g100!.name)).toHaveLength(200);
    expect(g100!.name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(g100!.name.endsWith("\u{1F600}")).toBe(true);
    // a letter with its accent is one character: the cut leaves no accent behind and takes no half of one
    expect(g101!.name).toBe("a".repeat(199));
    expect(g102!.name).toBe("short");
  });

  it("a group removed since the key was made is left out, not an error", async () => {
    z.addGroup(100, "Lab");
    z.addGroup(101, "Gone soon");
    z.removeGroup(101);
    expect((await check()).groups.map((g) => g.ref)).toEqual(["group:100"]);
  });

  it("more groups than one page are all read", async () => {
    for (let i = 1; i <= 120; i++) z.addGroup(1000 + i, `Group ${i}`);
    const got = await check();
    expect(got.groups).toHaveLength(120);
    expect(new Set(got.groups.map((g) => g.ref)).size).toBe(120);
  });

  it("403 on /keys/current is key-refused, with no server text", async () => {
    z.revokeKey();
    const e = await caught(check());
    expect(e.reason).toBe("key-refused");
    expect(e.message).not.toMatch(/forbidden/i);
    expect((e as { cause?: unknown }).cause).toBeUndefined();
    expect(Object.keys(e)).toEqual(["reason"]);
    expect(z.requests).toHaveLength(1);
  });

  it("a malformed /keys/current answer is offline", async () => {
    const bad: unknown[] = [
      "this is not json",
      "[1,2,3]",
      JSON.stringify("text"),
      JSON.stringify({}),
      { userID: "abc", access: {} },
      { userID: 42 },
      { userID: 42, access: "yes" },
      { userID: 42, access: { user: "yes" } },
      { userID: 42, access: { user: { library: "yes" } } },
      { userID: 42, access: { user: { library: true }, groups: [] } },
      { userID: 42, access: { user: { library: true }, groups: { all: "yes" } } },
    ];
    for (const b of bad) {
      const e = await caught(checkZoteroKey({ dispatcher: rawKeyServer(b), sleep }));
      expect(e.reason, JSON.stringify(b)).toBe("offline");
    }
  });

  it("a malformed group list is offline, not a half-filled result", async () => {
    const m = new MockAgent();
    m.disableNetConnect();
    toClose.push(m);
    const hdr = { "content-type": "application/json" };
    m.get(API).intercept({ path: "/keys/current", method: "GET" }).reply(200, JSON.stringify({ userID: 42, access: { user: { library: true }, groups: { all: { library: true, write: false } } } }), { headers: hdr }).persist();
    m.get(API).intercept({ path: /^\/users\/42\/groups/u, method: "GET" }).reply(200, JSON.stringify([{ id: 5, data: { name: "ok" } }, { id: 6, data: {} }]), { headers: { ...hdr, "total-results": "2" } }).persist();
    expect((await caught(checkZoteroKey({ dispatcher: m, sleep }))).reason).toBe("offline");
  });

  it("nothing in the password store is no-key", async () => {
    secrets.values.clear();
    const e = await caught(check());
    expect(e.reason).toBe("no-key");
    expect(z.requests).toHaveLength(0);
  });

  it("a password store that cannot be used is no-store", async () => {
    const ns = useNoSecretStore();
    try {
      expect((await caught(check())).reason).toBe("no-store");
      expect(z.requests).toHaveLength(0);
    } finally {
      ns.restore();
    }
  });

  it("an unreachable server, a 5xx that outlasts its retries and a cut connection are offline", async () => {
    z.failNext(50, 503);
    expect((await caught(check())).reason).toBe("offline");
    const unmounted = new MockAgent();
    unmounted.disableNetConnect();
    toClose.push(unmounted);
    expect((await caught(checkZoteroKey({ dispatcher: unmounted, sleep }))).reason).toBe("offline");
    // a connection cut on every try (the stand-in only cuts item lists, so a plain mock cuts this one)
    const cut = new MockAgent();
    cut.disableNetConnect();
    toClose.push(cut);
    cut.get(API).intercept({ path: "/keys/current", method: "GET" }).replyWithError(new Error(`socket hang up (${KEY})`)).persist();
    const e = await caught(checkZoteroKey({ dispatcher: cut, sleep }));
    expect(e.reason).toBe("offline");
    expect(JSON.stringify([e.message, e.stack])).not.toContain(KEY);
  });

  it("a transient 503 is retried and the check succeeds", async () => {
    z.failNext(1, 503);
    expect((await check()).userId).toBe("42");
    expect(sleeps.length).toBe(1);
  });

  it("Zotero asking to wait longer than this call may wait is backing-off, with the moment, and the call does not sleep for it", async () => {
    const before = Date.now();
    z.failNext(1, 429, 3600);
    const e = await caught(check());
    expect(e.reason).toBe("backing-off");
    expect(e.backoffUntil).toBeGreaterThanOrEqual(before + 3600_000);
    expect(e.backoffUntil).toBeLessThan(Date.now() + 3600_000 + 5000);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(ZOTERO_ACCOUNT_MAX_WAIT_MS);
  });

  it("a Backoff header on the key answer that is longer than this call may wait stops before the group list", async () => {
    z.addGroup(100, "Lab");
    z.backoffOnce(3600);
    const e = await caught(check());
    expect(e.reason).toBe("backing-off");
    expect(e.backoffUntil).toBeGreaterThan(Date.now() + 3500_000);
    expect(z.requests.filter((r) => r.path.includes("/groups"))).toHaveLength(0);
  });

  it("a long Backoff on the last answer of a successful check is reported in the result (I1)", async () => {
    z.setKeyAccess({ groups: {} });
    const before = Date.now();
    z.backoffOnce(3600);
    const got = await check();
    expect(got.personal.library).toBe(true);
    expect(got.backoffUntil).toBeGreaterThanOrEqual(before + 3600_000);
    expect(got.backoffUntil).toBeLessThan(Date.now() + 3600_000 + 5000);
    // and on the last page of the group list
    z.addGroup(100, "Lab");
    z.setKeyAccess({ groups: "all" });
    const m = rawGroupsServer(1, [[{ id: 100, data: { name: "Lab" } }]], { backoff: "3600" });
    const got2 = await checkZoteroKey({ dispatcher: m, sleep });
    expect(got2.groups).toHaveLength(1);
    expect(got2.backoffUntil).toBeGreaterThanOrEqual(before + 3600_000);
  });

  it("a Backoff on the first answer, short enough to wait for, is waited for and reported (I1)", async () => {
    z.addGroup(100, "Lab");
    const before = Date.now();
    z.backoffOnce(2);
    const got = await check();
    expect(got.groups).toHaveLength(1);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(1500);
    expect(sleeps[0]).toBeLessThanOrEqual(2000);
    expect(got.backoffUntil).toBeGreaterThanOrEqual(before + 2000);
    expect(got.backoffUntil).toBeLessThan(Date.now() + 3000);
  });

  it("with no Backoff the result has no backoffUntil", async () => {
    expect("backoffUntil" in (await check())).toBe(false);
  });

  it("150 groups with the second page empty is offline, not a list of 100 (I2)", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 1 + i, data: { name: `G${i}` } }));
    const e = await caught(checkZoteroKey({ dispatcher: rawGroupsServer(150, [page1, []]), sleep }));
    expect(e.reason).toBe("offline");
  });

  it("a short page before the total, and a listing with no total, are offline (I2)", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 1 + i, data: { name: `G${i}` } }));
    const page2 = Array.from({ length: 20 }, (_, i) => ({ id: 500 + i, data: { name: `H${i}` } }));
    expect((await caught(checkZoteroKey({ dispatcher: rawGroupsServer(150, [page1, page2]), sleep }))).reason).toBe("offline");
    expect((await caught(checkZoteroKey({ dispatcher: rawGroupsServer(undefined, [page2]), sleep }))).reason).toBe("offline");
    // more than the total says is not a whole listing either
    expect((await caught(checkZoteroKey({ dispatcher: rawGroupsServer(10, [page2]), sleep }))).reason).toBe("offline");
    // an exact total is fine, and so is an empty list with total 0
    expect((await checkZoteroKey({ dispatcher: rawGroupsServer(20, [page2]), sleep })).groups).toHaveLength(20);
    expect((await checkZoteroKey({ dispatcher: rawGroupsServer(0, [[]]), sleep })).groups).toEqual([]);
  });

  it("a server that never answers is offline at the limit, with nothing left running (M2)", async () => {
    vi.useFakeTimers();
    const m = new MockAgent();
    m.disableNetConnect();
    toClose.push(m);
    m.get(API).intercept({ path: "/keys/current", method: "GET" }).reply(200, "{}").delay(10_000_000).persist();
    let settled = false;
    const p = caught(checkZoteroKey({ dispatcher: m })).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(ZOTERO_KEY_CHECK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).reason).toBe("offline");
    expect(ZOTERO_KEY_CHECK_TIMEOUT_MS).toBe(30_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an abort during a wait is honoured at once, with no timer left (M1)", async () => {
    vi.useFakeTimers();
    z.failNext(1, 503, 8);
    const c = new AbortController();
    const p = checkZoteroKey({ dispatcher: z.agent, signal: c.signal });
    const out = p.then(() => "resolved", (e: unknown) => (e as Error).message);
    await vi.advanceTimersByTimeAsync(100);
    c.abort(new Error("stop"));
    await vi.advanceTimersByTimeAsync(1);
    expect(await out).toBe("stop");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an earlier Backoff is kept on the error when the answer cannot be read (M6)", async () => {
    const m = rawKeyServer({ userID: "abc", access: {} }, 200, { backoff: "3600" });
    const e = await caught(checkZoteroKey({ dispatcher: m, sleep }));
    expect(e.reason).toBe("offline");
    expect(e.backoffUntil).toBeGreaterThan(Date.now() + 3500_000);
  });

  it("the key field is deleted from the parsed answer, and kept in no result (M5)", () => {
    const body: Record<string, unknown> = { key: KEY, userID: 42, username: "u", access: { user: { library: true } } };
    const a = parseKeyAnswer(body);
    expect("key" in body).toBe(false);
    expect(JSON.stringify(a)).not.toContain(KEY);
    expect(Object.keys(a).sort()).toEqual(["all", "byId", "personal", "userId"]);
  });

  it("a name whose first character is longer than the cap is cut by code points, not emptied (M3)", () => {
    const name = "a" + "\u0301".repeat(250) + "b";
    const cut = capGroupName(name);
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut.startsWith("a\u0301")).toBe(true);
  });

  it("a Backoff short enough to wait for is waited for", async () => {
    z.addGroup(100, "Lab");
    z.backoffOnce(2);
    expect((await check()).groups).toHaveLength(1);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(1500);
    expect(sleeps[0]).toBeLessThanOrEqual(2000);
  });

  it("an aborted call stops with the abort", async () => {
    const c = new AbortController();
    c.abort(new Error("stop"));
    await expect(check({ signal: c.signal })).rejects.toThrow("stop");
  });

  it("every request is a GET to api.zotero.org", async () => {
    z.addGroup(100, "Lab");
    const v = z.libraryVersion("user:42");
    await check();
    await unchanged("user:42", v);
    await unchanged("group:100", z.libraryVersion("group:100"));
    z.revokeKey();
    await caught(check());
    expect(z.requests.length).toBeGreaterThan(3);
    expect(z.requests.map((r) => r.method)).toEqual(z.requests.map(() => "GET"));
    const calls = z.agent.getCallHistory()?.calls() ?? [];
    expect(calls.length).toBe(z.requests.length);
    expect(new Set(calls.map((c) => c.origin))).toEqual(new Set([API]));
    // the key goes only in the header, never in a path
    expect(z.requests.every((r) => !/[?&]key=/u.test(r.path))).toBe(true);
  });
});

describe("zoteroLibraryUnchanged", () => {
  it("304 means unchanged and nothing else is fetched", async () => {
    z.addItem("user:42", { itemType: "book", title: "A" });
    const v = z.libraryVersion("user:42");
    z.requests.length = 0;
    const got = await unchanged("user:42", v);
    expect(got).toEqual({ unchanged: true });
    expect(z.requests).toHaveLength(1);
    expect(z.requests[0]!.method).toBe("GET");
    expect(z.requests[0]!.path).toBe("/users/42/items/top?limit=1&format=keys");
    expect(z.requests[0]!.headers["if-modified-since-version"]).toBe(String(v));
  });

  it("a change since is not unchanged (200), and a group has its own prefix", async () => {
    const v = z.libraryVersion("user:42");
    z.addItem("user:42", { itemType: "book", title: "B" });
    expect(await unchanged("user:42", v)).toEqual({ unchanged: false });
    z.addGroup(100, "Lab");
    const gv = z.libraryVersion("group:100");
    z.requests.length = 0;
    expect(await unchanged("group:100", gv)).toEqual({ unchanged: true });
    expect(z.requests[0]!.path).toBe("/groups/100/items/top?limit=1&format=keys");
    z.addItem("group:100", { itemType: "book", title: "C" });
    expect(await unchanged("group:100", gv)).toEqual({ unchanged: false });
  });

  it("a collection added or an item removed, which bump the library version, are noticed by the stand-in", async () => {
    const k = z.addItem("user:42", { itemType: "book", title: "D" });
    const v1 = z.libraryVersion("user:42");
    z.addCollection("user:42", "Shelf");
    expect((await unchanged("user:42", v1)).unchanged).toBe(false);
    const v2 = z.libraryVersion("user:42");
    z.remove("user:42", k);
    expect((await unchanged("user:42", v2)).unchanged).toBe(false);
  });

  it("a version that is not the library's own is never taken for unchanged", async () => {
    z.addItem("user:42", { itemType: "book", title: "E" });
    const v = z.libraryVersion("user:42");
    // the library is older than what we remember (a reset or a restore): "not later" gives a 304, the answer is still "changed"
    expect(await unchanged("user:42", v + 5)).toEqual({ unchanged: false });
  });

  it("a Backoff on the check is reported", async () => {
    z.addItem("user:42", { itemType: "book", title: "F" });
    const v = z.libraryVersion("user:42");
    const before = Date.now();
    z.requests.length = 0;
    z.backoffOnce(30);
    const got = await unchanged("user:42", v);
    expect(got.unchanged).toBe(true);
    expect(got.backoffUntil).toBeGreaterThanOrEqual(before + 30_000);
    expect(got.backoffUntil).toBeLessThan(Date.now() + 31_000);
    expect(z.requests.length).toBe(1);
    expect(sleeps).toEqual([]);
    // and beside a "changed" answer
    z.addItem("user:42", { itemType: "book", title: "G" });
    z.backoffOnce(30);
    const changed = await unchanged("user:42", v);
    expect(changed.unchanged).toBe(false);
    expect(changed.backoffUntil).toBeGreaterThanOrEqual(before + 30_000);
  });

  it("an answer with no Backoff has no backoffUntil", async () => {
    const got = await unchanged("user:42", z.libraryVersion("user:42"));
    expect(Object.keys(got)).toEqual(["unchanged"]);
  });

  it("refusals are the same reasons, with no server text", async () => {
    const z2 = new FakeZotero({ key: KEY, userId: 42 });
    expect((await caught(zoteroLibraryUnchanged({ ref: "group:999", since: 1, dispatcher: z2.agent, sleep }))).reason).toBe("library-gone");
    z2.failNext(50, 500);
    expect((await caught(zoteroLibraryUnchanged({ ref: "user:42", since: 1, dispatcher: z2.agent, sleep }))).reason).toBe("offline");
    z2.failNext(1, 429, 7200);
    const e = await caught(zoteroLibraryUnchanged({ ref: "user:42", since: 1, dispatcher: z2.agent, sleep }));
    expect(e.reason).toBe("backing-off");
    expect(e.backoffUntil).toBeGreaterThan(Date.now() + 7000_000);
    await z2.agent.close();
    z.revokeKey();
    const refused = await caught(unchanged("user:42", 1));
    expect(refused.reason).toBe("key-refused");
    expect(refused.message).not.toMatch(/forbidden/i);
    secrets.values.clear();
    expect((await caught(unchanged("user:42", 1))).reason).toBe("no-key");
  });

  it("a removed group is library-gone, and a 403 stays key-refused", async () => {
    z.addGroup(100, "Lab");
    const v = z.libraryVersion("group:100");
    z.removeGroup(100);
    const e = await caught(unchanged("group:100", v));
    expect(e.reason).toBe("library-gone");
    expect(e.message).not.toMatch(/not found/i);
    z.setKeyAccess({ groups: {} });
    z.addGroup(101, "Other");
    expect((await caught(unchanged("group:101", 1))).reason).toBe("key-refused");
  });

  it("a server that never answers is offline at the limit, with nothing left running (M2)", async () => {
    vi.useFakeTimers();
    const m = new MockAgent();
    m.disableNetConnect();
    toClose.push(m);
    m.get(API).intercept({ path: /^\/users\/42\/items\/top/u, method: "GET" }).reply(200, "").delay(10_000_000).persist();
    let settled = false;
    const p = caught(zoteroLibraryUnchanged({ ref: "user:42", since: 3, dispatcher: m })).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(ZOTERO_UNCHANGED_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).reason).toBe("offline");
    expect(ZOTERO_UNCHANGED_TIMEOUT_MS).toBe(15_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a ref or a version that is not valid is refused before any request", async () => {
    z.requests.length = 0;
    await expect(unchanged("users/42", 1)).rejects.toThrow(TypeError);
    await expect(unchanged("user:42; x", 1)).rejects.toThrow(TypeError);
    await expect(unchanged("user:42", -1)).rejects.toThrow(TypeError);
    await expect(unchanged("user:42", 1.5)).rejects.toThrow(TypeError);
    expect(z.requests).toHaveLength(0);
  });
});
