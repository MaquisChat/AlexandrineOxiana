/**
 * Task Z8: the service's routes for Zotero account sync, manual runs only. Against the stand-in Zotero (Z1), served as
 * the global dispatcher (the service's Web import and the runner take none of their own), through the real runner
 * (Z7), engine and Web import. Nothing reaches the network; nothing but GET ever reaches the stand-in.
 *
 * What is pinned: who may call (R96) and route ordering; the key never leaves the password store through these routes
 * (R78: no response, log line, event or file holds it); one run at a time, held by the service; back-off obeyed with
 * no request; stop and close stop a run through the existing suspend, before the lock goes; a manual import and a sync
 * of the same Zotero library never run together; an undo of a sync batch pauses its link; settings are this computer's
 * file only, and a newer version's file is never overwritten; nothing runs by itself; an encrypted, locked project's
 * counts are absent.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
// The service has no undici of its own: the library's (the one its Web import uses) sets the global dispatcher.
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "../../../packages/library/node_modules/undici/index.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ZOTERO_SYNC_REASONS, deviceDeps, type Deps } from "@ao/library";
import { ZOTERO_SYNC_REASON_TEXT, ZOTERO_SYNC_SENTENCES } from "@ao/shared";
import { useMemorySecrets, useNoSecretStore } from "../../../packages/library/src/secrets-testing.js";
import { setSecret } from "../../../packages/library/src/secrets.js";
import { FakeZotero, guardNetwork } from "../../../packages/library/tests/zotero/fake-zotero.js";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
/** A recognisable key: looked for in every response, log line, event and file. */
const KEY = "Zk3yRecognisableAbCdEf12";
const PASS = "correct horse battery staple";
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;
const U = "user:42";
const G = "group:9";

let tmp: string;
let deps: Deps;
let svc: LibraryService;
let z: FakeZotero;
let secrets: { restore(): void };
let previous: Dispatcher;
let unguard: () => void;
/** Everything that could carry the key: response bodies, log lines, events. */
let seen: string[];
let events: Array<{ type: string; data: any }>;
let offEvents: (() => void) | undefined;
let restoreConsole: Array<() => void>;

beforeAll(() => {
  unguard = guardNetwork();
});
afterAll(() => unguard());

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-zsyncr-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  z = new FakeZotero({ key: KEY });
  secrets = useMemorySecrets();
  await setSecret("zotero-api-key", z.key);
  previous = getGlobalDispatcher();
  setGlobalDispatcher(z.agent);
  seen = [];
  events = [];
  restoreConsole = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    const spy = vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void seen.push(a.map(String).join(" ")));
    restoreConsole.push(() => spy.mockRestore());
  }
  await start();
});

afterEach(async () => {
  await svc?.close();
  offEvents?.();
  for (const r of restoreConsole) r();
  // One way only: nothing but GET ever reached the stand-in.
  expect(z.requests.filter((r) => r.method !== "GET")).toEqual([]);
  // R78: the key is in no response, log line or event, and in no file this computer or the library holds.
  for (const s of seen) expect(s).not.toContain(KEY);
  for (const e of events) expect(JSON.stringify(e)).not.toContain(KEY);
  for (const f of await filesUnder(tmp)) expect(await readFile(f, "latin1"), f).not.toContain(KEY);
  setGlobalDispatcher(previous);
  secrets.restore();
  await z.agent.close();
  await rm(tmp, { recursive: true, force: true });
});

async function start(): Promise<void> {
  const logStream = new Writable({
    write: (c, _e, cb) => {
      seen.push(String(c));
      cb();
    },
  });
  svc = await createService({ token: TOKEN, deps, logStream, worker: null });
  offEvents?.();
  offEvents = svc.state.events.subscribe((e) => void events.push(e as { type: string; data: any }));
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of await readdir(dir, { recursive: true }).catch(() => [] as string[])) {
    const p = join(dir, f);
    if ((await stat(p).catch(() => undefined))?.isFile()) out.push(p);
  }
  return out;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";
async function call(r: { method?: Method; url: string; body?: unknown; headers?: Record<string, string> }) {
  const res = await svc.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...(r.headers ?? {}) },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  seen.push(res.body);
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body };
}

async function openLibrary(): Promise<string> {
  const libPath = join(tmp, "Lib");
  expect((await call({ method: "POST", url: "/libraries", body: { path: libPath, name: "Lib" } })).status).toBe(200);
  return libPath;
}
async function newProject(encrypted = false, name = "Study"): Promise<string> {
  const r = await call({ method: "POST", url: "/projects", body: { name, governanceYaml: GOV, encryption: encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  return r.json.project.id as string;
}
const linkOf = (ref: string, projectId: string) => ({ ref, projectId, structure: "collections", duplicates: "merge" });
async function saveSettings(links: Array<ReturnType<typeof linkOf>>, o: { automatic?: boolean; everyMinutes?: number } = {}) {
  return call({ method: "PUT", url: "/zotero/sync/settings", body: { automatic: o.automatic ?? false, everyMinutes: o.everyMinutes ?? 60, links } });
}
const addItems = (ref: string, n: number, prefix = "Item") => {
  for (let i = 0; i < n; i++) z.addItem(ref, { itemType: "journalArticle", title: `${prefix} ${i + 1}`, creators: [{ creatorType: "author", firstName: "Ada", lastName: `Writer${ref.length}${i}` }], date: "2020", publicationTitle: "Journal" });
};
const syncEvents = () => events.filter((e) => e.type === "zotero.sync").map((e) => e.data);
const finished = () => syncEvents().filter((e) => e.state === "finished");

function nextEvent(pred: (e: { type: string; data: any }) => boolean): Promise<{ type: string; data: any }> {
  return new Promise((resolve) => {
    const off = svc.state.events.subscribe((e) => {
      if (pred(e as { type: string; data: any })) {
        off();
        resolve(e as { type: string; data: any });
      }
    });
  });
}

/** Pauses the sync's batch inside its first `running` event (the run then waits between items, still "running"). */
function holdSync(): Promise<unknown> {
  return nextEvent((e) => {
    if (e.type !== "zotero.sync" || e.data.state !== "running") return false;
    const b = [...(svc.state.session?.batches.values() ?? [])][0];
    b?.handle.pause();
    return b !== undefined;
  });
}
/** Pauses a manual import's batch inside its first `running` progress event. */
function holdImport(): Promise<unknown> {
  return nextEvent((e) => {
    if (e.type !== "import.progress" || e.data.state !== "running") return false;
    const h = svc.state.session?.batches.get(e.data.batchId)?.handle;
    h?.pause();
    return h !== undefined;
  });
}

async function runAndWait(body: unknown = {}): Promise<any[]> {
  const before = finished().length;
  const r = await call({ method: "POST", url: "/zotero/sync/run", body });
  expect(r.status, r.body).toBe(202);
  expect(r.json).toEqual({ started: true });
  await svc.state.zoteroSync.idle();
  return finished().slice(before).map((e) => e.run);
}
const state = async () => (await call({ url: "/zotero/sync" })).json;
const historyFile = () => readFile(join(deps.appConfigDir, "zotero-sync-history.json"), "utf8").then((t) => JSON.parse(t)).catch(() => undefined);

describe("who may call (R96) and route ordering", () => {
  it("the extension token is refused on every route", async () => {
    await openLibrary();
    const pid = await newProject();
    const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const p = await call({ method: "POST", url: "/extension/pair" });
    const c = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: p.json.code }) });
    const token = c.json().token as string;
    const routes: Array<[Method, string, unknown?]> = [
      ["POST", "/zotero/key-check", {}],
      ["GET", "/zotero/sync"],
      ["PUT", "/zotero/sync/settings", { automatic: false, everyMinutes: 60, links: [linkOf(U, pid)] }],
      ["POST", "/zotero/sync/run", {}],
      ["POST", "/zotero/sync/stop", {}],
      ["GET", "/zotero/sync/history"],
    ];
    for (const [method, url, body] of routes) {
      const res = await svc.app.inject({ method, url, headers: { authorization: `Bearer ${token}`, origin: EXT, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
      seen.push(res.body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // A wrong origin or host is refused as everywhere.
    expect((await call({ url: "/zotero/sync", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await call({ url: "/zotero/sync", headers: { host: "evil.example" } })).status).toBe(403);
    expect(z.requests).toEqual([]);
    expect(await historyFile()).toBeUndefined();
  });

  it("an existing Zotero route and each new one answer their own", async () => {
    await openLibrary();
    expect((await call({ url: "/secrets/zotero-api-key" })).json).toEqual({ stored: true });
    expect((await call({ method: "POST", url: "/zotero/key-check", body: {} })).json.summary).toBe("This key can read your library.");
    const st = await state();
    expect(st).toMatchObject({ readOnly: false, keyStored: true, automatic: false, everyMinutes: 60, links: [] });
    expect((await call({ url: "/zotero/sync/history" })).json).toEqual({ runs: [] });
    expect((await call({ method: "POST", url: "/zotero/sync/stop", body: {} })).json.error.message).toBe(ZOTERO_SYNC_SENTENCES.notRunning);
    expect((await call({ method: "POST", url: "/zotero/sync/run", body: {} })).json.error.message).toBe(ZOTERO_SYNC_SENTENCES.nothingLinked);
    expect((await call({ method: "PUT", url: "/zotero/sync/settings", body: { automatic: false, everyMinutes: 60, links: [] } })).status).toBe(200);
    expect((await call({ url: "/import/zotero-data-folders" })).status).toBe(200);
    expect((await call({ method: "DELETE", url: "/secrets/zotero-api-key" })).json).toEqual({ removed: true });
    expect((await call({ url: "/zotero/sync" })).json.keyStored).toBe(false);
    expect((await call({ url: "/zotero/sync/nonsense" })).status).toBe(404);
    expect((await call({ url: "/zotero" })).status).toBe(404);
  });
});

describe("the key check (R78)", () => {
  it("key-check returns access and never the key; no log line contains it", async () => {
    z.addGroup(9, "Fieldwork group");
    z.addGroup(10, "Reading group");
    const r = await call({ method: "POST", url: "/zotero/key-check", body: {} });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({
      userId: "42",
      personal: { library: true, files: true, notes: true, write: false },
      groups: [
        { ref: "group:9", name: "Fieldwork group", write: false },
        { ref: "group:10", name: "Reading group", write: false },
      ],
      summary: "This key can read your library and 2 group libraries.",
    });
    // A key in the body is never taken (storing it is the secrets route's work), never echoed, never logged.
    const withKey = await call({ method: "POST", url: "/zotero/key-check", body: { apiKey: KEY } });
    expect(withKey.status).toBe(400);
    expect(withKey.json.error.message).toBe(ZOTERO_SYNC_SENTENCES.keyNotChecked);
    // Nothing was stored by it either.
    expect(z.requests.filter((q) => q.path.startsWith("/keys")).length).toBe(1);
  });

  it("a refused key, no key, no store and an unreachable Zotero answer our sentences, never the server's text", async () => {
    z.revokeKey();
    const refused = await call({ method: "POST", url: "/zotero/key-check" });
    expect([refused.status, refused.json.error]).toEqual([409, { code: "CONFLICT", message: ZOTERO_SYNC_REASON_TEXT["key-refused"], reason: "key-refused" }]);
    z = (await z.agent.close(), new FakeZotero({ key: KEY }));
    setGlobalDispatcher(z.agent);
    z.failNext(20, 500);
    const offline = await call({ method: "POST", url: "/zotero/key-check" });
    expect([offline.status, offline.json.error]).toEqual([503, { code: "UNAVAILABLE", message: ZOTERO_SYNC_REASON_TEXT.offline, reason: "offline" }]);
    expect(offline.body).not.toMatch(/Review|Internal Server Error|500/u);
    secrets.restore();
    secrets = useMemorySecrets();
    const none = await call({ method: "POST", url: "/zotero/key-check" });
    expect([none.status, none.json.error]).toEqual([409, { code: "CONFLICT", message: ZOTERO_SYNC_REASON_TEXT["key-missing"], reason: "key-missing" }]);
    secrets.restore();
    secrets = useNoSecretStore();
    const noStore = await call({ method: "POST", url: "/zotero/key-check" });
    expect([noStore.status, noStore.json.error.reason]).toEqual([503, "no-store"]);
    await openLibrary();
    expect((await state()).keyStored).toBeNull();
  });
});

describe("settings (Accept 3)", () => {
  it("settings refuse a 15-minute interval, and each other refusal names its field", async () => {
    await openLibrary();
    const pid = await newProject();
    const sealed = await newProject(true, "Sealed");
    expect((await call({ method: "POST", url: `/projects/${sealed}/lock` })).status).toBe(200);
    const refusals: Array<[unknown, RegExp]> = [
      [{ automatic: false, everyMinutes: 15, links: [] }, /everyMinutes/u],
      [{ automatic: "yes", everyMinutes: 60, links: [] }, /automatic/u],
      [{ automatic: false, everyMinutes: 60, links: [linkOf("users:42", pid)] }, /links\[0\]\.ref/u],
      [{ automatic: false, everyMinutes: 60, links: [linkOf("group:0", pid)] }, /links\[0\]\.ref/u],
      [{ automatic: false, everyMinutes: 60, links: [linkOf(U, "nope")] }, /links\[0\]\.projectId/u],
      [{ automatic: false, everyMinutes: 60, links: [linkOf(U, sealed)] }, /links\[0\]\.projectId.*locked/u],
      [{ automatic: false, everyMinutes: 60, links: [linkOf(U, pid), linkOf(U, pid)] }, /links\[1\]\.ref/u],
      [{ automatic: false, everyMinutes: 60, links: Array.from({ length: 21 }, (_, i) => linkOf(`group:${i + 1}`, pid)) }, /links/u],
      [{ automatic: false, everyMinutes: 60, links: [{ ...linkOf(U, pid), structure: "folders" }] }, /links\[0\]\.structure/u],
      [{ automatic: false, everyMinutes: 60, links: [{ ...linkOf(U, pid), paused: undefined, fullDone: true }] }, /links\[0\]\.fullDone/u],
      [{ automatic: false, everyMinutes: 60, links: [], extra: 1 }, /extra/u],
    ];
    for (const [body, field] of refusals) {
      const r = await call({ method: "PUT", url: "/zotero/sync/settings", body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.code).toBe("VALIDATION");
      expect(r.json.error.message).toMatch(field);
    }
    // Nothing written by any of them.
    await expect(readFile(join(deps.appConfigDir, "zotero-sync.json"))).rejects.toThrow();
    const ok = await saveSettings([linkOf(U, pid)], { everyMinutes: 240 });
    expect(ok.status, ok.body).toBe(200);
    expect(ok.json).toMatchObject({ everyMinutes: 240, automatic: false, links: [{ ref: U, projectId: pid, structure: "collections", duplicates: "merge", fullDone: false, status: "Not synced yet." }] });
    expect(ok.json.links[0]).not.toHaveProperty("unfinished");
    // Only this computer's file: nothing in the library changed for it.
    const file = JSON.parse(await readFile(join(deps.appConfigDir, "zotero-sync.json"), "utf8"));
    expect(Object.values(file.libraries)).toEqual([{ automatic: false, everyMinutes: 240, links: [{ ref: U, projectId: pid, fullDone: false, options: { structure: "collections", duplicates: "merge" } }] }]);
    expect(z.requests).toEqual([]);
  });

  it("a newer version's settings file is not overwritten (409 with its sentence)", async () => {
    await openLibrary();
    const pid = await newProject();
    const path = join(deps.appConfigDir, "zotero-sync.json");
    const newer = JSON.stringify({ v: 2, libraries: { anything: { future: true } } });
    await writeFile(path, newer, { mode: 0o600 });
    const r = await saveSettings([linkOf(U, pid)]);
    expect([r.status, r.json.error.code, r.json.error.message]).toEqual([409, "CONFLICT", "These sync settings were written by a newer version of the app. Update the app to change them."]);
    expect(await readFile(path, "utf8")).toBe(newer);
    // Read as nothing linked (sync off for it), and a run has nothing to run.
    expect((await state()).links).toEqual([]);
    expect((await call({ method: "POST", url: "/zotero/sync/run", body: {} })).status).toBe(409);
    expect(await readFile(path, "utf8")).toBe(newer);
  });

  it("nothing runs by itself after a settings write with automatic on, an unlock or a library open (the clock moved a day on each time)", async () => {
    // Every timer the service makes from here on is a fake one (the clock also moves on with real time, so the
    // service works): a start delayed by minutes or hours would fire when the clock is moved on.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const aDayOn = async () => {
        await vi.advanceTimersByTimeAsync(24 * 3_600_000);
        await svc.state.idle();
      };
      await svc.close();
      await start();
      const libPath = await openLibrary();
      const pid = await newProject(true);
      addItems(U, 2);
      expect((await saveSettings([linkOf(U, pid)], { automatic: true, everyMinutes: 30 })).status).toBe(200);
      expect((await state()).automatic).toBe(true);
      expect((await state()).nextRunAt).toBeUndefined();
      await aDayOn();
      expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
      expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
      await aDayOn();
      await svc.close();
      await start();
      expect((await call({ method: "POST", url: "/libraries/open", body: { path: libPath } })).status).toBe(200);
      await aDayOn();
      expect(z.requests).toEqual([]);
      expect(syncEvents()).toEqual([]);
      expect(await historyFile()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("running (Accept 3–5)", () => {
  it("run returns 202, then a zotero.sync finished event with the record", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 3);
    expect((await saveSettings([linkOf(U, pid)])).status).toBe(200);
    const runs = await runAndWait();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ref: U, projectId: pid, trigger: "manual", outcome: "finished", counts: { new: 3, changed: 0, failed: 0 } });
    const evs = syncEvents();
    expect(evs[0]).toEqual({ ref: U, projectId: pid, state: "checking" });
    expect(evs.at(-1)!.state).toBe("finished");
    // No title, no name in any event.
    expect(JSON.stringify(evs)).not.toMatch(/Item \d/u);
    for (const e of evs.filter((x) => x.state === "running")) expect(Object.keys(e).sort()).toEqual(["done", "projectId", "ref", "state", "total"]);
    const st = await state();
    expect(st.links[0]).toMatchObject({ ref: U, fullDone: true, lastRun: { id: runs[0].id, outcome: "finished" } });
    expect(st.links[0].status).toMatch(/^Last synced with Zotero at \d\d:\d\d today: 3 new\.$/u);
    expect(st.running).toBeUndefined();
    expect((await call({ url: "/zotero/sync/history" })).json.runs.map((r: { id: string }) => r.id)).toEqual([runs[0].id]);
    expect(JSON.stringify(st)).not.toMatch(/Item \d/u);
    // The second run is a quiet one: one request, and it says so.
    z.requests.length = 0;
    const again = await runAndWait({ ref: U });
    expect(again[0].outcome).toBe("up-to-date");
    expect(z.requests).toHaveLength(1);
    expect((await state()).links[0].status).toMatch(/^Checked Zotero at \d\d:\d\d today: nothing has changed since the last sync\.$/u);
  });

  it("ref omitted runs every link that is not paused, one after another", async () => {
    await openLibrary();
    const a = await newProject(false, "A");
    const b = await newProject(false, "B");
    const c = await newProject(false, "C");
    z.addGroup(9, "G");
    z.addGroup(11, "H");
    addItems(U, 2);
    addItems(G, 2);
    expect((await saveSettings([linkOf(U, a), linkOf(G, b), linkOf("group:11", c)])).status).toBe(200);
    // One link paused: it is not run.
    await (await import("@ao/library")).pauseLink(deps.appConfigDir, svc.state.session!.lib.id, "group:11", "undone");
    const runs = await runAndWait();
    expect(runs.map((r) => [r.ref, r.outcome])).toEqual([
      [U, "finished"],
      [G, "finished"],
    ]);
    // Never two at once: each link's events end before the next begins.
    const order = syncEvents().filter((e) => e.state !== "running").map((e) => `${e.state} ${e.ref}`);
    expect(order).toEqual([`checking ${U}`, `finished ${U}`, `checking ${G}`, `finished ${G}`]);
    // Asked for by name, the paused link is refused with its own record.
    const paused = await runAndWait({ ref: "group:11" });
    expect(paused[0]).toMatchObject({ outcome: "failed", reason: "sync-undone" });
    expect((await call({ method: "POST", url: "/zotero/sync/run", body: { ref: "group:77" } })).json.error.message).toBe(ZOTERO_SYNC_SENTENCES.notLinked);
    expect((await call({ method: "POST", url: "/zotero/sync/run", body: { ref: "nonsense" } })).status).toBe(400);
  });

  it("a second run is 409", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 8);
    await saveSettings([linkOf(U, pid)]);
    const held = holdSync();
    expect((await call({ method: "POST", url: "/zotero/sync/run", body: {} })).status).toBe(202);
    await held;
    const second = await call({ method: "POST", url: "/zotero/sync/run", body: {} });
    expect([second.status, second.json.error.code, second.json.error.message]).toEqual([409, "CONFLICT", "A sync is already running."]);
    const st = await state();
    expect(st.running).toMatchObject({ ref: U });
    expect(typeof st.running.done).toBe("number");
    // Stopped, so the test ends cleanly.
    expect((await call({ method: "POST", url: "/zotero/sync/stop", body: {} })).status).toBe(200);
  });

  it("stop says You stopped it", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 8);
    await saveSettings([linkOf(U, pid)]);
    const held = holdSync();
    await call({ method: "POST", url: "/zotero/sync/run", body: {} });
    await held;
    const r = await call({ method: "POST", url: "/zotero/sync/stop", body: {} });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({ stopped: true, run: { outcome: "stopped", reason: "stopped-by-you" } });
    expect(finished().at(-1)!.run).toMatchObject({ outcome: "stopped", reason: "stopped-by-you" });
    expect(syncEvents().at(-1)!.state).toBe("finished");
    const st = await state();
    expect(st.links[0].status).toMatch(/^Stopped syncing with Zotero at \d\d:\d\d today: You stopped it\. /u);
    expect((await call({ method: "POST", url: "/zotero/sync/stop", body: {} })).json.error.message).toBe("No sync is running.");
    // The batch is paused, and the next run resumes it (same batch) and finishes.
    const next = await runAndWait();
    expect(next[0]).toMatchObject({ outcome: "finished", batchId: r.json.run.batchId });
  });

  it("a run inside back-off makes no request", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 2);
    await saveSettings([linkOf(U, pid)]);
    z.backoffOnce(120);
    const first = await runAndWait();
    expect(first[0].backoffUntil).toBeDefined();
    const count = z.requests.length;
    const r = await call({ method: "POST", url: "/zotero/sync/run", body: {} });
    expect([r.status, r.json.error.code, r.json.error.reason]).toEqual([409, "CONFLICT", "backing-off"]);
    expect(r.json.error.message).toMatch(/^Zotero asked this app to wait until \d\d:\d\d( on \d{1,2} \w+ \d{4})?\.$/u);
    const check = await call({ method: "POST", url: "/zotero/key-check", body: {} });
    expect([check.status, check.json.error.reason]).toEqual([409, "backing-off"]);
    expect(z.requests.length).toBe(count);
    expect((await state()).backoffUntil).toBe(first[0].backoffUntil);
    // Kept across a restart of the service: it is read from the history.
    const libPath = svc.state.session!.lib.root;
    await svc.close();
    await start();
    await call({ method: "POST", url: "/libraries/open", body: { path: libPath } });
    expect((await call({ method: "POST", url: "/zotero/sync/run", body: {} })).status).toBe(409);
    expect(z.requests.length).toBe(count);
  });

  it("a failure's status line never says up to date", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 2);
    await saveSettings([linkOf(U, pid)]);
    z.revokeKey();
    const runs = await runAndWait();
    expect(runs[0]).toMatchObject({ outcome: "failed", reason: "key-refused" });
    const st = await state();
    expect(st.links[0].status).toMatch(/^Could not sync with Zotero at \d\d:\d\d today: Zotero refused the key: it may have been revoked\. Check the key on this screen\. Nothing here was changed\.$/u);
    expect(st.links[0].status).not.toMatch(/up to date|nothing has changed/iu);
    expect(st.links[0]).toMatchObject({ paused: "key-refused", waitingFor: "paused" });
  });

  it("R248: a successful key check clears the key-refused pause of every link, also after a restart; a failed one clears nothing; a save clears undone only", async () => {
    const libPath = await openLibrary();
    const a = await newProject(false, "A");
    const b = await newProject(false, "B");
    z.addGroup(9, "G");
    addItems(U, 1);
    await saveSettings([linkOf(U, a), linkOf(G, b)]);
    z.revokeKey();
    await runAndWait({ ref: U });
    const paused = await state();
    expect(paused.links.map((l: { paused?: string }) => l.paused)).toEqual(["key-refused", "key-refused"]);
    // A save does not clear it; a failed check does not either.
    expect((await saveSettings([linkOf(U, a), linkOf(G, b)])).json.links.map((l: { paused?: string }) => l.paused)).toEqual(["key-refused", "key-refused"]);
    expect((await call({ method: "POST", url: "/zotero/key-check", body: {} })).status).toBe(409);
    expect((await state()).links.map((l: { paused?: string }) => l.paused)).toEqual(["key-refused", "key-refused"]);
    // After a restart of the service (the pause is stored), a key that works again clears it for every link, in one write.
    await svc.close();
    await start();
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: libPath } })).status).toBe(200);
    z = (await z.agent.close(), new FakeZotero({ key: KEY }));
    setGlobalDispatcher(z.agent);
    z.addGroup(9, "G");
    expect((await call({ method: "POST", url: "/zotero/key-check", body: {} })).status).toBe(200);
    const cleared = await state();
    expect(cleared.links.map((l: { paused?: string; waitingFor?: string }) => [l.paused, l.waitingFor])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ]);
    // An undone pause: cleared by the researcher's save (and not by a key check).
    await (await import("@ao/library")).pauseLink(deps.appConfigDir, svc.state.session!.lib.id, U, "undone");
    expect((await call({ method: "POST", url: "/zotero/key-check", body: {} })).status).toBe(200);
    expect((await state()).links[0].paused).toBe("undone");
    expect((await saveSettings([linkOf(U, a), linkOf(G, b)])).json.links[0].paused).toBeUndefined();
  });

  it("close during a run leaves a stopped record and a paused batch, and nothing is written after the lock is released", async () => {
    const libPath = await openLibrary();
    const pid = await newProject();
    addItems(U, 12);
    await saveSettings([linkOf(U, pid)]);
    const held = holdSync();
    await call({ method: "POST", url: "/zotero/sync/run", body: {} });
    await held;
    const closed = await call({ method: "POST", url: "/libraries/close" });
    expect(closed.status).toBe(200);
    const eventsAtClose = events.length;
    // The record was finished before the close answered, and said so last.
    expect(finished().at(-1)!.run).toMatchObject({ outcome: "stopped", reason: "library-closed" });
    const snap = async () => Promise.all((await filesUnder(libPath)).sort().map(async (f) => [f, await readFile(f, "base64")]));
    const before = await snap();
    await new Promise((r) => setTimeout(r, 500));
    await svc.state.idle();
    expect(await snap()).toEqual(before);
    expect(events.slice(eventsAtClose).filter((e) => e.type === "zotero.sync")).toEqual([]);
    const hist = await historyFile();
    const recs = Object.values(hist.libraries)[0] as Array<{ outcome: string; reason: string; finishedAt?: string; batchId?: string }>;
    expect(recs[0]).toMatchObject({ outcome: "stopped", reason: "library-closed" });
    expect(recs[0]!.finishedAt).toBeDefined();
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: libPath } })).status).toBe(200);
    const batches = (await call({ url: `/projects/${pid}/imports` })).json.batches as Array<{ batchId: string; state: string }>;
    expect(batches.find((b) => b.batchId === recs[0]!.batchId)?.state).toBe("paused");
    expect((await state()).links[0].status).toMatch(/^Stopped syncing with Zotero at \d\d:\d\d today: The library was closed or moved during the sync; it continues next time\. /u);
  });

  it("the app's shutdown stops a run before the lock goes", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 12);
    await saveSettings([linkOf(U, pid)]);
    const held = holdSync();
    await call({ method: "POST", url: "/zotero/sync/run", body: {} });
    await held;
    // R250 g: when the close comes to suspend the running batches (and then release the lock), the sync has already
    // been stopped by the holder: no run, and its batch no longer among them.
    const atSuspend: Array<{ running: unknown; batches: number }> = [];
    const suspend = svc.state.suspendBatches.bind(svc.state);
    svc.state.suspendBatches = async (s) => {
      atSuspend.push({ running: svc.state.zoteroSync.running, batches: s.batches.size });
      return suspend(s);
    };
    await svc.close();
    expect(atSuspend).toEqual([{ running: undefined, batches: 0 }]);
    const hist = await historyFile();
    expect((Object.values(hist.libraries)[0] as Array<{ outcome: string; reason: string }>)[0]).toMatchObject({ outcome: "stopped", reason: "app-closed" });
  });

  it("R250 g: two run requests sent together: one starts, one is refused", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 3);
    await saveSettings([linkOf(U, pid)]);
    const both = await Promise.all([call({ method: "POST", url: "/zotero/sync/run", body: {} }), call({ method: "POST", url: "/zotero/sync/run", body: {} })]);
    expect(both.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(both.find((r) => r.status === 409)!.json.error.message).toBe("A sync is already running.");
    await svc.state.zoteroSync.idle();
    expect(finished()).toHaveLength(1);
    expect((await call({ url: `/projects/${pid}/sources?limit=100` })).json.total).toBe(3);
  });

  it("R250 b: the run in progress is left out of the history", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 3);
    await saveSettings([linkOf(U, pid)]);
    const [first] = await runAndWait();
    addItems(U, 8, "More");
    const held = holdSync();
    await call({ method: "POST", url: "/zotero/sync/run", body: {} });
    await held;
    const runs = (await call({ url: "/zotero/sync/history" })).json.runs as Array<{ id: string; finishedAt?: string }>;
    expect(runs.map((r) => r.id)).toEqual([first.id]);
    expect((await state()).running).toMatchObject({ ref: U });
    await call({ method: "POST", url: "/zotero/sync/stop", body: {} });
    expect((await call({ url: "/zotero/sync/history" })).json.runs).toHaveLength(2);
  });

  it("R250 j: a run that throws still ends with a finished event, a failed record with reason error", async () => {
    await openLibrary();
    const pid = await newProject();
    await saveSettings([linkOf(U, pid)]);
    svc.state.zoteroSync.runner = async () => {
      throw new Error("unexpected");
    };
    const [run] = await runAndWait();
    expect(run).toMatchObject({ ref: U, projectId: pid, trigger: "manual", outcome: "failed", reason: "error" });
    expect(syncEvents().at(-1)).toMatchObject({ state: "finished", run: { outcome: "failed", reason: "error" } });
    expect(svc.state.zoteroSync.running).toBeUndefined();
  });

  it("R250 k: a sync's batch cannot be paused or resumed through the import routes", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 8);
    await saveSettings([linkOf(U, pid)]);
    const held = holdSync();
    await call({ method: "POST", url: "/zotero/sync/run", body: {} });
    await held;
    const batchId = [...svc.state.session!.batches.keys()][0]!;
    const SENTENCE = "This import belongs to a Zotero sync. Stop it or run it again from the Zotero screen.";
    const paused = await call({ method: "POST", url: `/imports/${batchId}/pause` });
    expect([paused.status, paused.json.error.code, paused.json.error.message]).toEqual([409, "CONFLICT", SENTENCE]);
    const r = await call({ method: "POST", url: "/zotero/sync/stop", body: {} });
    expect(r.json.run.batchId).toBe(batchId);
    const resumed = await call({ method: "POST", url: `/imports/${batchId}/resume` });
    expect([resumed.status, resumed.json.error.message]).toEqual([409, SENTENCE]);
    expect((await call({ method: "POST", url: `/imports/${batchId}/pause` })).json.error.message).toBe(SENTENCE);
    // The next sync resumes it.
    expect((await runAndWait())[0]).toMatchObject({ outcome: "finished", batchId });
  });

  it("a read-only library refuses every changing route with 409 READ_ONLY", async () => {
    const libPath = await openLibrary();
    const pid = await newProject();
    await saveSettings([linkOf(U, pid)]);
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const now = new Date().toISOString();
    await writeFile(join(libPath, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now, user: "ana" }));
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: libPath } })).json.mode).toBe("read-only");
    const file = await readFile(join(deps.appConfigDir, "zotero-sync.json"), "utf8");
    for (const [method, url, body] of [
      ["PUT", "/zotero/sync/settings", { automatic: true, everyMinutes: 30, links: [] }],
      ["POST", "/zotero/sync/run", {}],
      ["POST", "/zotero/sync/stop", {}],
    ] as const) {
      const r = await call({ method, url, body });
      expect([r.status, r.json.error.code], `${method} ${url}`).toEqual([409, "READ_ONLY"]);
    }
    expect(await readFile(join(deps.appConfigDir, "zotero-sync.json"), "utf8")).toBe(file);
    const st = await state();
    expect(st.readOnly).toBe(true);
    expect(st.links).toHaveLength(1);
    expect(z.requests).toEqual([]);
  });
});

describe("a manual import and a sync of one Zotero library never run together (A10)", () => {
  it("a manual import is refused while a sync runs, and the other way round", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 10);
    await saveSettings([linkOf(U, pid)]);
    const held = holdSync();
    await call({ method: "POST", url: "/zotero/sync/run", body: {} });
    await held;
    const manual = await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "zotero-web", libraryType: "user", libraryId: "42" } } });
    expect([manual.status, manual.json.error.code, manual.json.error.message]).toEqual([409, "CONFLICT", "Another import from this Zotero library is running."]);
    await call({ method: "POST", url: "/zotero/sync/stop", body: {} });

    // The other way round: a manual import of the same library runs, and the sync refuses with its record.
    const other = await newProject(false, "Other");
    const heldImport = holdImport();
    const started = await call({ method: "POST", url: `/projects/${other}/import`, body: { adapter: { kind: "zotero-web", libraryType: "user", libraryId: "42" } } });
    expect(started.status, started.body).toBe(200);
    await heldImport;
    await saveSettings([linkOf(U, other)]);
    const runs = await runAndWait();
    expect(runs[0]).toMatchObject({ outcome: "failed", reason: "import-running" });
    // A paused manual Zotero batch is not resumed while a sync of the project runs (nor the sync's batch by hand).
    expect((await call({ method: "POST", url: `/imports/${started.json.batchId}/cancel` })).status).toBe(200);
    await svc.state.idle();
  });

  it("R250 a: an import and a sync of one Zotero library sent together, in both orders and repeatedly: one runs, the project holds each item once", async () => {
    await openLibrary();
    addItems(U, 6);
    const importOf = (pid: string) => call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "zotero-web", libraryType: "user", libraryId: "42" } } });
    const runSync = () => call({ method: "POST", url: "/zotero/sync/run", body: {} });
    for (let i = 0; i < 6; i++) {
      const pid = await newProject(false, `P${i}`);
      await saveSettings([linkOf(U, pid)]);
      const before = finished().length;
      const [imp, syn] = i % 2 === 0 ? await Promise.all([importOf(pid), runSync()]) : await Promise.all([runSync(), importOf(pid)]).then(([a, b]) => [b, a] as const);
      expect(syn.status, syn.body).toBe(202);
      await svc.state.zoteroSync.idle();
      await svc.state.idle();
      const run = finished().slice(before)[0]!.run;
      // Exactly one of the two ran.
      expect([imp.status === 200, run.outcome === "finished"].filter(Boolean), `round ${i}: import ${imp.status}, sync ${run.outcome}/${run.reason}`).toHaveLength(1);
      if (imp.status !== 200) expect(imp.json.error.message).toBe("Another import from this Zotero library is running.");
      else expect(run).toMatchObject({ outcome: "failed", reason: "import-running" });
      expect((await call({ url: `/projects/${pid}/sources?limit=100` })).json.total, `round ${i}`).toBe(6);
    }
  });

  it("R250 a: a sync into project P while an import of the same Zotero library runs into project X is refused", async () => {
    await openLibrary();
    const x = await newProject(false, "X");
    const p = await newProject(false, "P");
    addItems(U, 10);
    const heldImport = holdImport();
    const started = await call({ method: "POST", url: `/projects/${x}/import`, body: { adapter: { kind: "zotero-web", libraryType: "user", libraryId: "42" } } });
    expect(started.status).toBe(200);
    await heldImport;
    await saveSettings([linkOf(U, p)]);
    const [run] = await runAndWait();
    expect(run).toMatchObject({ outcome: "failed", reason: "import-running" });
    expect((await call({ url: `/projects/${p}/imports` })).json.batches).toEqual([]);
    // R252: the runner's own record of the refusal: the link's last run and the history hold it.
    const st = await state();
    expect(st.links[0].lastRun).toMatchObject({ id: run.id, outcome: "failed", reason: "import-running" });
    expect(st.links[0].status).toMatch(/^Could not sync with Zotero at \d\d:\d\d today: Another import from this Zotero library is running\. Nothing here was changed\.$/u);
    expect((await call({ url: "/zotero/sync/history" })).json.runs[0]).toMatchObject({ id: run.id, reason: "import-running" });
    expect((await call({ method: "POST", url: `/imports/${started.json.batchId}/cancel` })).status).toBe(200);
    await svc.state.idle();
  });

  it("R250 a: two manual imports of one Zotero library sent together make one batch; 042 is library 42; a failed start leaves no claim", async () => {
    await openLibrary();
    const x = await newProject(false, "X");
    const y = await newProject(false, "Y");
    const sealed = await newProject(true, "Sealed");
    addItems(U, 4);
    const importOf = (pid: string, libraryId = "42") => call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "zotero-web", libraryType: "user", libraryId } } });
    const both = await Promise.all([importOf(x), importOf(y, "042")]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    await svc.state.idle();
    const batches = [...(await call({ url: `/projects/${x}/imports` })).json.batches, ...(await call({ url: `/projects/${y}/imports` })).json.batches];
    expect(batches).toHaveLength(1);
    // "042" is library 42: its batch says so.
    const z42 = await importOf(y, "0042");
    expect(z42.status, z42.body).toBe(200);
    await svc.state.idle();
    const yb = (await call({ url: `/projects/${y}/imports` })).json.batches as Array<{ batchId: string; ref?: string }>;
    expect(yb.find((b) => b.batchId === z42.json.batchId)?.ref).toBe(U);
    expect((await importOf(y, "000")).status).toBe(400);
    // A start that fails (a locked project) gives its claim up: the next start works.
    expect((await call({ method: "POST", url: `/projects/${sealed}/lock` })).status).toBe(200);
    expect((await importOf(sealed)).status).toBe(423);
    expect((await importOf(x)).status).toBe(200);
    await svc.state.idle();
  });

  it("R248: only an import of THE SAME Zotero library is refused while a sync runs; resuming one by hand too", async () => {
    await openLibrary();
    const pid = await newProject();
    const x = await newProject(false, "X");
    const y = await newProject(false, "Y");
    const w = await newProject(false, "W");
    z.addGroup(9, "G");
    addItems(U, 10);
    addItems(G, 10);
    // Two manual batches left cancelled (resumable): one of the user library, one of the group.
    const cancelled: string[] = [];
    for (const [project, adapter] of [
      [x, { kind: "zotero-web", libraryType: "user", libraryId: "42" }],
      [y, { kind: "zotero-web", libraryType: "group", libraryId: "9" }],
    ] as const) {
      const h = holdImport();
      const r = await call({ method: "POST", url: `/projects/${project}/import`, body: { adapter } });
      await h;
      expect((await call({ method: "POST", url: `/imports/${r.json.batchId}/cancel` })).status).toBe(200);
      await svc.state.idle();
      cancelled.push(r.json.batchId as string);
    }
    await saveSettings([linkOf(U, pid)]);
    const held = holdSync();
    await call({ method: "POST", url: "/zotero/sync/run", body: {} });
    await held;
    const sameResume = await call({ method: "POST", url: `/imports/${cancelled[0]}/resume` });
    expect([sameResume.status, sameResume.json.error?.message]).toEqual([409, "Another import from this Zotero library is running."]);
    expect((await call({ method: "POST", url: `/imports/${cancelled[1]}/resume` })).status).toBe(200);
    // The group library is now being read by its resumed batch: one more import of it, into any project, is refused (R250 a).
    expect((await call({ method: "POST", url: `/projects/${w}/import`, body: { adapter: { kind: "zotero-web", libraryType: "group", libraryId: "9" } } })).status).toBe(409);
    await call({ method: "POST", url: "/zotero/sync/stop", body: {} });
    await svc.state.idle();
  });
});

describe("the service's own resume of a suspended Zotero Web import takes the claim too (R252)", () => {
  const ADAPTER = { kind: "zotero-web", libraryType: "user", libraryId: "42" };
  /** A manual import of user:42 into a new project, left paused by a close (as a move's quiesce leaves it). */
  async function suspendedImport(libPath: string): Promise<{ x: string; batchId: string }> {
    const x = await newProject(false, "X");
    const h = holdImport();
    const r = await call({ method: "POST", url: `/projects/${x}/import`, body: { adapter: ADAPTER } });
    await h;
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: libPath } })).status).toBe(200);
    return { x, batchId: r.json.batchId as string };
  }
  const batchState = async (pid: string, batchId: string) => ((await call({ url: `/projects/${pid}/imports` })).json.batches as Array<{ batchId: string; state: string }>).find((b) => b.batchId === batchId)?.state;
  /** Waits for the service's resume work to end (without waiting for a held sync). */
  async function resumeWorkDone(): Promise<void> {
    for (let i = 0; i < 500 && svc.state.workKinds().includes("resume-import"); i++) await new Promise((r) => setTimeout(r, 20));
  }

  it("the resume after a move is refused while a sync holds the library: the batch stays paused, nothing is lost", async () => {
    const libPath = await openLibrary();
    addItems(U, 10);
    const { x, batchId } = await suspendedImport(libPath);
    expect(await batchState(x, batchId)).toBe("paused");
    const p = await newProject(false, "P");
    await saveSettings([linkOf(U, p)]);
    const held = holdSync();
    await call({ method: "POST", url: "/zotero/sync/run", body: {} });
    await held;
    // The path a move (and a failed move, and the open after it) takes to put its paused batches back to work.
    svc.state.resumeBatches([{ projectId: x, batchId }]);
    await resumeWorkDone();
    expect(await batchState(x, batchId)).toBe("paused");
    expect(svc.state.session!.batches.has(batchId)).toBe(false);
    await call({ method: "POST", url: "/zotero/sync/stop", body: {} });
    // Resumed by hand afterwards, it finishes, and each item is there once.
    expect((await call({ method: "POST", url: `/imports/${batchId}/resume` })).status).toBe(200);
    await svc.state.idle();
    expect(await batchState(x, batchId)).toBe("finished");
    expect((await call({ url: `/projects/${x}/sources?limit=100` })).json.total).toBe(10);
  });

  it("a sync sent while the service's resume of the same library runs is refused with its record", async () => {
    const libPath = await openLibrary();
    addItems(U, 10);
    const { x, batchId } = await suspendedImport(libPath);
    const p = await newProject(false, "P");
    await saveSettings([linkOf(U, p)]);
    const heldResume = holdImport();
    svc.state.resumeBatches([{ projectId: x, batchId }]);
    await heldResume;
    const [run] = await runAndWait();
    expect(run).toMatchObject({ outcome: "failed", reason: "import-running" });
    expect((await call({ url: `/projects/${p}/imports` })).json.batches).toEqual([]);
    svc.state.session!.batches.get(batchId)!.handle.resume();
    await svc.state.idle();
    expect(await batchState(x, batchId)).toBe("finished");
    expect((await call({ url: `/projects/${x}/sources?limit=100` })).json.total).toBe(10);
    expect((await call({ url: `/projects/${p}/sources?limit=100` })).json.total).toBe(0);
  });

  it("no claim is left after a close, a switch or a move: a later start works", async () => {
    const libPath = await openLibrary();
    addItems(U, 6);
    const x = await newProject(false, "X");
    const startHeld = async () => {
      const h = holdImport();
      const r = await call({ method: "POST", url: `/projects/${x}/import`, body: { adapter: ADAPTER } });
      expect(r.status, r.body).toBe(200);
      await h;
      return r.json.batchId as string;
    };
    const startOk = async () => {
      const r = await call({ method: "POST", url: `/projects/${x}/import`, body: { adapter: ADAPTER } });
      expect(r.status, r.body).toBe(200);
      await svc.state.idle();
    };
    // Close.
    await startHeld();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: libPath } })).status).toBe(200);
    await startOk();
    // Switch: another library opened in its place, then this one again.
    await startHeld();
    expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Other"), name: "Other" } })).status).toBe(200);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: libPath } })).status).toBe(200);
    await startOk();
    // Move: the held import is paused for it and resumed (with its claim) in the moved library; once it ends, a start works.
    const moving = await startHeld();
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(moved.status).toBe(200);
    expect(JSON.parse(moved.body.trim().split("\n").at(-1)!).done, moved.body).toBe(true);
    await svc.state.idle();
    expect(await batchState(x, moving)).toBe("finished");
    await startOk();
  }, 180_000);
});

describe("undo of a sync batch (R206, R242)", () => {
  it("undo of a sync batch pauses its link and says so; undo of another batch does not", async () => {
    await openLibrary();
    const pid = await newProject();
    const other = await newProject(false, "Other");
    z.addGroup(9, "G");
    addItems(U, 2);
    addItems(G, 2);
    await saveSettings([linkOf(U, pid)]);
    const [run] = await runAndWait();
    expect(run.outcome).toBe("finished");

    // Another batch (a manual import of the group): its undo answers as before, and no link is paused.
    const manual = await call({ method: "POST", url: `/projects/${other}/import`, body: { adapter: { kind: "zotero-web", libraryType: "group", libraryId: "9" } } });
    await svc.state.idle();
    const plain = await call({ method: "POST", url: `/imports/${manual.json.batchId}/undo` });
    expect(plain.status, plain.body).toBe(200);
    expect(plain.json).not.toHaveProperty("zoteroSync");
    expect((await state()).links[0].paused).toBeUndefined();

    // R248: the batch says itself that it is the sync's: a history file set aside does not make the undo forget.
    await writeFile(join(deps.appConfigDir, "zotero-sync-history.json"), "{ damaged");
    const undone = await call({ method: "POST", url: `/imports/${run.batchId}/undo` });
    expect(undone.status, undone.body).toBe(200);
    expect(undone.json.zoteroSync).toEqual({ paused: true, message: "Syncing this Zotero library is paused. Turn it on again on the Zotero screen." });
    const st = await state();
    expect(st.links[0]).toMatchObject({ paused: "undone", waitingFor: "paused" });
    // The next sync does not bring back at once what was undone: it is refused with its own record and requests nothing.
    z.requests.length = 0;
    const [next] = await runAndWait({ ref: U });
    expect(next).toMatchObject({ outcome: "failed", reason: "sync-undone" });
    expect(z.requests).toEqual([]);
    expect((await call({ url: `/projects/${pid}/sources?limit=100` })).json.total).toBe(0);
  });

  it("R250 d: the undo says paused only when a link was in fact paused", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 2);
    await saveSettings([linkOf(U, pid)]);
    const [run] = await runAndWait();
    // The researcher removed the link before undoing: nothing is paused, and the answer does not say so.
    await saveSettings([]);
    const undone = await call({ method: "POST", url: `/imports/${run.batchId}/undo` });
    expect(undone.status, undone.body).toBe(200);
    expect(undone.json).not.toHaveProperty("zoteroSync");
  });
});

describe("the state (point 8)", () => {
  it("an encrypted, locked project's counts are absent", async () => {
    await openLibrary();
    const pid = await newProject(true);
    addItems(U, 3);
    await saveSettings([linkOf(U, pid)]);
    const [run] = await runAndWait();
    expect(run.outcome).toBe("finished");
    // The event carries the counts read from the batch while the project is unlocked; the device file never.
    expect(run.counts).toMatchObject({ new: 3 });
    const recs = Object.values((await historyFile()).libraries)[0] as Array<Record<string, unknown>>;
    expect(recs[0]).not.toHaveProperty("counts");
    const open = await state();
    expect(open.links[0].lastRun.counts).toMatchObject({ new: 3 });
    expect(open.links[0].waitingFor).toBeUndefined();
    expect((await call({ url: "/zotero/sync/history" })).json.runs[0].counts).toMatchObject({ new: 3 });
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    const locked = await state();
    expect(locked.links[0].lastRun).not.toHaveProperty("counts");
    expect(locked.links[0].waitingFor).toBe("project-locked");
    expect(locked.links[0].status).toMatch(/^Last synced with Zotero at \d\d:\d\d today\.$/u);
    expect((await call({ url: "/zotero/sync/history" })).json.runs[0]).not.toHaveProperty("counts");
    // A locked project: the run refuses with its record.
    const [refused] = await runAndWait();
    expect(refused).toMatchObject({ outcome: "failed", reason: "project-locked" });
  });

  it("every reason the runner can give has its sentence", () => {
    expect(Object.keys(ZOTERO_SYNC_REASON_TEXT).sort()).toEqual([...ZOTERO_SYNC_REASONS].sort());
  });
});
