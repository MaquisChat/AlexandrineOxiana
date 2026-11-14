/**
 * The Zotero screen (Task Z9) against a mocked service shaped exactly like Z8's handlers
 * (apps/library-service/src/routes/zotero-sync.ts): every request's path, method and body; the state with the
 * service's own status lines; the `zotero.sync` events; the refusals with the service's sentences. Nothing here ever
 * reaches a real host.
 */
import {
  ZOTERO_SYNC_REASON_TEXT,
  ZOTERO_SYNC_SENTENCES,
  zoteroSyncReasonText,
  zoteroSyncStatusLine,
  type ZoteroKeyCheckResponse,
  type ZoteroSyncCounts,
  type ZoteroSyncRun,
  type ZoteroSyncSettingsRequest,
  type ZoteroSyncStateResponse,
} from "@ao/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportApi, ImportReport } from "../api/import";
import { zoteroSyncApi } from "../api/zoteroSync";
import { App } from "../App";
import { PATHS } from "../navigation";
import { OPEN_GOVERNANCE, PSEUDONYMISING_GOVERNANCE, REPORT } from "../test/importService";
import { BASE, libraryHandlers, server, serviceError, testClient, TOKEN, url, useMockService } from "../test/service";
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
  return {
    handler: http.get(url("/events"), () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
        },
      });
      return new HttpResponse(body, { headers: { "content-type": "text/event-stream" } });
    }),
    open: () => ctl !== undefined,
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
      // As Z8 does: the device file takes the request, a save clears `undone` and keeps the other pauses.
      const was = svc.state.links;
      svc.state = {
        ...svc.state,
        automatic: body.automatic,
        everyMinutes: body.everyMinutes,
        links: body.links.map((l) => {
          const w = was.find((x) => x.ref === l.ref && x.projectId === l.projectId);
          const paused = w?.paused && w.paused !== "undone" ? w.paused : undefined;
          return { ...l, fullDone: w?.fullDone ?? false, status: w?.status ?? zoteroSyncStatusLine(undefined, new Date()), ...(w?.lastRun ? { lastRun: w.lastRun } : {}), ...(paused ? { paused, waitingFor: "paused" as const } : {}) };
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
    const req = { automatic: true, everyMinutes: 240 as const, links: [{ ref: "group:7", projectId: P1, structure: "tags" as const, duplicates: "skip" as const, extra: 1 }] };
    await zoteroSyncApi(testClient()).saveSettings(req);
    expect(svc.calls.map((c) => [c.method, c.path, c.contentType])).toEqual([["PUT", "/zotero/sync/settings", "application/json"]]);
    expect(JSON.parse(svc.calls[0]!.body)).toEqual({ automatic: true, everyMinutes: 240, links: [{ ref: "group:7", projectId: P1, structure: "tags", duplicates: "skip" }] });
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
    // The state has no nextRunAt yet (the scheduler is Z10): no "next sync" line.
    expect(screen.queryByText(/next sync/i)).toBeNull();
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
        { ref: "user:42", projectId: P1, structure: "collections", duplicates: "merge" },
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
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

  it("of two reads the later-started wins", async () => {
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1 }] });
    await show(svc);
    const user = userEvent.setup();
    // A read started by an event is held; a save started after it answers first; the old read's answer is then dropped.
    const gate = held();
    const old = stateOf({ links: [{ ref: "user:42", projectId: P1 }], automatic: false, everyMinutes: 60 });
    svc.onState = async () => {
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

  it("links out: the import report of the last run, and the review queue with the number waiting", async () => {
    const last = run({ batchId: B1, counts: { ...ZERO, new: 2, waiting: 3, conflicts: 1 } });
    const svc = useSvc({ links: [{ ref: "user:42", projectId: P1, lastRun: last }] });
    await show(svc);
    const r = row("Zotero library user:42");
    expect(within(r).getByRole("link", { name: "Import report for “Zotero library user:42”" }).getAttribute("href")).toBe(`/import?project=${P1}&batch=${B1}`);
    expect(within(r).getByRole("link", { name: "Review 3 waiting for “Zotero library user:42”" }).getAttribute("href")).toBe(`/import/review?project=${P1}&batch=${B1}`);
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
