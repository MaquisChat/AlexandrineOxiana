/**
 * The Zotero screen (Task Z9) against a mocked service shaped exactly like Z8's handlers
 * (apps/library-service/src/routes/zotero-sync.ts): every request's path, method and body; the state with the
 * service's own status lines; the `zotero.sync` events; the refusals with the service's sentences. Nothing here ever
 * reaches a real host.
 */
import {
  ZOTERO_SYNC_REASON_TEXT,
  ZOTERO_SYNC_SENTENCES,
  zoteroNextSyncLine,
  zoteroSyncReasonText,
  zoteroSyncStatusLine,
  type ZoteroKeyCheckResponse,
  type ZoteroSyncCounts,
  type ZoteroSyncRun,
  type ZoteroSyncSettingsRequest,
  type ZoteroSyncStateResponse,
} from "@ao/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportApi, ImportReport } from "../api/import";
import { zoteroSyncApi } from "../api/zoteroSync";
import { App } from "../App";
import { PATHS } from "../navigation";
import { OPEN_GOVERNANCE, PSEUDONYMISING_GOVERNANCE, REPORT } from "../test/importService";
import { BASE, hang, libraryHandlers, server, serviceError, sseAttempts, testClient, TOKEN, url, useMockService } from "../test/service";
import { DEFAULT_APPEARANCE } from "../theme/appearance";
import { StepReport } from "./import/StepReport";
import { ZoteroSync } from "./ZoteroSync";

useMockService();

const P1 = "019a6f00-0000-7000-8000-000000000001";
const P2 = "019a6f00-0000-7000-8000-000000000002";
const P3 = "019a6f00-0000-7000-8000-000000000003";
const P4 = "019a6f00-0000-7000-8000-000000000004";
const B1 = "019a7000-0000-7000-8000-0000000000b1";
const KEY = "Zk7Qp2Lm9Xc4Vb8Nn1Rt6Yw3";

const PROJECTS = {
  projects: [
    { id: P1, name: "Dissertation", encrypted: false, unlocked: true },
    { id: P2, name: "Clinic interviews", encrypted: true, unlocked: false },
    { id: P3, name: "Lab notes", encrypted: false, unlocked: true },
    { id: P4, name: "Interviews", encrypted: false, unlocked: true },
  ],
};
/** P4's rules pseudonymise names (R64): a new link into it gets the wizard's "none". */
const GOVERNANCE: Record<string, string> = { [P4]: PSEUDONYMISING_GOVERNANCE };

const ZERO: ZoteroSyncCounts = { new: 0, changed: 0, unchanged: 0, waiting: 0, conflicts: 0, goneMarked: 0, failed: 0, back: 0, clearedKept: 0 };
let runN = 0;
const at = (minAgo = 5) => new Date(Date.now() - minAgo * 60_000).toISOString();
function run(o: Partial<ZoteroSyncRun> = {}): ZoteroSyncRun {
  return { id: `run-${++runN}`, ref: "user:42", projectId: P1, trigger: "manual", startedAt: at(6), finishedAt: at(5), outcome: "finished", counts: { ...ZERO, new: 3, changed: 2 }, ...o };
}

type LinkIn = { ref: string; projectId: string; structure?: "collections" | "tags" | "none"; duplicates?: "merge" | "skip" | "keep-both"; paused?: "key-refused" | "library-gone" | "undone"; lastRun?: ZoteroSyncRun; waitingFor?: "project-locked" | "paused"; status?: string };
type StateIn = Partial<Omit<ZoteroSyncStateResponse, "links">> & { links?: LinkIn[] };

/** The state as Z8's `stateOf` answers it: each link's line is the shared `zoteroSyncStatusLine` of its last run. */
function stateOf(o: StateIn = {}): ZoteroSyncStateResponse {
  const { links = [], ...rest } = o;
  return {
    readOnly: false,
    settingsNewer: false,
    keyStored: true,
    automatic: false,
    everyMinutes: 60,
    ...rest,
    links: links.map((l) => ({
      ref: l.ref,
      projectId: l.projectId,
      structure: l.structure ?? "collections",
      duplicates: l.duplicates ?? "merge",
      ...(l.paused ? { paused: l.paused } : {}),
      fullDone: true,
      status: l.status ?? zoteroSyncStatusLine(l.lastRun, new Date()),
      ...(l.lastRun ? { lastRun: l.lastRun } : {}),
      ...(l.waitingFor ? { waitingFor: l.waitingFor } : l.paused ? { waitingFor: "paused" as const } : {}),
    })),
  };
}

const ACCESS: ZoteroKeyCheckResponse = {
  userId: "42",
  personal: { library: true, files: true, notes: true, write: false },
  groups: [{ ref: "group:7", name: "Lab group", write: false }],
  summary: "This key can read your library and 1 group library.",
};

/** A text/event-stream the test writes into while the screen listens. */
function eventStream() {
  const enc = new TextEncoder();
  let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
  let connections = 0;
  return {
    handler: http.get(url("/events"), () => {
      connections++;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
        },
      });
      return new HttpResponse(body, { headers: { "content-type": "text/event-stream" } });
    }),
    open: () => ctl !== undefined,
    connections: () => connections,
    /** The service ends the stream (the screen listens again shortly). */
    close: () => ctl!.close(),
    push(type: string, data: unknown) {
      ctl!.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
    },
  };
}

interface Call {
  method: string;
  path: string;
  body: string;
  contentType: string | null;
}

/** A promise the test resolves. */
function held<T = void>() {
  let release!: (v: T) => void;
  const p = new Promise<T>((r) => (release = r));
  return { p, release };
}

type Answer = Response | Promise<Response>;

/** The mocked service. Each `on…` may be replaced by a test; `state` and `history` are what GET answers. */
function useSvc(init: StateIn = {}, history: ZoteroSyncRun[] = []) {
  const events = eventStream();
  const svc = {
    events,
    calls: [] as Call[],
    state: stateOf(init),
    history,
    access: ACCESS as ZoteroKeyCheckResponse,
    keyStored: true,
    onState: undefined as undefined | (() => Answer),
    onSave: undefined as undefined | ((body: ZoteroSyncSettingsRequest) => Answer),
    onRun: undefined as undefined | (() => Answer),
    onStop: undefined as undefined | (() => Answer),
    onCheck: undefined as undefined | (() => Answer),
    /** What GET /projects/:id/review?limit=0 answers as `total`, per project (the library screen's count). */
    waiting: {} as Record<string, number>,
    count: (method: string, path: string) => svc.calls.filter((c) => c.method === method && c.path === path).length,
    bodies: (method: string, path: string) => svc.calls.filter((c) => c.method === method && c.path === path).map((c) => c.body),
  };
  const rec = async (request: Request) => {
    svc.calls.push({ method: request.method, path: new URL(request.url).pathname, body: await request.clone().text(), contentType: request.headers.get("content-type") });
  };
  server.use(
    events.handler,
    http.get(url("/zotero/sync"), async ({ request }) => {
      await rec(request);
      return svc.onState ? svc.onState() : HttpResponse.json(svc.state);
    }),
    http.get(url("/zotero/sync/history"), async ({ request }) => {
      await rec(request);
      return HttpResponse.json({ runs: svc.history });
    }),
    http.put(url("/zotero/sync/settings"), async ({ request }) => {
      await rec(request);
      const body = (await request.clone().json()) as ZoteroSyncSettingsRequest;
      if (svc.onSave) return svc.onSave(body);
      // As the service does (R265): the device file takes the request; a pause stays with its Zotero library, and
      // `undone` goes only for a link named with `resume: true`.
      const was = svc.state.links;
      svc.state = {
        ...svc.state,
        automatic: body.automatic,
        everyMinutes: body.everyMinutes,
        links: body.links.map((l) => {
          const w = was.find((x) => x.ref === l.ref && x.projectId === l.projectId);
          const p = was.find((x) => x.ref === l.ref)?.paused;
          const paused = p && !(p === "undone" && l.resume === true) ? p : undefined;
          const { resume: _r, ...plain } = l;
          return { ...plain, fullDone: w?.fullDone ?? false, status: w?.status ?? zoteroSyncStatusLine(undefined, new Date()), ...(w?.lastRun ? { lastRun: w.lastRun } : {}), ...(paused ? { paused, waitingFor: "paused" as const } : {}) };
        }),
      };
      return HttpResponse.json(svc.state);
    }),
    http.post(url("/zotero/sync/run"), async ({ request }) => {
      await rec(request);
      return svc.onRun ? svc.onRun() : HttpResponse.json({ started: true }, { status: 202 });
    }),
    http.post(url("/zotero/sync/stop"), async ({ request }) => {
      await rec(request);
      return svc.onStop ? svc.onStop() : HttpResponse.json({ stopped: true });
    }),
    http.post(url("/zotero/key-check"), async ({ request }) => {
      await rec(request);
      return svc.onCheck ? svc.onCheck() : HttpResponse.json(svc.access);
    }),
    http.get(url("/projects/:id/review"), async ({ request, params }) => {
      await rec(request);
      return HttpResponse.json({ items: [], total: svc.waiting[String(params.id)] ?? 0, offset: 0, limit: 0 });
    }),
    http.get(url("/projects"), async ({ request }) => {
      await rec(request);
      return HttpResponse.json(PROJECTS);
    }),
    http.get(url("/projects/:id/governance"), async ({ request, params }) => {
      await rec(request);
      return HttpResponse.json({ yaml: GOVERNANCE[String(params.id)] ?? OPEN_GOVERNANCE, sha256: "a".repeat(64), violations: [] });
    }),
    http.get(url("/secrets/zotero-api-key"), async ({ request }) => {
      await rec(request);
      return HttpResponse.json({ stored: svc.keyStored });
    }),
    http.put(url("/secrets/zotero-api-key"), async ({ request }) => {
      await rec(request);
      svc.keyStored = true;
      return HttpResponse.json({ stored: true });
    }),
    http.delete(url("/secrets/zotero-api-key"), async ({ request }) => {
      await rec(request);
      const removed = svc.keyStored;
      svc.keyStored = false;
      return HttpResponse.json({ removed });
    }),
  );
  return svc;
}
type Svc = ReturnType<typeof useSvc>;

async function show(svc: Svc) {
  const view = render(<ZoteroSync client={testClient()} />);
  await screen.findByRole("heading", { level: 1, name: "Zotero" });
  await waitFor(() => expect(svc.events.open()).toBe(true));
  await waitFor(() => expect(svc.count("GET", "/zotero/sync")).toBeGreaterThan(0));
  await screen.findByTestId("zotero-libraries");
  return view;
}
const push = async (svc: Svc, type: string, data: unknown) => act(async () => svc.events.push(type, data));
const syncButton = () => screen.getByRole("button", { name: /^(Sync with Zotero now|Stop syncing)$/ });
const row = (name: string) => screen.getByRole("region", { name });
const liveText = () => screen.getByTestId("zotero-live").textContent ?? "";
const progressText = () => screen.getByTestId("zotero-progress").textContent ?? "";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
describe("zoteroSyncApi: every request is exactly its handler's", () => {
  it("state: GET /zotero/sync with no body", async () => {
    const svc = useSvc();
    await zoteroSyncApi(testClient()).state();
    expect(svc.calls).toEqual([{ method: "GET", path: "/zotero/sync", body: "", contentType: null }]);
  });
  it("the key check is sent with no body (POST /zotero/key-check)", async () => {
    const svc = useSvc();
    const r = await zoteroSyncApi(testClient()).checkKey();
    expect(svc.calls).toEqual([{ method: "POST", path: "/zotero/key-check", body: "", contentType: null }]);
    expect(r.summary).toBe(ACCESS.summary);
  });
  it("saveSettings: PUT /zotero/sync/settings with the whole request and nothing else", async () => {
    const svc = useSvc();
    const req = {
      automatic: true,
      everyMinutes: 240 as const,
      links: [
        { ref: "group:7", projectId: P1, structure: "tags" as const, duplicates: "skip" as const, extra: 1 },
        { ref: "user:42", projectId: P1, structure: "none" as const, duplicates: "merge" as const, resume: true as const },
      ],
    };
    await zoteroSyncApi(testClient()).saveSettings(req);
    expect(svc.calls.map((c) => [c.method, c.path, c.contentType])).toEqual([["PUT", "/zotero/sync/settings", "application/json"]]);
    // `resume` only where it is true (R265); nothing else.
    expect(svc.calls[0]!.body).toBe(
      JSON.stringify({
        automatic: true,
        everyMinutes: 240,
        links: [
          { ref: "group:7", projectId: P1, structure: "tags", duplicates: "skip" },
          { ref: "user:42", projectId: P1, structure: "none", duplicates: "merge", resume: true },
        ],
      }),
    );
  });
  it("run: POST /zotero/sync/run with no body, or { ref }, answered 202", async () => {
    const svc = useSvc();
    expect(await zoteroSyncApi(testClient()).run()).toEqual({ started: true });
    await zoteroSyncApi(testClient()).run("group:7");
    expect(svc.calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/zotero/sync/run", ""],
      ["POST", "/zotero/sync/run", JSON.stringify({ ref: "group:7" })],
    ]);
  });
  it("stop: POST /zotero/sync/stop with no body", async () => {
    const svc = useSvc();
    await zoteroSyncApi(testClient()).stop();
    expect(svc.calls).toEqual([{ method: "POST", path: "/zotero/sync/stop", body: "", contentType: null }]);
  });
  it("history: GET /zotero/sync/history with no body", async () => {
    const svc = useSvc({}, [run()]);
    const r = await zoteroSyncApi(testClient()).history();
    expect(svc.calls).toEqual([{ method: "GET", path: "/zotero/sync/history", body: "", contentType: null }]);
    expect(r.runs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("ZoteroSync", () => {
  it("shows the plan's heading, intro and sections", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, lastRun: run() }] });
    await show(svc);
    expect(screen.getByText("Your Zotero libraries come into this app and stay in step. Nothing in Zotero is ever changed, and nothing here is deleted because it was deleted in Zotero.")).toBeTruthy();
    for (const h of ["Your Zotero key", "Libraries to keep in step", "Automatic sync", "History"]) expect(screen.getByRole("heading", { level: 2, name: h })).toBeTruthy();
  });

  it("automatic sync is off by default and 15 minutes cannot be chosen", async () => {
    const svc = useSvc();
    await show(svc);
    const auto = screen.getByRole("checkbox", { name: "Sync automatically while the app is open" }) as HTMLInputElement;
    expect(auto.checked).toBe(false);
    const often = screen.getByRole("combobox", { name: "How often" }) as HTMLSelectElement;
    expect([...often.options].map((o) => [o.value, o.textContent])).toEqual([
      ["30", "Every 30 minutes"],
      ["60", "Every hour"],
      ["240", "Every 4 hours"],
    ]);
    expect(often.value).toBe("60");
    expect(screen.getByText("Only while this library is open and the project is unlocked.")).toBeTruthy();
    // The state has no nextRunAt (automatic sync is off): no "next sync" line.
    expect(screen.queryByText(/next automatic sync/i)).toBeNull();
  });

  it("Z10 (R274 c): the screen shows the next-sync line only when the state gives a time, in the automatic section", async () => {
    const at = new Date(Date.now() + 40 * 60_000).toISOString();
    const svc = useSvc({ automatic: true, nextRunAt: at, links: [{ ref: "user:42", projectId: P1, lastRun: run() }] });
    await show(svc);
    const auto = screen.getByRole("region", { name: "Automatic sync" });
    const line = await within(auto).findByText(zoteroNextSyncLine(at, new Date()));
    expect(line.textContent).toMatch(/^Next automatic sync: not before /u);
    // The state read again without it (automatic turned off, or nothing can become due): the line goes.
    const done = run();
    svc.state = stateOf({ automatic: false, links: [{ ref: "user:42", projectId: P1, lastRun: done }] });
    svc.history = [done];
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "finished", run: done });
    await waitFor(() => expect(screen.queryByText(/next automatic sync/i)).toBeNull());
  });

  it("a failed run reads as a failure, never up to date; a failed, stopped or problem run shows nothing that reads as success", async () => {
    const failed = run({ outcome: "failed", reason: "offline", counts: ZERO });
    const stopped = run({ ref: "group:7", outcome: "stopped", reason: "stopped-by-you", batchId: B1, counts: { ...ZERO, new: 4 } });
    const problems = run({ ref: "group:8", projectId: P3, outcome: "finished-with-problems", counts: { ...ZERO, failed: 2, new: 1 } });
    const svc = useSvc(
      {
        links: [
          { ref: "user:42", projectId: P1, lastRun: failed },
          { ref: "group:7", projectId: P1, lastRun: stopped },
          { ref: "group:8", projectId: P3, lastRun: problems },
        ],
      },
      [problems, stopped, failed],
    );
    await show(svc);
    const lines = svc.state.links.map((l) => l.status);
    expect(lines[0]).toMatch(/^Could not sync with Zotero at \d\d:\d\d today: Zotero could not be reached/);
    for (const [i, name] of ["Zotero library user:42", "Zotero group 7", "Zotero group 8"].entries()) {
      const r = row(name);
      expect(within(r).getByText(lines[i]!)).toBeTruthy();
      expect(r.textContent).not.toMatch(/up to date|nothing has changed|✓|✔|☑/i);
      expect(r.querySelector("[class*='success'], [class*='ok']")).toBeNull();
    }
    const hist = within(screen.getByRole("list", { name: "Sync history" })).getAllByRole("listitem");
    expect(hist.map((li) => li.textContent)).toEqual([
      `Zotero group 8: ${zoteroSyncStatusLine(problems, new Date())}`,
      `Zotero group 7: ${zoteroSyncStatusLine(stopped, new Date())}`,
      `Zotero library user:42: ${zoteroSyncStatusLine(failed, new Date())}`,
    ]);
    expect(document.body.textContent).not.toMatch(/up to date|✓|✔/i);
    // The end of a failed run is said in the service's words, never as success.
    const said = run({ outcome: "failed", reason: "key-refused", counts: ZERO });
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "finished", run: said });
    await waitFor(() => expect(liveText()).toBe(`Zotero library user:42: ${zoteroSyncStatusLine(said, new Date())}`));
    expect(liveText()).toMatch(/Could not sync/);
  });

  it("R295 b: a run the project's rules refused shows the shared sentence, as a failure", async () => {
    const denied = run({ outcome: "failed", reason: "rules-denied", counts: undefined as never });
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, lastRun: denied }] }, [denied]);
    await show(svc);
    const sentence = ZOTERO_SYNC_REASON_TEXT["rules-denied"];
    expect((await screen.findAllByText(new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"))).length).toBeGreaterThan(0);
    expect(screen.queryByText(/up to date|nothing has changed/iu)).toBeNull();
  });

  it("a history row and a link's line are the service's words", async () => {
    const runs = Array.from({ length: 25 }, (_, i) => run({ startedAt: at(100 - i), finishedAt: at(99 - i), counts: { ...ZERO, new: i } }));
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, lastRun: runs[0], status: "The service's own line for this link." }] }, runs);
    await show(svc);
    // The link's line is the state's `status`, as it came.
    expect(within(row("Zotero library user:42")).getByText("The service's own line for this link.")).toBeTruthy();
    // A history row is the shared zoteroSyncStatusLine of its record; the last 20, newest first (as the service sends them).
    const hist = within(screen.getByRole("list", { name: "Sync history" })).getAllByRole("listitem");
    expect(hist).toHaveLength(20);
    expect(hist.map((li) => li.textContent)).toEqual(runs.slice(0, 20).map((r) => `Zotero library user:42: ${zoteroSyncStatusLine(r, new Date())}`));
  });

  it("group names render through UserText", async () => {
    const svc = useSvc({ links: [] });
    svc.access = { ...ACCESS, groups: [{ ref: "group:7", name: "Lab <img src=x onerror=alert(1)> group", write: false }] };
    await show(svc);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Check the key" }));
    const r = await screen.findByRole("region", { name: "Lab <img src=x onerror=alert(1)> group" });
    expect(document.querySelector("img")).toBeNull();
    const name = within(r).getAllByText("Lab <img src=x onerror=alert(1)> group")[0]!;
    expect(name.getAttribute("dir")).toBe("auto");
    // Every control of the row names its library.
    expect(within(r).getByRole("checkbox", { name: "Keep “Lab <img src=x onerror=alert(1)> group” in step" })).toBeTruthy();
    expect(within(r).getByRole("combobox", { name: "Into project for “Lab <img src=x onerror=alert(1)> group”" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "My library" })).toBeTruthy();
  });

  it("the key check says what the key can read, with the plan's extra lines", async () => {
    const svc = useSvc();
    svc.access = { ...ACCESS, personal: { library: true, files: false, notes: false, write: true }, summary: "This key can read your library and 1 group library." };
    await show(svc);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Check the key" }));
    const result = await screen.findByTestId("zotero-key-result");
    expect(result.textContent).toContain("This key can read your library and 1 group library.");
    expect(result.textContent).toContain("It cannot read attached files, so only references, notes and highlights will come in.");
    expect(result.textContent).toContain("It cannot read notes.");
    expect(result.textContent).toContain(
      "This key could also change your Zotero library. This app never does, but a key that can only read is safer: at zotero.org, Settings, Security, make a new key with “Allow write access” off.",
    );
  });

  it("a refused key check shows the service's sentence and changes nothing", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }] });
    svc.onCheck = () => HttpResponse.json({ error: { code: "CONFLICT", message: ZOTERO_SYNC_REASON_TEXT["key-refused"], reason: "key-refused" } }, { status: 409 });
    await show(svc);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Check the key" }));
    expect((await screen.findByTestId("zotero-key-error")).textContent).toBe(ZOTERO_SYNC_REASON_TEXT["key-refused"]);
    expect(screen.queryByRole("region", { name: "My library" })).toBeNull();
  });

  it("the key is in no request but the secrets PUT, and nowhere in the page afterwards", async () => {
    const consoleCalls: unknown[][] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleCalls.push(a));
    const seen: Array<{ method: string; url: string; headers: string; body: string }> = [];
    const onStart = async ({ request }: { request: Request }) => {
      seen.push({ method: request.method, url: request.url, headers: JSON.stringify([...request.headers]), body: await request.clone().text() });
    };
    server.events.on("request:start", onStart);
    try {
      const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, lastRun: run() }] });
      svc.keyStored = false;
      await show(svc);
      const user = userEvent.setup();
      await screen.findByText("No Zotero key is stored on this computer.");
      await user.type(screen.getByLabelText("Zotero API key"), KEY);
      await user.click(screen.getByRole("button", { name: "Store key" }));
      await screen.findByText("A Zotero key is stored on this computer.");
      await user.click(screen.getByRole("button", { name: "Check the key" }));
      await screen.findByRole("region", { name: "Lab group" });
      await user.click(screen.getByRole("checkbox", { name: "Keep “Lab group” in step" }));
      await user.selectOptions(screen.getByRole("combobox", { name: "Into project for “Lab group”" }), P3);
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(liveText()).toBe("Saved."));
      await user.click(syncButton());
      await waitFor(() => expect(svc.count("POST", "/zotero/sync/run")).toBe(1));
      // Only the secrets PUT carried it, in its body.
      const carrying = seen.filter((s) => `${s.url} ${s.headers} ${s.body}`.includes(KEY));
      expect(carrying.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(["PUT /secrets/zotero-api-key"]);
      expect(seen.filter((s) => s.url.includes(KEY) || s.headers.includes(KEY))).toEqual([]);
      expect(svc.bodies("POST", "/zotero/key-check")).toEqual([""]);
      // Nowhere in the page, its attributes included, in no console line and in no storage.
      expect(document.documentElement.outerHTML).not.toContain(KEY);
      expect([...document.querySelectorAll("input")].map((i) => i.value)).not.toContain(KEY);
      expect(JSON.stringify(consoleCalls)).not.toContain(KEY);
      for (const st of [localStorage, sessionStorage]) {
        for (let i = 0; i < st.length; i++) expect(`${st.key(i)}=${st.getItem(st.key(i)!)}`).not.toContain(KEY);
      }
    } finally {
      server.events.removeListener("request:start", onStart);
    }
  });

  it("no key check is made without a press", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }, { ref: "group:99", projectId: P1 }] });
    await show(svc);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Zotero API key"), KEY);
    await user.click(screen.getByRole("button", { name: "Replace key" }));
    await screen.findByText("The key is stored in this computer's password store.");
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "finished", run: run() });
    await waitFor(() => expect(svc.count("GET", "/zotero/sync")).toBeGreaterThan(1));
    await act(async () => new Promise((r) => setTimeout(r, 100)));
    expect(svc.count("POST", "/zotero/key-check")).toBe(0);
    // Before any check in this visit: the stored links by their Zotero number, with a hint.
    expect(row("Zotero library user:42")).toBeTruthy();
    expect(row("Zotero group 99")).toBeTruthy();
    expect(screen.getByText("Press “Check the key” to see the names of your Zotero libraries; until then, linked libraries are shown by their Zotero number.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Check the key" }));
    await waitFor(() => expect(svc.count("POST", "/zotero/key-check")).toBe(1));
  });

  it("a stored link the key no longer lists is still shown", async () => {
    const gone = run({ ref: "group:99", outcome: "failed", reason: "library-gone", counts: ZERO });
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, lastRun: run() }, { ref: "group:99", projectId: P3, lastRun: gone }] });
    await show(svc);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Check the key" }));
    await screen.findByRole("region", { name: "Lab group" });
    expect([...within(screen.getByTestId("zotero-libraries")).getAllByRole("heading", { level: 3 })].map((h) => h.textContent)).toEqual(["My library", "Lab group", "Zotero group 99"]);
    const r = row("Zotero group 99");
    expect(within(r).getByText("The last key check did not list this library.")).toBeTruthy();
    expect(within(r).getByText(zoteroSyncStatusLine(gone, new Date()))).toBeTruthy();
    expect((within(r).getByRole("checkbox", { name: "Keep “Zotero group 99” in step" }) as HTMLInputElement).checked).toBe(true);
    expect((within(r).getByRole("combobox", { name: "Into project for “Zotero group 99”" }) as HTMLSelectElement).value).toBe(P3);
    // Names are kept in this visit only.
    for (const st of [localStorage, sessionStorage]) for (let i = 0; i < st.length; i++) expect(st.getItem(st.key(i)!)).not.toContain("Lab group");
  });

  it("each pause says why and offers its remedy", async () => {
    const svc = useSvc({
      links: [
        { ref: "user:42", projectId: P1, paused: "undone" },
        { ref: "group:7", projectId: P1, paused: "key-refused", lastRun: run({ ref: "group:7", outcome: "failed", reason: "key-refused", counts: ZERO }) },
        { ref: "group:8", projectId: P3, paused: "library-gone" },
        { ref: "group:9", projectId: P2, waitingFor: "project-locked", lastRun: run({ ref: "group:9", projectId: P2, counts: undefined }) },
      ],
    });
    svc.access = { ...ACCESS, groups: [] };
    await show(svc);
    const user = userEvent.setup();
    // undone: the sentence, and a control that turns syncing on again (a settings save for that link).
    const undone = row("Zotero library user:42");
    expect(within(undone).getByText(ZOTERO_SYNC_REASON_TEXT["sync-undone"])).toBeTruthy();
    expect(undone.textContent).not.toBe("Not synced yet.");
    // key-refused: the sentence and "Check the key".
    const refused = row("Zotero group 7");
    expect(within(refused).getByText(ZOTERO_SYNC_REASON_TEXT["key-refused"])).toBeTruthy();
    expect(within(refused).getByRole("button", { name: "Check the key for “Zotero group 7”" })).toBeTruthy();
    // library-gone: the sentence, that a key check clears it, and "Check the key".
    const gone = row("Zotero group 8");
    expect(within(gone).getByText(ZOTERO_SYNC_REASON_TEXT["library-gone"])).toBeTruthy();
    expect(within(gone).getByText("When the key can read this library again, “Check the key” turns syncing of it back on.")).toBeTruthy();
    expect(within(gone).getByRole("button", { name: "Check the key for “Zotero group 8”" })).toBeTruthy();
    // A locked project: "Unlock the project to sync.", and its line has no counts.
    const locked = row("Zotero group 9");
    expect(within(locked).getByText("Unlock the project to sync.")).toBeTruthy();
    expect(within(locked).getByText(/^Last synced with Zotero at \d\d:\d\d today\.$/)).toBeTruthy();

    // Turn syncing on again: one settings save of the service's own settings (not the draft); focus stays in the row.
    await user.click(screen.getByRole("combobox", { name: "How often" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "How often" }), "240");
    await user.click(within(undone).getByRole("button", { name: "Turn syncing on again for “Zotero library user:42”" }));
    await waitFor(() => expect(svc.count("PUT", "/zotero/sync/settings")).toBe(1));
    expect(JSON.parse(svc.bodies("PUT", "/zotero/sync/settings")[0]!)).toEqual({
      automatic: false,
      everyMinutes: 60,
      links: [
        { ref: "user:42", projectId: P1, structure: "collections", duplicates: "merge", resume: true },
        { ref: "group:7", projectId: P1, structure: "collections", duplicates: "merge" },
        { ref: "group:8", projectId: P3, structure: "collections", duplicates: "merge" },
        { ref: "group:9", projectId: P2, structure: "collections", duplicates: "merge" },
      ],
    });
    await waitFor(() => expect(within(row("Zotero library user:42")).queryByText(ZOTERO_SYNC_REASON_TEXT["sync-undone"])).toBeNull());
    expect(document.activeElement).toBe(within(row("Zotero library user:42")).getByRole("checkbox", { name: "Keep “Zotero library user:42” in step" }));
    // The unsaved choice of interval is still there.
    expect((screen.getByRole("combobox", { name: "How often" }) as HTMLSelectElement).value).toBe("240");

    // Check the key on the row: a key check with no body, then the state is read again; the pause goes.
    svc.state = { ...svc.state, links: svc.state.links.map((l) => (l.ref === "group:7" ? (({ paused: _p, waitingFor: _w, ...rest }) => rest)(l) : l)) };
    const reads = svc.count("GET", "/zotero/sync");
    await user.click(within(row("Zotero group 7")).getByRole("button", { name: "Check the key for “Zotero group 7”" }));
    await waitFor(() => expect(svc.count("GET", "/zotero/sync")).toBeGreaterThan(reads));
    expect(svc.bodies("POST", "/zotero/key-check")).toEqual([""]);
    await waitFor(() => expect(within(row("Zotero group 7")).queryByText(ZOTERO_SYNC_REASON_TEXT["key-refused"])).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("R265: Save sends the draft with no resume, and an undone row stays paused with its reason and its control", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, paused: "undone", structure: "tags" }] });
    await show(svc);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "How often" }), "240");
    await user.click(screen.getByRole("checkbox", { name: "Sync automatically while the app is open" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(liveText()).toBe("Saved."));
    expect(svc.bodies("PUT", "/zotero/sync/settings")).toEqual([
      JSON.stringify({ automatic: true, everyMinutes: 240, links: [{ ref: "user:42", projectId: P1, structure: "tags", duplicates: "merge" }] }),
    ]);
    const r = row("Zotero library user:42");
    expect(within(r).getByText(ZOTERO_SYNC_REASON_TEXT["sync-undone"])).toBeTruthy();
    expect(within(r).getByRole("button", { name: "Turn syncing on again for “Zotero library user:42”" })).toBeTruthy();
    expect(svc.state.links[0]!.paused).toBe("undone");
  });

  it("R265: of two undone rows, the one turned on again is resumed and the other stays paused; the draft survives", async () => {
    const svc = useSvc({
      links: [
        { ref: "user:42", projectId: P1, paused: "undone" },
        { ref: "group:7", projectId: P3, paused: "undone", duplicates: "skip" },
      ],
      everyMinutes: 30,
    });
    await show(svc);
    const user = userEvent.setup();
    // Unsaved: a new interval and group:7 unticked. "Turn syncing on again" must send neither.
    await user.selectOptions(screen.getByRole("combobox", { name: "How often" }), "240");
    await user.click(screen.getByRole("checkbox", { name: "Keep “Zotero group 7” in step" }));
    await user.click(within(row("Zotero group 7")).getByRole("button", { name: "Turn syncing on again for “Zotero group 7”" }));
    await waitFor(() => expect(svc.count("PUT", "/zotero/sync/settings")).toBe(1));
    expect(svc.bodies("PUT", "/zotero/sync/settings")).toEqual([
      JSON.stringify({
        automatic: false,
        everyMinutes: 30,
        links: [
          { ref: "user:42", projectId: P1, structure: "collections", duplicates: "merge" },
          { ref: "group:7", projectId: P3, structure: "collections", duplicates: "skip", resume: true },
        ],
      }),
    ]);
    await waitFor(() => expect(within(row("Zotero group 7")).queryByText(ZOTERO_SYNC_REASON_TEXT["sync-undone"])).toBeNull());
    expect(within(row("Zotero library user:42")).getByText(ZOTERO_SYNC_REASON_TEXT["sync-undone"])).toBeTruthy();
    expect(within(row("Zotero library user:42")).getByRole("button", { name: "Turn syncing on again for “Zotero library user:42”" })).toBeTruthy();
    // The draft is still as the researcher left it.
    expect((screen.getByRole("combobox", { name: "How often" }) as HTMLSelectElement).value).toBe("240");
    expect((screen.getByRole("checkbox", { name: "Keep “Zotero group 7” in step" }) as HTMLInputElement).checked).toBe(false);
  });

  it("Sync now becomes Stop syncing and focus stays on it", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, lastRun: run() }] });
    await show(svc);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Check the key" }));
    await screen.findByRole("region", { name: "My library" });
    const button = syncButton();
    expect(button.textContent).toBe("Sync with Zotero now");
    svc.state = { ...svc.state, running: { ref: "user:42", done: 0, total: 0 } };
    await user.dblClick(button);
    await waitFor(() => expect(syncButton().textContent).toBe("Stop syncing"));
    expect(svc.count("POST", "/zotero/sync/run")).toBe(1); // a double click sends one request
    expect(document.activeElement).toBe(syncButton());
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "checking" });
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "running", done: 120, total: 400 });
    await waitFor(() => expect(progressText()).toBe("Syncing “My library”: 120 of 400 items"));
    expect(screen.getByTestId("zotero-progress").getAttribute("role")).toBe("status");
    expect(within(screen.getByTestId("zotero-progress")).getByText("My library").getAttribute("dir")).toBe("auto");
    // The run ends: the record is said once, the button is "Sync with Zotero now" again, with focus.
    const done = run();
    svc.state = { ...stateOf({ links: [{ ref: "user:42", projectId: P1, lastRun: done }] }) };
    svc.history = [done];
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "finished", run: done });
    await waitFor(() => expect(syncButton().textContent).toBe("Sync with Zotero now"));
    expect(document.activeElement).toBe(syncButton());
    expect(liveText()).toBe(`My library: ${zoteroSyncStatusLine(done, new Date())}`);
    expect(progressText()).toBe("");
  });

  it("Stop syncing sends one stop; refusals of run and stop show the service's sentence", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, paused: "key-refused" }], running: { ref: "user:42", done: 1, total: 10 } });
    await show(svc);
    const user = userEvent.setup();
    expect(syncButton().textContent).toBe("Stop syncing");
    svc.onStop = () => serviceError(409, "CONFLICT", ZOTERO_SYNC_SENTENCES.notRunning);
    svc.state = { ...svc.state, running: undefined };
    await user.dblClick(syncButton());
    expect((await screen.findByTestId("zotero-run-error")).textContent).toBe(ZOTERO_SYNC_SENTENCES.notRunning);
    expect(svc.count("POST", "/zotero/sync/stop")).toBe(1);
    await waitFor(() => expect(syncButton().textContent).toBe("Sync with Zotero now"));
    await act(async () => new Promise((r) => setTimeout(r, 100)));
    expect(svc.count("POST", "/zotero/sync/run")).toBe(0); // the rest of the double click started nothing
    expect(document.activeElement).toBe(syncButton());
    for (const msg of [ZOTERO_SYNC_SENTENCES.allPaused, ZOTERO_SYNC_SENTENCES.nothingLinked, ZOTERO_SYNC_SENTENCES.alreadyRunning, ZOTERO_SYNC_SENTENCES.notLinked, "This library is open read-only, so nothing can be changed.", ZOTERO_SYNC_REASON_TEXT["import-running"]]) {
      svc.onRun = () => serviceError(409, "CONFLICT", msg);
      await act(async () => new Promise((r) => setTimeout(r, 550))); // a new press, not the rest of a double click
      await user.click(syncButton());
      await waitFor(() => expect(screen.getByTestId("zotero-run-error").textContent).toBe(msg));
      expect(screen.getByTestId("zotero-run-error").getAttribute("role")).toBe("alert");
    }
  });

  it("back-off: disabled with its reason, enabled when the time passes (one timer, no polling)", async () => {
    // The clock is set to midday: ten minutes on is the same day, so the sentence names the time alone. (With the real
    // clock this test failed in the last ten minutes of a day, when the sentence rightly names the day too.)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true, now: new Date(2026, 10, 12, 12, 0, 0) });
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }], backoffUntil: until });
    await show(svc);
    const button = syncButton();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const reason = zoteroSyncReasonText("backing-off", new Date(), until);
    expect(reason).toMatch(/^Zotero asked this app to wait until \d\d:\d\d\.$/);
    const note = screen.getByTestId("zotero-backoff");
    expect(note.textContent).toBe(reason);
    expect(button.getAttribute("aria-describedby")?.split(" ")).toContain(note.id);
    // A press does nothing while it is in force.
    await act(async () => button.click());
    expect(svc.count("POST", "/zotero/sync/run")).toBe(0);
    const reads = svc.count("GET", "/zotero/sync");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9 * 60_000);
    });
    expect(syncButton().getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    await waitFor(() => expect(syncButton().getAttribute("aria-disabled")).toBeNull());
    expect(screen.queryByTestId("zotero-backoff")).toBeNull();
    expect(svc.count("GET", "/zotero/sync")).toBe(reads); // by a timer, not by reading again
    await act(async () => syncButton().click());
    await waitFor(() => expect(svc.count("POST", "/zotero/sync/run")).toBe(1));
  });

  it("a run already going is shown as running", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }], running: { ref: "user:42", done: 120, total: 400 } });
    await show(svc);
    expect(syncButton().textContent).toBe("Stop syncing");
    await waitFor(() => expect(progressText()).toBe("Syncing “Zotero library user:42”: 120 of 400 items"));
  });

  it("a run started elsewhere shows through the events; before a total is known it says so without numbers; at most one update a second", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }] });
    await show(svc);
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "checking" });
    await waitFor(() => expect(syncButton().textContent).toBe("Stop syncing"));
    expect(progressText()).toBe("Syncing “Zotero library user:42”: the number of items is not known yet.");
    await act(async () => new Promise((r) => setTimeout(r, 1100)));
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "running", done: 1, total: 400 });
    await waitFor(() => expect(progressText()).toBe("Syncing “Zotero library user:42”: 1 of 400 items"));
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "running", done: 2, total: 400 });
    await act(async () => new Promise((r) => setTimeout(r, 200)));
    expect(progressText()).toBe("Syncing “Zotero library user:42”: 1 of 400 items");
    await waitFor(() => expect(progressText()).toBe("Syncing “Zotero library user:42”: 2 of 400 items"));
  });

  it("the history's rows never include the run in progress", async () => {
    const older = [run({ counts: { ...ZERO, new: 1 } }), run({ counts: { ...ZERO, new: 2 } })];
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, lastRun: older[0] }], running: { ref: "user:42", done: 5, total: 50 } }, older);
    await show(svc);
    const list = screen.getByRole("list", { name: "Sync history" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    const histReads = svc.count("GET", "/zotero/sync/history");
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "running", done: 6, total: 50 });
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list.textContent).not.toMatch(/Syncing/);
    expect(svc.count("GET", "/zotero/sync/history")).toBe(histReads);
    expect(progressText()).toMatch(/^Syncing/);
  });

  it("a burst of events makes a handful of reads", async () => {
    const links = [42, 7, 8, 9, 10].map((n, i) => ({ ref: i === 0 ? `user:${n}` : `group:${n}`, projectId: P1 }));
    const svc = useSvc({ links });
    await show(svc);
    const base = svc.count("GET", "/zotero/sync");
    const slow = svc.state;
    svc.onState = async () => {
      await new Promise((r) => setTimeout(r, 40));
      return HttpResponse.json(slow);
    };
    await act(async () => {
      for (const l of links) {
        svc.events.push("zotero.sync", { ref: l.ref, projectId: P1, state: "checking" });
        svc.events.push("zotero.sync", { ref: l.ref, projectId: P1, state: "running", done: 1, total: 2 });
        svc.events.push("zotero.sync", { ref: l.ref, projectId: P1, state: "finished", run: run({ ref: l.ref }) });
      }
    });
    await waitFor(() => expect(svc.count("GET", "/zotero/sync")).toBeGreaterThan(base));
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    const reads = svc.count("GET", "/zotero/sync") - base;
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(reads).toBeLessThanOrEqual(3);
    await waitFor(() => expect(syncButton().textContent).toBe("Sync with Zotero now"));
  });

  it("of two reads the later-started wins (and a save's answer wins over a read already out)", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }] });
    await show(svc);
    const user = userEvent.setup();
    // A read started by an event is held; a save started after it answers first; the old read's answer is then dropped.
    const gate = held();
    const old = stateOf({ links: [{ ref: "user:42", projectId: P1 }], automatic: false, everyMinutes: 60 });
    let first = true;
    svc.onState = async () => {
      if (!first) return HttpResponse.json(svc.state);
      first = false;
      await gate.p;
      return HttpResponse.json(old);
    };
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "finished", run: run() });
    await waitFor(() => expect(svc.count("GET", "/zotero/sync")).toBe(2));
    await user.click(screen.getByRole("checkbox", { name: "Sync automatically while the app is open" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "How often" }), "240");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(liveText()).toBe("Saved."));
    await act(async () => {
      gate.release();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect((screen.getByRole("checkbox", { name: "Sync automatically while the app is open" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("combobox", { name: "How often" }) as HTMLSelectElement).value).toBe("240");
  });

  it("an answer after leaving is dropped; after the library closed, an older answer does not bring it back", async () => {
    const errors = vi.spyOn(console, "error");
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }] });
    const gate = held();
    svc.onState = async () => {
      await gate.p;
      return HttpResponse.json(svc.state);
    };
    const view = render(<ZoteroSync client={testClient()} />);
    await waitFor(() => expect(svc.count("GET", "/zotero/sync")).toBe(1));
    view.unmount();
    await act(async () => {
      gate.release();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(errors).not.toHaveBeenCalled();
    expect(svc.count("GET", "/zotero/sync/history")).toBeLessThanOrEqual(1);

    // The library closes while a read is out: the screen says so, and the late answer does not undo it.
    svc.onState = undefined;
    await show(svc);
    const gate2 = held();
    svc.onState = async () => {
      await gate2.p;
      return HttpResponse.json(svc.state);
    };
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "finished", run: run() });
    await push(svc, "library.state", { open: false });
    await screen.findByText("No library is open.");
    await act(async () => {
      gate2.release();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByText("No library is open.")).toBeTruthy();
    expect(screen.queryByTestId("zotero-libraries")).toBeNull();
  });

  it("with no library open says so as the service does", async () => {
    const svc = useSvc();
    svc.onState = () => serviceError(503, "LIBRARY_OFFLINE", "No library is open.");
    render(<ZoteroSync client={testClient()} />);
    expect((await screen.findByText("No library is open.")).closest("[role='status']")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sync with Zotero now" })).toBeNull();
  });

  it("read-only shows no controls", async () => {
    const svc = useSvc({ readOnly: true, links: [{ ref: "user:42", projectId: P1, lastRun: run() }] }, [run()]);
    await show(svc);
    expect(screen.getByText(ZOTERO_SYNC_REASON_TEXT["library-read-only"])).toBeTruthy();
    expect(within(row("Zotero library user:42")).getByText(svc.state.links[0]!.status)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(screen.queryAllByRole("combobox")).toEqual([]);
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(document.querySelector("input")).toBeNull();
  });

  it("after Save focus stays on Save; a new link gets the wizard's defaults and a stored one keeps its own", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, structure: "tags", duplicates: "skip", lastRun: run() }] });
    svc.access = { ...ACCESS, groups: [...ACCESS.groups, { ref: "group:8", name: "Field team", write: false }] };
    await show(svc);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Check the key" }));
    await screen.findByRole("region", { name: "Lab group" });
    // A locked project is listed "(locked)" and cannot be newly chosen.
    const into = screen.getByRole("combobox", { name: "Into project for “Lab group”" }) as HTMLSelectElement;
    const lockedOpt = [...into.options].find((o) => o.value === P2)!;
    expect(lockedOpt.textContent).toBe("Clinic interviews (locked)");
    expect(lockedOpt.disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "Keep “Lab group” in step" }));
    await user.selectOptions(into, P3);
    await user.click(screen.getByRole("checkbox", { name: "Keep “Field team” in step" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Into project for “Field team”" }), P4);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(liveText()).toBe("Saved."));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
    expect(svc.bodies("PUT", "/zotero/sync/settings").map((b) => JSON.parse(b))).toEqual([
      {
        automatic: false,
        everyMinutes: 60,
        links: [
          { ref: "user:42", projectId: P1, structure: "tags", duplicates: "skip" },
          { ref: "group:7", projectId: P3, structure: "collections", duplicates: "merge" },
          { ref: "group:8", projectId: P4, structure: "none", duplicates: "merge" },
        ],
      },
    ]);
    // The screen shows the service's answer.
    await waitFor(() => expect(within(row("Lab group")).getByText("Not synced yet.")).toBeTruthy());
  });

  it("a refused field gets the sentence and the focus; a refusal that names no field changes nothing on screen", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }] });
    await show(svc);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Check the key" }));
    await screen.findByRole("region", { name: "Lab group" });
    await user.click(screen.getByRole("checkbox", { name: "Keep “Lab group” in step" }));
    const msg = '"links[1].projectId" is not a project in this library.';
    svc.onSave = () => serviceError(400, "VALIDATION", msg);
    await user.click(screen.getByRole("button", { name: "Save" }));
    const select = screen.getByRole("combobox", { name: "Into project for “Lab group”" });
    await waitFor(() => expect(document.activeElement).toBe(select));
    const described = (select.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain(msg);
    // The interval refused: at "How often".
    const msg2 = '"everyMinutes" must be 30, 60 or 240.';
    svc.onSave = () => serviceError(400, "VALIDATION", msg2);
    await user.click(screen.getByRole("button", { name: "Save" }));
    const often = screen.getByRole("combobox", { name: "How often" });
    await waitFor(() => expect(document.activeElement).toBe(often));
    expect((often.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent)).toContain(msg2);
    // A newer version's file: the service's sentence; the form stays as the researcher left it.
    const newer = "These sync settings were written by a newer version of the app. Update the app to change them.";
    svc.onSave = () => serviceError(409, "CONFLICT", newer);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByTestId("zotero-save-error")).textContent).toBe(newer);
    expect((screen.getByRole("checkbox", { name: "Keep “Lab group” in step" }) as HTMLInputElement).checked).toBe(true);
    svc.onSave = () => serviceError(503, "UNAVAILABLE", ZOTERO_SYNC_SENTENCES.settingsUnreadable);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("zotero-save-error").textContent).toBe(ZOTERO_SYNC_SENTENCES.settingsUnreadable));
    expect((screen.getByRole("checkbox", { name: "Keep “Lab group” in step" }) as HTMLInputElement).checked).toBe(true);
  });

  it("a draft survives an event", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, lastRun: run() }] });
    await show(svc);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "How often" }), "240");
    await user.click(screen.getByRole("checkbox", { name: "Keep “Zotero library user:42” in step" }));
    const fresh = run({ counts: { ...ZERO, new: 9 } });
    svc.state = stateOf({ links: [{ ref: "user:42", projectId: P1, lastRun: fresh }] });
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "finished", run: fresh });
    await waitFor(() => expect(within(row("Zotero library user:42")).getByText(zoteroSyncStatusLine(fresh, new Date()))).toBeTruthy());
    expect((screen.getByRole("combobox", { name: "How often" }) as HTMLSelectElement).value).toBe("240");
    expect((screen.getByRole("checkbox", { name: "Keep “Zotero library user:42” in step" }) as HTMLInputElement).checked).toBe(false);
  });

  it("links out: the import report of the last run, and the project's review queue with its CURRENT number waiting (R268 M3)", async () => {
    const last = run({ batchId: B1, counts: { ...ZERO, new: 2, waiting: 3, conflicts: 1 } });
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, lastRun: last }, { ref: "group:7", projectId: P1 }, { ref: "group:8", projectId: P3 }] });
    svc.waiting = { [P1]: 5, [P3]: 0 };
    await show(svc);
    const r = row("Zotero library user:42");
    expect(within(r).getByRole("link", { name: "Import report for “Zotero library user:42”" }).getAttribute("href")).toBe(`/import?project=${P1}&batch=${B1}`);
    // N is what the project's queue holds now (not the run's 3), and it goes to that queue.
    const review = await within(r).findByRole("link", { name: "Review 5 waiting in “Dissertation”" });
    expect(review.getAttribute("href")).toBe(`/import/review?project=${P1}`);
    expect(within(row("Zotero group 7")).getByRole("link", { name: "Review 5 waiting in “Dissertation”" })).toBeTruthy();
    // 0 waiting: no link. The status line stays the service's.
    expect(within(row("Zotero group 8")).queryByRole("link", { name: /^Review/ })).toBeNull();
    expect(within(r).getByText(svc.state.links[0]!.status)).toBeTruthy();
    // One request per linked project per reading, never per event.
    const counts = () => svc.calls.filter((c) => c.path.endsWith("/review")).map((c) => c.path);
    expect(counts().sort()).toEqual([`/projects/${P1}/review`, `/projects/${P3}/review`]);
    // The researcher decided some: after a run ends, the number is read again.
    svc.waiting = { [P1]: 2, [P3]: 0 };
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "checking" });
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "running", done: 1, total: 2 });
    expect(counts()).toHaveLength(2);
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "finished", run: last });
    expect(await within(row("Zotero library user:42")).findByRole("link", { name: "Review 2 waiting in “Dissertation”" })).toBeTruthy();
    expect(counts()).toHaveLength(4);
  });

  it("R269 N2: two libraries linked to one project: both review links are named for the project, not the library", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }, { ref: "group:7", projectId: P1 }] });
    svc.waiting = { [P1]: 4 };
    await show(svc);
    for (const name of ["Zotero library user:42", "Zotero group 7"]) {
      const link = await within(row(name)).findByRole("link", { name: "Review 4 waiting in “Dissertation”" });
      expect(link.textContent).toContain("Review 4 waiting");
    }
    expect(screen.queryByRole("link", { name: /Review 4 waiting for/ })).toBeNull();
  });

  it("R268 I1: a save's answer wins over a read that started before it arrived; one fresh read follows; Saved. once; a second Save sends the saved values", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }] });
    await show(svc);
    const user = userEvent.setup();
    const old = svc.state;
    const gate = held();
    svc.onSave = async (body) => {
      await gate.p;
      svc.state = { ...svc.state, automatic: body.automatic, everyMinutes: body.everyMinutes };
      return HttpResponse.json(svc.state);
    };
    await user.click(screen.getByRole("checkbox", { name: "Sync automatically while the app is open" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "How often" }), "240");
    const said: string[] = [];
    const mo = new MutationObserver(() => {
      const t = liveText();
      if (t) said.push(t);
    });
    mo.observe(screen.getByTestId("zotero-live"), { childList: true, subtree: true, characterData: true });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(svc.count("PUT", "/zotero/sync/settings")).toBe(1));
    // A read started now (by a "finished" event) answers with the settings from before the save.
    let oldOnce = true;
    svc.onState = () => {
      if (oldOnce) {
        oldOnce = false;
        return HttpResponse.json(old);
      }
      return HttpResponse.json(svc.state);
    };
    const reads = svc.count("GET", "/zotero/sync");
    await push(svc, "zotero.sync", { ref: "user:42", projectId: P1, state: "finished", run: run() });
    await waitFor(() => expect(svc.count("GET", "/zotero/sync")).toBe(reads + 1));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    await act(async () => {
      gate.release();
      await new Promise((r) => setTimeout(r, 100));
    });
    await waitFor(() => expect(liveText()).toBe("Saved."));
    expect((screen.getByRole("combobox", { name: "How often" }) as HTMLSelectElement).value).toBe("240");
    expect((screen.getByRole("checkbox", { name: "Sync automatically while the app is open" }) as HTMLInputElement).checked).toBe(true);
    // Exactly one fresh read after the write's answer.
    await waitFor(() => expect(svc.count("GET", "/zotero/sync")).toBe(reads + 2));
    await act(async () => new Promise((r) => setTimeout(r, 100)));
    expect(svc.count("GET", "/zotero/sync")).toBe(reads + 2);
    expect((screen.getByRole("combobox", { name: "How often" }) as HTMLSelectElement).value).toBe("240");
    mo.disconnect();
    expect(said.filter((t) => t === "Saved.")).toHaveLength(1);
    svc.onSave = undefined;
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(svc.count("PUT", "/zotero/sync/settings")).toBe(2));
    expect(JSON.parse(svc.bodies("PUT", "/zotero/sync/settings")[1]!)).toMatchObject({ automatic: true, everyMinutes: 240 });
  });

  it("R268 M1: the form is inert while a save is out; focus stays on Save; nothing edited under it is lost", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, paused: "undone" }] });
    await show(svc);
    const user = userEvent.setup();
    const gate = held();
    svc.onSave = async (body) => {
      await gate.p;
      svc.state = { ...svc.state, automatic: body.automatic, everyMinutes: body.everyMinutes };
      return HttpResponse.json(svc.state);
    };
    await user.click(screen.getByRole("checkbox", { name: "Sync automatically while the app is open" }));
    const save = screen.getByRole("button", { name: "Save" });
    await user.click(save);
    await waitFor(() => expect(svc.count("PUT", "/zotero/sync/settings")).toBe(1));
    const often = screen.getByRole("combobox", { name: "How often" }) as HTMLSelectElement;
    const auto = screen.getByRole("checkbox", { name: "Sync automatically while the app is open" }) as HTMLInputElement;
    const keep = screen.getByRole("checkbox", { name: "Keep “Zotero library user:42” in step" }) as HTMLInputElement;
    const into = screen.getByRole("combobox", { name: "Into project for “Zotero library user:42”" }) as HTMLSelectElement;
    for (const c of [often, auto, keep, into]) expect(c.disabled).toBe(true);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    const resume = screen.getByRole("button", { name: "Turn syncing on again for “Zotero library user:42”" });
    expect(resume.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(save);
    // Not operable: a change event and presses do nothing.
    fireEvent.change(often, { target: { value: "240" } });
    fireEvent.click(keep);
    fireEvent.click(resume);
    fireEvent.click(save);
    expect(svc.count("PUT", "/zotero/sync/settings")).toBe(1);
    await act(async () => {
      gate.release();
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(liveText()).toBe("Saved."));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
    expect((screen.getByRole("combobox", { name: "How often" }) as HTMLSelectElement).value).toBe("60");
    expect((screen.getByRole("checkbox", { name: "Keep “Zotero library user:42” in step" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("combobox", { name: "How often" }) as HTMLSelectElement).disabled).toBe(false);
  });

  it("R268 M2: a failed key check takes the earlier check's success sentence off the screen; the names may stay", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }] });
    await show(svc);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Check the key" }));
    expect((await screen.findByTestId("zotero-key-result")).textContent).toContain(ACCESS.summary);
    svc.onCheck = () => HttpResponse.json({ error: { code: "CONFLICT", message: ZOTERO_SYNC_REASON_TEXT["key-refused"], reason: "key-refused" } }, { status: 409 });
    await user.click(screen.getByRole("button", { name: "Check the key" }));
    await screen.findByTestId("zotero-key-error");
    expect(screen.queryByTestId("zotero-key-result")).toBeNull();
    expect(screen.queryByText(ACCESS.summary)).toBeNull();
    expect(row("My library")).toBeTruthy();
  });

  it("R268 M4: a settings file written by a newer version: the service's sentence, no control that would be refused, never 'No Zotero library is linked'", async () => {
    const svc = useSvc({ settingsNewer: true, links: [] }, [run()]);
    render(<ZoteroSync client={testClient()} />);
    expect((await screen.findByTestId("zotero-newer")).textContent).toBe(ZOTERO_SYNC_SENTENCES.settingsNewer);
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Sync history" })).getAllByRole("listitem")).toHaveLength(1));
    void svc;
    expect(screen.queryByText(/No Zotero library is linked/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Sync with Zotero now|Stop syncing)$/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Sync automatically while the app is open" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "How often" })).toBeNull();
    // The history stays readable.
    expect(within(screen.getByRole("list", { name: "Sync history" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("R268 M5: a stored link moved to another project takes that project's defaults; one that stays keeps its options", async () => {
    const svc = useSvc({
      links: [
        { ref: "user:42", projectId: P1, structure: "tags", duplicates: "skip" },
        { ref: "group:7", projectId: P1, structure: "tags", duplicates: "keep-both" },
        { ref: "group:8", projectId: P1, structure: "none", duplicates: "skip" },
      ],
    });
    await show(svc);
    const user = userEvent.setup();
    // Into a project that pseudonymises names: "none"; into an open one: "collections"; both "merge" (the wizard's).
    await user.selectOptions(screen.getByRole("combobox", { name: "Into project for “Zotero library user:42”" }), P4);
    await user.selectOptions(screen.getByRole("combobox", { name: "Into project for “Zotero group 7”" }), P3);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(svc.count("PUT", "/zotero/sync/settings")).toBe(1));
    expect(JSON.parse(svc.bodies("PUT", "/zotero/sync/settings")[0]!).links).toEqual([
      { ref: "user:42", projectId: P4, structure: "none", duplicates: "merge" },
      { ref: "group:7", projectId: P3, structure: "collections", duplicates: "merge" },
      { ref: "group:8", projectId: P1, structure: "none", duplicates: "skip" },
    ]);
    expect(svc.calls.filter((c) => c.path.endsWith("/governance")).map((c) => c.path).sort()).toEqual([`/projects/${P3}/governance`, `/projects/${P4}/governance`]);
  });

  it("R268 M5: a link whose project does not change keeps its options exactly", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P4, structure: "collections", duplicates: "keep-both" }] });
    await show(svc);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "How often" }), "30");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(svc.count("PUT", "/zotero/sync/settings")).toBe(1));
    expect(JSON.parse(svc.bodies("PUT", "/zotero/sync/settings")[0]!).links).toEqual([{ ref: "user:42", projectId: P4, structure: "collections", duplicates: "keep-both" }]);
    expect(svc.calls.filter((c) => c.path.endsWith("/governance"))).toEqual([]);
  });

  it("R268 M6: a pause this build does not know is said plainly, never shown as merely synced", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, lastRun: run() }] });
    svc.state = { ...svc.state, links: [{ ...svc.state.links[0]!, paused: "future-reason" as never, waitingFor: "paused" }] };
    await show(svc);
    const r = row("Zotero library user:42");
    expect(within(r).getByText("Syncing of this library is paused.")).toBeTruthy();
  });

  it("R268 M7: another library opened while the screen is shown: the old one is forgotten and everything read again", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }] });
    await show(svc);
    const user = userEvent.setup();
    await push(svc, "library.state", { open: true, libraryId: "lib-1", mode: "read-write" });
    await user.click(screen.getByRole("button", { name: "Check the key" }));
    await screen.findByRole("region", { name: "Lab group" });
    await user.selectOptions(screen.getByRole("combobox", { name: "How often" }), "240");
    const reads = svc.count("GET", "/zotero/sync");
    const projects = svc.count("GET", "/projects");
    svc.state = stateOf({ links: [{ ref: "group:55", projectId: P3 }], everyMinutes: 30 });
    await push(svc, "library.state", { open: true, libraryId: "lib-2", mode: "read-write" });
    await screen.findByRole("region", { name: "Zotero group 55" });
    expect(svc.count("GET", "/zotero/sync")).toBeGreaterThan(reads);
    expect(svc.count("GET", "/projects")).toBeGreaterThan(projects);
    // The names, the draft and the key check's answer of the old library are gone.
    expect(screen.queryByRole("region", { name: "Lab group" })).toBeNull();
    expect(screen.queryByRole("region", { name: "My library" })).toBeNull();
    expect(screen.queryByTestId("zotero-key-result")).toBeNull();
    expect((screen.getByRole("combobox", { name: "How often" }) as HTMLSelectElement).value).toBe("30");
  });

  it("R269 N1 a: a save still out for the old library does not lock the next library's form; its late answer changes nothing", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }] });
    await show(svc);
    const user = userEvent.setup();
    await push(svc, "library.state", { open: true, libraryId: "lib-1", mode: "read-write" });
    const gate = held();
    svc.onSave = async () => {
      await gate.p;
      return HttpResponse.json(stateOf({ links: [{ ref: "user:42", projectId: P1 }], everyMinutes: 240 }));
    };
    await user.selectOptions(screen.getByRole("combobox", { name: "How often" }), "240");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(svc.count("PUT", "/zotero/sync/settings")).toBe(1));
    expect((screen.getByRole("combobox", { name: "How often" }) as HTMLSelectElement).disabled).toBe(true);
    svc.state = stateOf({ links: [{ ref: "group:55", projectId: P3 }], everyMinutes: 30 });
    await push(svc, "library.state", { open: true, libraryId: "lib-2", mode: "read-write" });
    await screen.findByRole("region", { name: "Zotero group 55" });
    const often = screen.getByRole("combobox", { name: "How often" }) as HTMLSelectElement;
    expect(often.disabled).toBe(false);
    expect(often.value).toBe("30");
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBeNull();
    const before = document.body.innerHTML;
    await act(async () => {
      gate.release();
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(document.body.innerHTML).toBe(before);
    expect(liveText()).not.toBe("Saved.");
  });

  it.each([
    ["Save", { links: [{ ref: "user:42", projectId: P1 }] }, "Save"],
    ["Turn syncing on again", { links: [{ ref: "user:42", projectId: P1, paused: "undone" as const }] }, "Turn syncing on again for “Zotero library user:42”"],
  ])("R269 N1 b: a save (%s) with no answer in 60 s is given up: draft kept, one sentence, one read, a late answer ignored", async (_n, init, buttonName) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    const svc = useSvc(init);
    await show(svc);
    const gate = held();
    svc.onSave = async () => {
      await gate.p;
      return HttpResponse.json(stateOf({ ...init, everyMinutes: 30 }));
    };
    const often = () => screen.getByRole("combobox", { name: "How often" }) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(often(), { target: { value: "240" } });
    });
    await act(async () => screen.getByRole("button", { name: buttonName }).click());
    await waitFor(() => expect(svc.count("PUT", "/zotero/sync/settings")).toBe(1));
    expect(often().disabled).toBe(true);
    const reads = svc.count("GET", "/zotero/sync");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(often().disabled).toBe(true);
    expect(screen.queryByTestId("zotero-save-error")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    const sentence = "The service did not answer. Check the settings shown before saving again.";
    await waitFor(() => expect(screen.getByTestId("zotero-save-error").textContent).toBe(sentence));
    expect(liveText()).toBe(sentence);
    expect(often().disabled).toBe(false);
    expect(often().value).toBe("240");
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBeNull();
    await waitFor(() => expect(svc.count("GET", "/zotero/sync")).toBe(reads + 1));
    await act(async () => {
      gate.release();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(liveText()).toBe(sentence);
    expect(often().value).toBe("240");
    expect(svc.count("PUT", "/zotero/sync/settings")).toBe(1);
    expect(svc.count("GET", "/zotero/sync")).toBe(reads + 1);
  });

  it("R268 M7: after the event stream comes back, the state is read again", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }] });
    await show(svc);
    const reads = svc.count("GET", "/zotero/sync");
    const fresh = run({ counts: { ...ZERO, new: 7 } });
    svc.state = stateOf({ links: [{ ref: "user:42", projectId: P1, lastRun: fresh }] });
    await act(async () => svc.events.close());
    await waitFor(() => expect(svc.events.connections()).toBe(2), { timeout: 5000 });
    await waitFor(() => expect(svc.count("GET", "/zotero/sync")).toBe(reads + 1));
    expect(await within(row("Zotero library user:42")).findByText(zoteroSyncStatusLine(fresh, new Date()))).toBeTruthy();
  });

  it("R268 M7: the change from read-write to read-only: the controls go and the read-only sentence shows", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, lastRun: run() }] });
    await show(svc);
    await push(svc, "library.state", { open: true, libraryId: "lib-1", mode: "read-write" });
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    svc.state = { ...svc.state, readOnly: true };
    await push(svc, "library.state", { open: true, libraryId: "lib-1", mode: "read-only" });
    await screen.findByText(ZOTERO_SYNC_REASON_TEXT["library-read-only"]);
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(screen.queryAllByRole("combobox")).toEqual([]);
  });

  it("the undo's note is shown", async () => {
    const message = ZOTERO_SYNC_SENTENCES.undonePaused;
    const api = {
      report: async () => ({ ...REPORT, counts: { ...REPORT.counts } }) as ImportReport,
      undo: async () => ({ removedSources: 2, revertedMerges: 0, kept: [], zoteroSync: { paused: true, message } }),
    } as unknown as ImportApi;
    render(<StepReport api={api} projectId={P1} batchId={B1} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Undo import" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Undo import" }));
    const said = await screen.findByText(message);
    expect(said.closest("[role='status']")).toBeTruthy();
  });

  it("the screen is linked from the settings", async () => {
    server.use(
      http.get(url("/settings/appearance"), () => HttpResponse.json(DEFAULT_APPEARANCE)),
      http.get(url("/settings/researcher"), () => HttpResponse.json({ name: null })),
      ...libraryHandlers(),
      http.all(url("/*"), () => HttpResponse.json({ error: { code: "NOT_FOUND", message: "Not in this test's service." } }, { status: 404 })),
    );
    window.history.replaceState(null, "", "/");
    try {
      const view = render(<App service={{ baseUrl: BASE, token: TOKEN }} />);
      await screen.findByRole("navigation", { name: "Projects" });
      const link = await screen.findByRole("link", { name: "Zotero" });
      expect(link.getAttribute("href")).toBe(PATHS.zotero);
      expect(PATHS.zotero).toBe("/settings/zotero");
      // Following it opens this screen.
      await userEvent.setup().click(link);
      expect(await screen.findByRole("heading", { level: 1, name: "Zotero" })).toBeTruthy();
      view.unmount();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});

describe("Zotero: first reads that never settle (FR-750, R579)", () => {
  const UNREACHABLE = "The library service could not be reached.";
  /** R586 M5: said where a read was given up at the time limit (it neither answered nor failed). */
  const NO_ANSWER = "The library service did not answer in time.";
  const tryAgain = () => screen.queryByRole("button", { name: "Try again" });

  it("a read of the state that hangs is given up after the limit: the usual alert with “Try again”; pressing it reads again, and focus is not lost", async () => {
    const svc = useSvc();
    let answer = false;
    const gate = hang();
    svc.onState = async () => {
      if (!answer) await gate;
      return HttpResponse.json(svc.state);
    };
    render(<ZoteroSync client={testClient()} firstReadMs={300} />);
    expect(screen.getByText("Reading the Zotero sync settings…")).toBeTruthy();
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual([NO_ANSWER]);
    expect(document.activeElement).toBe(document.body);
    answer = true;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByTestId("zotero-libraries");
    expect(tryAgain()).toBeNull();
    expect(svc.count("GET", "/zotero/sync")).toBe(2);
    expect(document.activeElement?.isConnected && document.activeElement !== document.body).toBe(true);
  });

  it("when the event stream opens anew, a read still out from before is made again, without a press and without an event", async () => {
    const svc = useSvc();
    const ev = sseAttempts((n) => (n === 1 ? "fail" : []));
    server.use(ev.handler);
    const gate = hang();
    let n = 0;
    svc.onState = async () => {
      if (++n === 1) await gate;
      return HttpResponse.json(svc.state);
    };
    render(<ZoteroSync client={testClient()} />);
    await screen.findByTestId("zotero-libraries", undefined, { timeout: 10_000 });
    expect(ev.attempts()).toBe(2);
    expect(svc.count("GET", "/zotero/sync")).toBe(2);
    expect(tryAgain()).toBeNull();
  });

  it("FR-756 C (R597): a stream that never opens is cancelled at the limit and opened afresh after the screen's pause; at that opening a read still out is made again", async () => {
    const svc = useSvc();
    const ev = sseAttempts((n) => (n === 1 ? "hang" : []));
    server.use(ev.handler);
    const gate = hang();
    let n = 0;
    svc.onState = async () => {
      if (++n === 1) await gate;
      return HttpResponse.json(svc.state);
    };
    render(<ZoteroSync client={testClient()} streamOpenMs={300} />);
    await screen.findByTestId("zotero-libraries", undefined, { timeout: 10_000 });
    expect(ev.attempts()).toBe(2);
    expect(svc.count("GET", "/zotero/sync")).toBe(2);
    expect(tryAgain()).toBeNull();
  });

  it("FR-756 C (R597): a stream that has opened is never dropped by the limit, however long it stays quiet", async () => {
    useSvc();
    const ev = sseAttempts(() => []);
    server.use(ev.handler);
    render(<ZoteroSync client={testClient()} streamOpenMs={200} />);
    await waitFor(() => expect(ev.attempts()).toBe(1));
    await new Promise((r) => setTimeout(r, 3_000));
    expect(ev.attempts()).toBe(1);
    // R602 M2: the page has not cancelled it (a drop after the answer began would not end a mocked body).
    expect(ev.signals()[0]!.aborted).toBe(false);
  });

  it("a service that stays unreachable is asked again once per opening of the stream, never in a loop", async () => {
    const svc = useSvc();
    const ev = sseAttempts((n) => (n === 1 ? "fail" : []));
    server.use(ev.handler);
    svc.onState = () => HttpResponse.error();
    render(<ZoteroSync client={testClient()} />);
    await screen.findByRole("button", { name: "Try again" });
    await waitFor(() => expect(svc.count("GET", "/zotero/sync")).toBe(2), { timeout: 10_000 });
    await screen.findByRole("button", { name: "Try again" });
    ev.drop();
    await waitFor(() => expect(ev.attempts()).toBe(3), { timeout: 10_000 });
    await waitFor(() => expect(svc.count("GET", "/zotero/sync")).toBe(3));
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual([UNREACHABLE]);
    expect(svc.count("GET", "/zotero/sync")).toBe(3);
  });

  it("a state refused with an answer shows its sentence as today, with no “Try again”", async () => {
    const svc = useSvc();
    svc.onState = () => serviceError(500, "INTERNAL", "The Zotero sync settings could not be listed.");
    render(<ZoteroSync client={testClient()} />);
    await screen.findByText("The Zotero sync settings could not be listed.");
    expect(tryAgain()).toBeNull();
  });
});

// FR-756's remainder (R609 N4): the screen's silent side read of the projects is given up at the limit silently
// (cancelled; nothing new is shown), and cancelled when the screen is left.
describe("Zotero: the read of the projects beside the screen (FR-756 remainder)", () => {
  function heldProjects() {
    const gate = hang();
    const seen: AbortSignal[] = [];
    server.use(
      http.get(url("/projects"), async ({ request }) => {
        seen.push(request.signal);
        await gate;
        return HttpResponse.json({ projects: [] });
      }),
    );
    return seen;
  }

  it("held, it is cancelled at the limit with no alert, and the screen is shown", async () => {
    useSvc();
    const seen = heldProjects();
    render(<ZoteroSync client={testClient()} firstReadMs={300} />);
    await screen.findByTestId("zotero-libraries");
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    await waitFor(() => expect(seen.every((s) => s.aborted)).toBe(true), { timeout: 3000 });
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("held, it is cancelled when the screen is left", async () => {
    useSvc();
    const seen = heldProjects();
    const view = render(<ZoteroSync client={testClient()} firstReadMs={60_000} />);
    await screen.findByTestId("zotero-libraries");
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.some((s) => s.aborted)).toBe(false);
    view.unmount();
    await waitFor(() => expect(seen.every((s) => s.aborted)).toBe(true), { timeout: 1000 });
  });
});
