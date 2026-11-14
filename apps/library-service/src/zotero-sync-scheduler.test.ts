/**
 * Task Z10: the scheduler of automatic Zotero syncs (R274). Two parts:
 *   1. the scheduler alone, with stand-ins for the service's door (`run`), the settings, the records and what holds a
 *      link back, under fake timers and the fake clock (wall and monotonic) — never a real wait;
 *   2. the scheduler in the service, through the real holder, runner, engine and Web import, against the stand-in
 *      Zotero (Z1) served as the global dispatcher — never the network, and nothing but GET.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
// The service has no undici of its own: the library's (the one its Web import uses) sets the global dispatcher.
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "../../../packages/library/node_modules/undici/index.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceDeps, type Deps, type ZoteroSyncLink, type ZoteroSyncRun, type ZoteroSyncSettings } from "@ao/library";
import { useMemorySecrets } from "../../../packages/library/src/secrets-testing.js";
import { _setSecretBackend, setSecret } from "../../../packages/library/src/secrets.js";
import { FakeZotero, guardNetwork } from "../../../packages/library/tests/zotero/fake-zotero.js";
import { createService, type LibraryService } from "./server.js";
import { ZoteroSyncScheduler, type ZoteroSyncSchedulerOptions } from "./zotero-sync-scheduler.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

// ------------------------------------------------------------------------------------------
// 1. The scheduler alone.

describe("the scheduler alone (fake timers, the fake clock)", () => {
  const T0 = new Date("2027-03-12T09:00:00.000Z");
  const link = (ref: string, extra: Partial<ZoteroSyncLink> = {}): ZoteroSyncLink => ({ ref, projectId: "p1", fullDone: true, options: { structure: "collections", duplicates: "merge" }, ...extra });
  let settings: ZoteroSyncSettings | undefined;
  let records: ZoteroSyncRun[];
  let starts: Array<{ ref: string; at: number }>;
  let held: Map<string, "busy" | "held">;
  let backoff: number | undefined;
  let outcome: ZoteroSyncRun["outcome"];
  /** When set, runs end only when the test says so. */
  let gate: Map<string, () => void> | undefined;
  /** False: the run's record never reaches the history (a history that cannot be written). */
  let recordSaved: boolean;
  let settingsReads: number;
  let historyReads: number;
  let sched: ZoteroSyncScheduler | undefined;
  let n = 0;

  const record = (l: ZoteroSyncLink, finished: number, extra: Partial<ZoteroSyncRun> = {}): ZoteroSyncRun => ({
    id: `run-${++n}`,
    ref: l.ref,
    projectId: l.projectId,
    trigger: "manual",
    startedAt: new Date(finished - MIN).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    outcome: "finished",
    ...extra,
  });

  const options = (o: Partial<ZoteroSyncSchedulerOptions> = {}): ZoteroSyncSchedulerOptions => ({
    now: () => new Date(),
    tickMs: MIN,
    settings: async () => {
      settingsReads++;
      return settings && structuredClone(settings);
    },
    history: async () => {
      historyReads++;
      return records.slice();
    },
    obstacle: (l) => held.get(l.ref),
    backoffUntil: () => backoff,
    run: async (l, trigger) => {
      expect(trigger).toBe("automatic");
      starts.push({ ref: l.ref, at: Date.now() });
      if (gate) await new Promise<void>((r) => gate!.set(l.ref, r));
      const rec = record(l, Date.now(), { trigger: "automatic", outcome, ...(outcome === "failed" ? { reason: "offline" as const } : {}) });
      if (recordSaved) records.unshift(rec);
      return rec;
    },
    ...o,
  });
  const make = (o: Partial<ZoteroSyncSchedulerOptions> = {}) => (sched = new ZoteroSyncScheduler(options(o)));
  const minutes = (m: number) => vi.advanceTimersByTimeAsync(m * MIN);
  /** The computer slept (or its clock was set): the wall clock jumps, no timer fires and the monotonic clock stands. */
  const clockJump = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
  const refs = () => starts.map((s) => s.ref);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    vi.setSystemTime(T0);
    settings = { automatic: true, everyMinutes: 60, links: [link("user:42")] };
    records = [];
    starts = [];
    held = new Map();
    backoff = undefined;
    outcome = "finished";
    gate = undefined;
    recordSaved = true;
    settingsReads = 0;
    historyReads = 0;
  });
  afterEach(async () => {
    await sched?.stop();
    sched = undefined;
    vi.useRealTimers();
  });

  it("nothing runs while automatic is off (nor with no settings: a damaged or newer file); a day of ticks", async () => {
    settings!.automatic = false;
    make().start();
    await minutes(24 * 60);
    expect(starts).toEqual([]);
    expect(sched!.nextRunAt()).toBeUndefined();
    settings = undefined;
    await minutes(24 * 60);
    expect(starts).toEqual([]);
    expect(sched!.nextRunAt()).toBeUndefined();
    // The settings are read at every pass, and nothing else is asked for while nothing can be due.
    expect(settingsReads).toBeGreaterThanOrEqual(2 * 24 * 60 - 2);
  });

  it("the first run comes 2 minutes after opening (also when the last record is days old)", async () => {
    records = [record(link("user:42"), T0.getTime() - 3 * 24 * HOUR)];
    make().start();
    await minutes(1);
    expect(starts).toEqual([]);
    expect(sched!.nextRunAt()?.toISOString()).toBe(new Date(T0.getTime() + 2 * MIN).toISOString());
    await minutes(1);
    expect(starts).toEqual([{ ref: "user:42", at: T0.getTime() + 2 * MIN }]);
    // Then not again before the interval.
    await minutes(58);
    expect(starts).toHaveLength(1);
    await minutes(2);
    expect(starts).toHaveLength(2);
  });

  it("a link is due when the time since its last finished record of any kind is at least everyMinutes", async () => {
    // A manual run 50 minutes ago: due in 10 minutes, not at the 2-minute mark.
    records = [record(link("user:42"), T0.getTime() - 50 * MIN, { trigger: "manual", outcome: "up-to-date" })];
    make().start();
    await minutes(9);
    expect(starts).toEqual([]);
    expect(sched!.nextRunAt()?.toISOString()).toBe(new Date(T0.getTime() + 10 * MIN).toISOString());
    await minutes(1);
    expect(starts).toEqual([{ ref: "user:42", at: T0.getTime() + 10 * MIN }]);
    // A record without an end (the run in progress, or one an earlier process left) is not a finished run.
    const { finishedAt: _f, ...unfinished } = record(link("user:42"), Date.now());
    records = [unfinished];
    await minutes(61);
    expect(starts).toHaveLength(2);
  });

  it("after a 5-hour sleep one run starts, not ten (one timer, re-armed after each pass)", async () => {
    settings!.everyMinutes = 30;
    make().start();
    await minutes(2);
    expect(starts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    // The lid is closed: five hours later the computer wakes. No tick was missed and queued: one timer, one pass.
    clockJump(5 * HOUR);
    await minutes(1);
    expect(starts).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
    await minutes(29);
    expect(starts).toHaveLength(2);
    await minutes(1);
    expect(starts).toHaveLength(3);
  });

  it("a clock set back does not start a burst; a record dated in the future counts as now; a clock set forward starts one run, not a burst", async () => {
    // A record two hours in the future (written before the clock was set back): it counts as now when first seen.
    // First seen at the first pass, one minute after the start: due an hour after that, not two hours from now.
    records = [record(link("user:42"), T0.getTime() + 2 * HOUR)];
    make().start();
    await minutes(1);
    expect(sched!.nextRunAt()?.toISOString()).toBe(new Date(T0.getTime() + 61 * MIN).toISOString());
    await minutes(59);
    expect(starts).toEqual([]);
    await minutes(1);
    expect(starts).toHaveLength(1);
    // The clock set back three hours just after a run: the run's own record is now in the future; no run for an hour.
    records = records.filter((r) => r.trigger === "automatic");
    clockJump(-3 * HOUR);
    await minutes(60);
    expect(starts).toHaveLength(1);
    await minutes(1);
    expect(starts).toHaveLength(2);
    // Set forward ten hours: one run at the next tick, then none for the interval.
    clockJump(10 * HOUR);
    await minutes(1);
    expect(starts).toHaveLength(3);
    await minutes(59);
    expect(starts).toHaveLength(3);
  });

  it("never more often than everyMinutes by the scheduler's own count: a run whose record never reached the history is not repeated at the next tick", async () => {
    recordSaved = false;
    make().start();
    await minutes(2);
    expect(starts).toHaveLength(1);
    expect(records).toEqual([]);
    await minutes(59);
    expect(starts).toHaveLength(1);
    await minutes(1);
    expect(starts).toHaveLength(2);
  });

  it("a failed run (offline) is followed by the next attempt after everyMinutes, not sooner", async () => {
    outcome = "failed";
    settings!.everyMinutes = 30;
    make().start();
    await minutes(2);
    expect(starts.map((s) => s.at)).toEqual([T0.getTime() + 2 * MIN]);
    await minutes(29);
    expect(starts).toHaveLength(1);
    await minutes(1);
    expect(starts.map((s) => s.at)).toEqual([T0.getTime() + 2 * MIN, T0.getTime() + 32 * MIN]);
  });

  it("back-off holds every link until its time", async () => {
    settings!.links = [link("user:42"), link("group:9", { projectId: "p2" })];
    backoff = T0.getTime() + 47 * MIN;
    make().start();
    await minutes(46);
    expect(starts).toEqual([]);
    expect(sched!.nextRunAt()?.toISOString()).toBe(new Date(backoff).toISOString());
    await minutes(1);
    expect(refs()).toEqual(["user:42", "group:9"]);
  });

  it("a link that cannot start leaves no record and is tried again at the next tick: busy (a run going, an import), held (locked, read-only), paused", async () => {
    settings!.links = [link("user:42"), link("group:9", { projectId: "p2", paused: "undone" })];
    held.set("user:42", "busy");
    make().start();
    await minutes(60);
    expect(starts).toEqual([]);
    expect(records).toEqual([]);
    // Busy is not "cannot become due": the next run is not before now.
    expect(sched!.nextRunAt()?.getTime()).toBe(Date.now());
    held.set("user:42", "held");
    await minutes(5);
    expect(starts).toEqual([]);
    // Every link held or paused: no next run.
    expect(sched!.nextRunAt()).toBeUndefined();
    // Unlocked: due at the next tick.
    held.delete("user:42");
    await minutes(1);
    expect(refs()).toEqual(["user:42"]);
    expect(records).toHaveLength(1);
  });

  it("a locked project's link waits and runs after unlock", async () => {
    held.set("user:42", "held");
    make().start();
    await minutes(3 * 60);
    expect(starts).toEqual([]);
    held.delete("user:42");
    await minutes(1);
    expect(starts).toHaveLength(1);
  });

  it("libraries run one at a time: due links one after another, never two at once", async () => {
    settings!.links = [link("user:42"), link("group:9", { projectId: "p2" }), link("group:10", { projectId: "p3" })];
    gate = new Map();
    make().start();
    await minutes(2);
    expect(refs()).toEqual(["user:42"]);
    // Ticks while a run goes on start nothing else.
    await minutes(10);
    expect(refs()).toEqual(["user:42"]);
    gate.get("user:42")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(refs()).toEqual(["user:42", "group:9"]);
    gate.get("group:9")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(refs()).toEqual(["user:42", "group:9", "group:10"]);
    gate.get("group:10")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(3);
  });

  it("automatic turned off: no further run, the running one goes on; a changed everyMinutes counts from the next pass", async () => {
    settings!.links = [link("user:42"), link("group:9", { projectId: "p2" })];
    gate = new Map();
    make().start();
    await minutes(2);
    expect(refs()).toEqual(["user:42"]);
    settings!.automatic = false;
    gate.get("user:42")!();
    await minutes(0);
    // The running one ended by itself (nothing aborted it) and the next due link was not started.
    expect(records.map((r) => r.ref)).toEqual(["user:42"]);
    expect(refs()).toEqual(["user:42"]);
    await minutes(24 * 60);
    expect(refs()).toEqual(["user:42"]);
    // On again with every 4 hours: group:9 has no record (due), user:42 ran a day ago (due).
    gate = undefined;
    settings!.automatic = true;
    settings!.everyMinutes = 240;
    await minutes(1);
    expect(refs()).toEqual(["user:42", "user:42", "group:9"]);
    await minutes(239);
    expect(starts).toHaveLength(3);
    // Every 30 minutes from the next pass: both have been due since 30 minutes after their runs.
    settings!.everyMinutes = 30;
    await minutes(1);
    expect(starts).toHaveLength(5);
  });

  it("stop leaves no timer and a due tick does nothing afterwards", async () => {
    make().start();
    expect(vi.getTimerCount()).toBe(1);
    await minutes(1);
    await sched!.stop();
    expect(vi.getTimerCount()).toBe(0);
    await minutes(24 * 60);
    expect(starts).toEqual([]);
    expect(sched!.nextRunAt()).toBeUndefined();
    // Started again (a reopen, after a move): the 2-minute rule from then.
    sched!.start();
    await minutes(1);
    expect(starts).toEqual([]);
    await minutes(1);
    expect(starts).toHaveLength(1);
  });

  it("a pass starting a run when stop is called does not start it (stop waits for the pass, not for a run)", async () => {
    let release!: (s: ZoteroSyncSettings) => void;
    let asked = 0;
    make({
      settings: () => {
        asked++;
        return new Promise<ZoteroSyncSettings>((r) => (release = r));
      },
    }).start();
    // The pass at two minutes is reading the settings when the library closes.
    await minutes(2);
    expect(asked).toBeGreaterThan(0);
    let stopped = false;
    const stopping = sched!.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release(settings!);
    await stopping;
    expect(starts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    // A run already started is not waited for by stop (the holder stops it, after).
    gate = new Map();
    make().start();
    await minutes(2);
    expect(starts).toHaveLength(1);
    await sched!.stop();
    expect(vi.getTimerCount()).toBe(0);
    gate.get("user:42")!();
  });

  it("nextRunAt is the earliest due time over the links that can become due, absent when nothing can", async () => {
    settings!.links = [link("user:42"), link("group:9", { projectId: "p2" }), link("group:10", { projectId: "p3", paused: "key-refused" })];
    records = [record(link("user:42"), T0.getTime() - 20 * MIN), record(link("group:9", { projectId: "p2" }), T0.getTime() - 50 * MIN)];
    make().start();
    await minutes(1);
    // group:9 is due 10 minutes after T0; user:42 40 minutes after.
    expect(sched!.nextRunAt()?.toISOString()).toBe(new Date(T0.getTime() + 10 * MIN).toISOString());
    held.set("group:9", "held");
    await minutes(1);
    expect(sched!.nextRunAt()?.toISOString()).toBe(new Date(T0.getTime() + 40 * MIN).toISOString());
    // Fresh settings and records given by the caller (the state route) are used in place of the last pass's.
    const fresh = { settings: { ...settings!, everyMinutes: 30 as const }, history: records };
    expect(sched!.nextRunAt(fresh)?.toISOString()).toBe(new Date(T0.getTime() + 10 * MIN).toISOString());
    expect(sched!.nextRunAt({ settings: { ...settings!, automatic: false }, history: records })).toBeUndefined();
    expect(sched!.nextRunAt({ settings: undefined, history: records })).toBeUndefined();
    held.set("user:42", "held");
    expect(sched!.nextRunAt()).toBeUndefined();
  });

  it("a pass with nothing due reads the settings and the records only, and starts nothing", async () => {
    records = [record(link("user:42"), T0.getTime())];
    make().start();
    await minutes(30);
    expect(starts).toEqual([]);
    expect(settingsReads).toBe(30);
    expect(historyReads).toBe(30);
  });
});

// ------------------------------------------------------------------------------------------
// 2. The scheduler in the service.

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
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
const ADAPTER = { kind: "zotero-web", libraryType: "user", libraryId: "42" };

describe("the scheduler in the service", () => {
  let tmp: string;
  let deps: Deps;
  let svc: LibraryService;
  let z: FakeZotero;
  let secrets: { restore(): void };
  let previous: Dispatcher;
  let unguard: () => void;
  let seen: string[];
  let events: Array<{ type: string; data: any }>;
  let offEvents: (() => void) | undefined;

  beforeAll(() => {
    unguard = guardNetwork();
  });
  afterAll(() => unguard());

  beforeEach(async () => {
    // Every timer of the service is a fake one (the clock also moves on with real time, so the service works).
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    tmp = await mkdtemp(join(tmpdir(), "ao-zsched-"));
    deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
    z = new FakeZotero({ key: KEY });
    secrets = useMemorySecrets();
    await setSecret("zotero-api-key", z.key);
    previous = getGlobalDispatcher();
    setGlobalDispatcher(z.agent);
    seen = [];
    events = [];
    const logStream = new Writable({
      write: (c, _e, cb) => {
        seen.push(String(c));
        cb();
      },
    });
    svc = await createService({ token: TOKEN, deps, logStream, worker: null });
    offEvents = svc.state.events.subscribe((e) => void events.push(e as { type: string; data: any }));
  });

  afterEach(async () => {
    await svc?.close();
    offEvents?.();
    vi.useRealTimers();
    expect(z.requests.filter((r) => r.method !== "GET")).toEqual([]);
    for (const s of seen) expect(s).not.toContain(KEY);
    for (const e of events) expect(JSON.stringify(e)).not.toContain(KEY);
    setGlobalDispatcher(previous);
    secrets.restore();
    await z.agent.close();
    await rm(tmp, { recursive: true, force: true });
  });

  async function call(r: { method?: "GET" | "POST" | "PUT"; url: string; body?: unknown }) {
    const res = await svc.app.inject({
      method: r.method ?? "GET",
      url: r.url,
      headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
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
    const r = await call({ method: "PUT", url: "/zotero/sync/settings", body: { automatic: o.automatic ?? true, everyMinutes: o.everyMinutes ?? 60, links } });
    expect(r.status, r.body).toBe(200);
    return r;
  }
  const addItems = (ref: string, n: number, prefix = "Item") => {
    for (let i = 0; i < n; i++) z.addItem(ref, { itemType: "journalArticle", title: `${prefix} ${i + 1}`, creators: [{ creatorType: "author", firstName: "Ada", lastName: `Writer${i}` }], date: "2020", publicationTitle: "Journal" });
  };
  const finished = () => events.filter((e) => e.type === "zotero.sync" && e.data.state === "finished").map((e) => e.data.run);
  const state = async () => (await call({ url: "/zotero/sync" })).json;
  const history = async () => (await call({ url: "/zotero/sync/history" })).json.runs as ZoteroSyncRun[];
  const historyFile = () => readFile(join(deps.appConfigDir, "zotero-sync-history.json"), "utf8").catch(() => undefined);
  const sourceCount = async (pid: string) => (await call({ url: `/projects/${pid}/sources?limit=100` })).json.total as number;
  /** Moves the clock on by whole ticks (each tick's pass, and the sync it starts, are waited for; a held import is not). */
  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await vi.advanceTimersByTimeAsync(MIN);
      await svc.state.zoteroSync.scheduler?.idle();
      await svc.state.zoteroSync.idle();
    }
  };
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
  /** Pauses a manual import's batch inside its first `running` progress event. */
  function holdImport(): Promise<unknown> {
    return nextEvent((e) => {
      if (e.type !== "import.progress" || e.data.state !== "running") return false;
      const h = svc.state.session?.batches.get(e.data.batchId)?.handle;
      h?.pause();
      return h !== undefined;
    });
  }
  /** Pauses the sync's batch inside its first `running` event. */
  function holdSync(): Promise<unknown> {
    return nextEvent((e) => {
      if (e.type !== "zotero.sync" || e.data.state !== "running") return false;
      const b = [...(svc.state.session?.batches.values() ?? [])][0];
      b?.handle.pause();
      return b !== undefined;
    });
  }

  it("an automatic run goes through the same door: the 2-minute rule, the same record (trigger automatic), the same events", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 3);
    await saveSettings([linkOf(U, pid)]);
    expect((await state()).nextRunAt).toBeDefined();
    await ticks(1);
    expect(z.requests).toEqual([]);
    await ticks(1);
    const runs = finished();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ref: U, projectId: pid, trigger: "automatic", outcome: "finished" });
    expect(events.filter((e) => e.type === "zotero.sync").map((e) => e.data.state)[0]).toBe("checking");
    expect((await history())[0]).toMatchObject({ id: runs[0].id, trigger: "automatic" });
    expect(await sourceCount(pid)).toBe(3);
    // Then not again within the hour: an hour of ticks with nothing due makes no request and no write.
    const requests = z.requests.length;
    const file = await historyFile();
    await ticks(57);
    expect(z.requests.length).toBe(requests);
    expect(await historyFile()).toBe(file);
    expect((await state()).nextRunAt).toBe(new Date(Date.parse(runs[0].finishedAt) + HOUR).toISOString());
  }, 120_000);

  it("an hour of ticks beside a running import: no record, no request; the link runs once the import has ended", async () => {
    await openLibrary();
    const x = await newProject(false, "X");
    const pid = await newProject();
    addItems(U, 8);
    // An import of the same Zotero library, into another project, held running.
    const held = holdImport();
    const imp = await call({ method: "POST", url: `/projects/${x}/import`, body: { adapter: ADAPTER } });
    expect(imp.status, imp.body).toBe(200);
    await held;
    await saveSettings([linkOf(U, pid)]);
    // The held import's own reading ahead settles first (its scan may read a page beyond the item it waits at).
    for (let stable = 0, n = -1; stable < 20; stable = z.requests.length === n ? stable + 1 : 0) {
      n = z.requests.length;
      await new Promise((r) => setImmediate(r));
    }
    const requests = z.requests.length;
    await ticks(60);
    expect(z.requests.length).toBe(requests);
    expect(await historyFile()).toBeUndefined();
    expect(finished()).toEqual([]);
    expect((await state()).nextRunAt).toBeDefined();
    // The import ends; the link runs at the next tick.
    svc.state.session!.batches.get(imp.json.batchId)!.handle.resume();
    await svc.state.idle();
    await ticks(1);
    expect(finished().map((r) => [r.trigger, r.outcome])).toEqual([["automatic", "finished"]]);
  }, 120_000);

  it("an automatic run takes the same claim: a timed run and an import started at the same moment — one runs, the other does not, each item arrives once", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 5);
    await saveSettings([linkOf(U, pid)]);
    await ticks(1);
    // The tick first (its run claims the Zotero library before anything is awaited), the import in the same moment.
    const [, imp] = await Promise.all([vi.advanceTimersByTimeAsync(MIN), call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: ADAPTER } })]);
    await svc.state.zoteroSync.idle();
    await svc.state.idle();
    const ran = finished().filter((r) => r.outcome !== "failed");
    expect(ran.length + (imp.status === 200 ? 1 : 0)).toBe(1);
    if (imp.status !== 200) expect(imp.json.error.message).toBe("Another import from this Zotero library is running.");
    expect(await sourceCount(pid)).toBe(5);
    // No refusal was recorded for the automatic side.
    expect((await history()).filter((r) => r.reason === "import-running")).toEqual([]);
  }, 120_000);

  it("the tick first (its run has begun), the import in that moment: the import is refused as today, each item arrives once", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 5);
    await saveSettings([linkOf(U, pid)]);
    await ticks(1);
    const begun = nextEvent((e) => e.type === "zotero.sync" && e.data.state === "checking");
    await vi.advanceTimersByTimeAsync(MIN);
    await begun;
    const imp = await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: ADAPTER } });
    expect([imp.status, imp.json.error?.message]).toEqual([409, "Another import from this Zotero library is running."]);
    await svc.state.zoteroSync.idle();
    expect(finished().map((r) => [r.trigger, r.outcome])).toEqual([["automatic", "finished"]]);
    expect(await sourceCount(pid)).toBe(5);
  }, 120_000);

  it("the import first, the tick in the same moment: the import runs, the tick leaves no record, and the link runs after", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 5);
    await saveSettings([linkOf(U, pid)]);
    await ticks(1);
    const held = holdImport();
    const imp = await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: ADAPTER } });
    expect(imp.status, imp.body).toBe(200);
    await held;
    await ticks(3);
    expect(finished()).toEqual([]);
    expect(await historyFile()).toBeUndefined();
    svc.state.session!.batches.get(imp.json.batchId)!.handle.resume();
    await svc.state.idle();
    await ticks(1);
    expect(finished().map((r) => r.outcome)).toEqual(["finished"]);
    expect(await sourceCount(pid)).toBe(5);
  }, 120_000);

  it("a manual run while an automatic one is going is refused as today", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 12);
    await saveSettings([linkOf(U, pid)]);
    await ticks(1);
    const holding = holdSync();
    await vi.advanceTimersByTimeAsync(MIN);
    await holding;
    expect(svc.state.zoteroSync.running).toMatchObject({ ref: U });
    const r = await call({ method: "POST", url: "/zotero/sync/run", body: {} });
    expect([r.status, r.json.error.message]).toEqual([409, "A sync is already running."]);
    // The researcher can stop it, as a manual one.
    const stop = await call({ method: "POST", url: "/zotero/sync/stop", body: {} });
    expect(stop.status).toBe(200);
    expect(stop.json.run).toMatchObject({ trigger: "automatic", outcome: "stopped", reason: "stopped-by-you" });
  }, 120_000);

  it("locking the project during an automatic run stops it (stopped / project-locked); the locked link waits, and runs after unlock", async () => {
    await openLibrary();
    const pid = await newProject(true);
    addItems(U, 12);
    await saveSettings([linkOf(U, pid)], { everyMinutes: 30 });
    await ticks(1);
    const holding = holdSync();
    await vi.advanceTimersByTimeAsync(MIN);
    await holding;
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    // The held batch goes on to its next item, which finds the project locked.
    for (const b of svc.state.session!.batches.values()) b.handle.resume();
    await svc.state.zoteroSync.idle();
    expect(finished().at(-1)).toMatchObject({ trigger: "automatic", outcome: "stopped", reason: "project-locked" });
    const after = finished().length;
    const requests = z.requests.length;
    expect((await state()).nextRunAt).toBeUndefined();
    await ticks(3 * 60);
    expect(finished().length).toBe(after);
    expect(z.requests.length).toBe(requests);
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect((await state()).nextRunAt).toBeDefined();
    await ticks(1);
    expect(finished().slice(after).map((r) => [r.trigger, r.outcome])).toEqual([["automatic", "finished"]]);
    expect(await sourceCount(pid)).toBe(12);
  }, 180_000);

  it("closing the library stops the scheduler before it closes: no timer of it left, nothing after; a reopen starts it again with the 2-minute rule", async () => {
    const libPath = await openLibrary();
    const pid = await newProject();
    addItems(U, 3);
    await saveSettings([linkOf(U, pid)]);
    const order: string[] = [];
    const sched = svc.state.zoteroSync.scheduler!;
    const stopSched = sched.stop.bind(sched);
    sched.stop = async () => {
      order.push(`scheduler stop (sync running: ${svc.state.zoteroSync.running !== undefined})`);
      return stopSched();
    };
    const stopHolder = svc.state.zoteroSync.stop.bind(svc.state.zoteroSync);
    svc.state.zoteroSync.stop = async (reason) => {
      order.push(`holder stop (${reason})`);
      return stopHolder(reason);
    };
    const suspend = svc.state.suspendBatches.bind(svc.state);
    svc.state.suspendBatches = async (s) => {
      order.push("batches suspended");
      return suspend(s);
    };
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect(order).toEqual(["scheduler stop (sync running: false)", "holder stop (library-closed)", "batches suspended"]);
    // Stopped: it says no next run (its own test shows it leaves no timer).
    expect(sched.nextRunAt()).toBeUndefined();
    await ticks(24 * 60);
    expect(finished()).toEqual([]);
    expect(z.requests).toEqual([]);
    // Reopened: the 2-minute rule again.
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: libPath } })).status).toBe(200);
    await ticks(1);
    expect(finished()).toEqual([]);
    await ticks(1);
    expect(finished().map((r) => r.trigger)).toEqual(["automatic"]);
  }, 180_000);

  it("a tick during quiesce does nothing; after a move the scheduler starts again (2-minute rule)", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 3);
    await saveSettings([linkOf(U, pid)]);
    const s = svc.state.session!;
    // Quiesced (the move's first step), the ticks start nothing; a move that is not made activates the library again.
    const paused = await svc.state.quiesce(s);
    await ticks(10);
    expect(finished()).toEqual([]);
    expect(z.requests).toEqual([]);
    svc.state.activate(s);
    svc.state.resumeBatches(paused);
    await ticks(1);
    expect(finished()).toEqual([]);
    await ticks(1);
    expect(finished().map((r) => r.trigger)).toEqual(["automatic"]);
    // A real move: stopped before it, started again in the moved library.
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(moved.status).toBe(200);
    expect(JSON.parse(moved.body.trim().split("\n").at(-1)!).done, moved.body).toBe(true);
    addItems(U, 1, "Later");
    await saveSettings([linkOf(U, pid)], { everyMinutes: 30 });
    await ticks(1);
    expect(finished()).toHaveLength(1);
    // Due by its record (30 minutes after the first run) and by the 2-minute rule after the move.
    await ticks(30);
    expect(finished().map((r) => r.trigger)).toEqual(["automatic", "automatic"]);
    expect(await sourceCount(pid)).toBe(4);
  }, 180_000);

  it("a newer settings file: nothing scheduled, nextRunAt absent, and the state's flag comes from the module", async () => {
    await openLibrary();
    const pid = await newProject();
    addItems(U, 2);
    await saveSettings([linkOf(U, pid)]);
    const newer = JSON.stringify({ v: 2, libraries: {} });
    await writeFile(join(deps.appConfigDir, "zotero-sync.json"), newer, { mode: 0o600 });
    const st = await state();
    expect(st.settingsNewer).toBe(true);
    expect(st.nextRunAt).toBeUndefined();
    await ticks(3 * 60);
    expect(finished()).toEqual([]);
    expect(z.requests).toEqual([]);
    expect(await readFile(join(deps.appConfigDir, "zotero-sync.json"), "utf8")).toBe(newer);
  }, 180_000);

  it("nextRunAt: absent when automatic is off, when every link is paused, and on a read-only library", async () => {
    await openLibrary();
    const pid = await newProject();
    await saveSettings([linkOf(U, pid)], { automatic: false });
    expect((await state()).nextRunAt).toBeUndefined();
    await saveSettings([linkOf(U, pid)], { automatic: true });
    const at = (await state()).nextRunAt as string;
    expect(Date.parse(at) - Date.now()).toBeGreaterThan(MIN);
    expect(Date.parse(at) - Date.now()).toBeLessThanOrEqual(2 * MIN);
    // Paused: nothing can become due.
    const settingsPath = join(deps.appConfigDir, "zotero-sync.json");
    const f = JSON.parse(await readFile(settingsPath, "utf8"));
    for (const l of Object.values<any>(f.libraries)[0].links) l.paused = "undone";
    await writeFile(settingsPath, JSON.stringify(f), { mode: 0o600 });
    expect((await state()).nextRunAt).toBeUndefined();
    await ticks(5);
    expect(finished()).toEqual([]);
  }, 120_000);

  it("the key is never read by the scheduler (R78): passes that start nothing ask the password store nothing", async () => {
    await openLibrary();
    const pid = await newProject();
    await saveSettings([linkOf(U, pid)]);
    let reads = 0;
    _setSecretBackend({
      get: async (n) => {
        reads++;
        return n === "zotero-api-key" ? KEY : null;
      },
      set: async () => {},
      delete: async () => false,
    });
    // Within the first two minutes nothing is due; with automatic off, nothing ever is. The one read is the settings
    // route's own answer (whether a key is saved), not the scheduler's.
    await ticks(1);
    expect(reads).toBe(0);
    await saveSettings([linkOf(U, pid)], { automatic: false });
    await ticks(30);
    expect(reads).toBe(1);
    expect(finished()).toEqual([]);
  }, 120_000);
});
