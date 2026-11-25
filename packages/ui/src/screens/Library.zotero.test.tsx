/**
 * The Library screen's Zotero lines (Task Z12): under the shown project's header, one line per Zotero library linked to
 * THAT project, in the service's own words (the state's `status`; the shared pause sentences). Read when the screen shows
 * a project and again after a `zotero.sync` event that says "finished"; never by itself otherwise, never when no library
 * is open, and never an error when the state cannot be read. Against a mocked service shaped like Z8's handler.
 */
import { ZOTERO_SYNC_REASON_TEXT, zoteroSyncStatusLine, type ZoteroSyncCounts, type ZoteroSyncRun, type ZoteroSyncStateResponse } from "@ao/shared";
import { StrictMode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { CURRENT_RW, PROJECTS, libraryHandlers, server, serviceError, testApi, url, useMockService } from "../test/service";
import { Library } from "./Library";

useMockService();

const enc = new TextEncoder();
const ZERO: ZoteroSyncCounts = { new: 0, changed: 0, unchanged: 0, waiting: 0, conflicts: 0, goneMarked: 0, failed: 0, back: 0, clearedKept: 0 };
const at = (minAgo = 5) => new Date(Date.now() - minAgo * 60_000).toISOString();
let runN = 0;
function run(o: Partial<ZoteroSyncRun> = {}): ZoteroSyncRun {
  return { id: `run-${++runN}`, ref: "user:42", projectId: "p1", trigger: "manual", startedAt: at(6), finishedAt: at(5), outcome: "finished", counts: { ...ZERO, new: 3, changed: 2 }, ...o };
}

type LinkIn = { ref: string; projectId: string; paused?: "key-refused" | "library-gone" | "undone"; lastRun?: ZoteroSyncRun; waitingFor?: "project-locked" | "paused"; status?: string };
/** The state as Z8's `stateOf` answers it: each link's line is the shared `zoteroSyncStatusLine` of its last run. */
function stateOf(links: LinkIn[], more: Partial<ZoteroSyncStateResponse> = {}): ZoteroSyncStateResponse {
  return {
    readOnly: false,
    settingsNewer: false,
    keyStored: true,
    automatic: false,
    everyMinutes: 60,
    links: links.map((l) => ({
      ref: l.ref,
      projectId: l.projectId,
      structure: "collections" as const,
      duplicates: "merge" as const,
      ...(l.paused ? { paused: l.paused } : {}),
      fullDone: true,
      status: l.status ?? zoteroSyncStatusLine(l.lastRun, new Date()),
      ...(l.lastRun ? { lastRun: l.lastRun } : {}),
      ...(l.waitingFor ? { waitingFor: l.waitingFor } : {}),
    })),
    ...more,
  };
}

/** An event stream the test writes to: `send()` delivers one event while the screen listens. */
function liveEvents() {
  let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const queued: string[] = [];
  const write = (s: string) => (ctl ? ctl.enqueue(enc.encode(s)) : queued.push(s));
  return {
    handler: http.get(url("/events"), () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
          for (const s of queued.splice(0)) c.enqueue(enc.encode(s));
        },
      });
      return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
    }),
    send: (type: string, data: unknown) => write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
  };
}
const finished = (r: ZoteroSyncRun) => ({ ref: r.ref, projectId: r.projectId, state: "finished", run: r });

/** The service: answers `GET /zotero/sync` with what `answer()` gives now, and counts the reads. */
function useService(answer: () => ZoteroSyncStateResponse | Response | Promise<ZoteroSyncStateResponse | Response>) {
  const ev = liveEvents();
  const reads: number[] = [];
  const other: string[] = [];
  server.use(
    ev.handler,
    ...libraryHandlers(),
    http.get(url("/zotero/sync"), async () => {
      reads.push(Date.now());
      const a = await answer();
      return a instanceof Response ? a : HttpResponse.json(a);
    }),
    // Anything else about Zotero would be an unhandled request (an error): the screen asks for nothing more.
  );
  ev.send("library.state", { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} });
  return { ev, reads, other };
}

async function open() {
  const view = render(<Library api={testApi()} current={CURRENT_RW as never} />);
  const nav = await screen.findByRole("navigation", { name: "Projects" });
  await within(nav).findByRole("button", { name: /Dissertation/ });
  return view;
}
const lines = () => screen.queryByTestId("zotero-lines");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Library: the Zotero lines", () => {
  it("the library shows the last sync line of each Zotero library linked to this project", async () => {
    const a = run({ ref: "user:42" });
    const b = run({ ref: "group:77", counts: { ...ZERO, new: 1 }, startedAt: at(61), finishedAt: at(60) });
    const elsewhere = run({ ref: "group:5", projectId: "p2", counts: { ...ZERO, new: 9 } });
    const svc = useService(() =>
      stateOf([
        { ref: "user:42", projectId: "p1", lastRun: a },
        { ref: "group:77", projectId: "p1", lastRun: b },
        { ref: "group:5", projectId: "p2", lastRun: elsewhere },
      ]),
    );
    void svc;
    await open();
    const box = await screen.findByTestId("zotero-lines");
    const items = [...box.querySelectorAll("p")];
    expect(items).toHaveLength(2);
    // The library is named as the Zotero screen names one it knows only by its ref; then the service's own line, exactly.
    expect(items[0]!.textContent).toBe(`Zotero library user:42: ${zoteroSyncStatusLine(a, new Date())}`);
    expect(items[1]!.textContent).toBe(`Zotero group 77: ${zoteroSyncStatusLine(b, new Date())}`);
    // Nothing of the other project's link, and the existing link is as it was (its accessible name unchanged).
    expect(box.textContent).not.toContain("group 5");
    expect(screen.getByRole("link", { name: "Zotero" }).getAttribute("href")).toBe("/settings/zotero");
    // Ordinary text in reading order: not an announcement.
    expect(box.closest("[role=status], [role=alert], [aria-live]")).toBeNull();
    expect(box.querySelector("[role=status], [role=alert], [aria-live]")).toBeNull();
  });

  it("under strict mode (mounted, cleaned up, mounted again) the lines are read once and shown (R623 Minor 5)", async () => {
    const a = run({ ref: "user:42" });
    const ev = liveEvents();
    const signals: AbortSignal[] = [];
    server.use(
      ev.handler,
      ...libraryHandlers(),
      http.get(url("/zotero/sync"), ({ request }) => {
        signals.push(request.signal);
        return HttpResponse.json(stateOf([{ ref: "user:42", projectId: "p1", lastRun: a }]));
      }),
    );
    ev.send("library.state", { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} });
    render(
      <StrictMode>
        <Library api={testApi()} current={CURRENT_RW as never} />
      </StrictMode>,
    );
    const box = await screen.findByTestId("zotero-lines");
    expect([...box.querySelectorAll("p")].map((p) => p.textContent)).toEqual([`Zotero library user:42: ${zoteroSyncStatusLine(a, new Date())}`]);
    // The read of the first mount is cancelled by its clean-up; the second mount's is the one answered.
    expect(signals.filter((s) => !s.aborted)).toHaveLength(1);
  });

  it("the other project's links show when it is chosen, and the ones of the project left are gone", async () => {
    const user = userEvent.setup();
    useService(() => stateOf([{ ref: "user:42", projectId: "p1", lastRun: run() }, { ref: "group:5", projectId: "p2", status: "Not synced yet." }]));
    await open();
    await screen.findByTestId("zotero-lines");
    await user.click(within(screen.getByRole("navigation", { name: "Projects" })).getByRole("button", { name: /Clinic interviews/ }));
    await waitFor(() => expect(screen.getByTestId("zotero-lines").textContent).toContain("Zotero group 5: Not synced yet."));
    expect(screen.getByTestId("zotero-lines").textContent).not.toContain("user:42");
  });

  it("a project with no link shows nothing about Zotero", async () => {
    const svc = useService(() => stateOf([{ ref: "group:5", projectId: "p2", status: "Not synced yet." }]));
    await open();
    await waitFor(() => expect(svc.reads.length).toBe(1));
    await delay(50);
    expect(lines()).toBeNull();
    // No heading, no empty region: only the existing link mentions Zotero.
    expect(screen.queryByRole("heading", { name: /zotero/i })).toBeNull();
    expect(document.querySelector(".ao-library__zotero")).toBeNull();
    expect(screen.getAllByText(/zotero/i).map((e) => e.tagName)).toEqual(["A"]);
  });

  it("a failed sync never reads as success", async () => {
    const failed = run({ outcome: "failed", reason: "offline", counts: undefined as never, finishedAt: at(2), startedAt: at(2) });
    const partial = run({ ref: "group:77", outcome: "finished-with-problems", counts: { ...ZERO, failed: 2 } });
    useService(() =>
      stateOf([
        { ref: "user:42", projectId: "p1", lastRun: failed },
        { ref: "group:77", projectId: "p1", lastRun: partial },
      ]),
    );
    await open();
    const box = await screen.findByTestId("zotero-lines");
    const [one, two] = [...box.querySelectorAll("p")];
    expect(one!.textContent).toContain("Could not sync with Zotero");
    expect(one!.textContent).toContain(ZOTERO_SYNC_REASON_TEXT.offline);
    expect(two!.textContent).toContain("with problems");
    // No tick, no "up to date", no colour carrying the news alone: the words say it, nothing else is drawn.
    expect(box.textContent).not.toMatch(/✓|✔|☑|up to date|nothing has changed|Last synced/iu);
    expect(box.querySelector("svg, img, [role=img]")).toBeNull();
    expect(box.querySelector("[style], [class*=ok], [class*=success]")).toBeNull();
  });

  it("R295 b: a run the project's rules refused shows the shared sentence, as a failure", async () => {
    useService(() => stateOf([{ ref: "user:42", projectId: "p1", lastRun: run({ outcome: "failed", reason: "rules-denied", counts: undefined as never }) }]));
    await open();
    const box = await screen.findByTestId("zotero-lines");
    expect(box.textContent).toContain("Could not sync with Zotero");
    expect(box.textContent).toContain("This project's rules do not allow this sync. Change them in the project's Governance settings.");
    expect(box.textContent).not.toMatch(/up to date|nothing has changed|Last synced/iu);
  });

  it("a paused link and a locked project say what the service says", async () => {
    useService(() =>
      stateOf([
        { ref: "user:1", projectId: "p1", paused: "undone", lastRun: run({ ref: "user:1" }) },
        { ref: "user:2", projectId: "p1", paused: "key-refused", lastRun: run({ ref: "user:2", outcome: "failed", reason: "key-refused", counts: undefined as never }) },
        { ref: "group:3", projectId: "p1", paused: "library-gone", status: "Not synced yet." },
        { ref: "group:4", projectId: "p1", waitingFor: "project-locked", status: "Not synced yet." },
        { ref: "group:6", projectId: "p1", waitingFor: "paused", status: "Not synced yet." },
      ]),
    );
    await open();
    const items = [...(await screen.findByTestId("zotero-lines")).querySelectorAll("p")];
    expect(items).toHaveLength(5);
    expect(items[0]!.textContent).toContain(ZOTERO_SYNC_REASON_TEXT["sync-undone"]);
    expect(items[1]!.textContent).toContain(ZOTERO_SYNC_REASON_TEXT["key-refused"]);
    expect(items[2]!.textContent).toContain(ZOTERO_SYNC_REASON_TEXT["library-gone"]);
    expect(items[3]!.textContent).toContain("Unlock the project to sync.");
    // A pause this build does not name is still a pause.
    expect(items[4]!.textContent).toContain("Syncing of this library is paused.");
    // The line of a paused link is still the service's own.
    expect(items[0]!.textContent).toContain(zoteroSyncStatusLine(run({ ref: "user:1" }), new Date()).slice(0, 25));
  });

  it("a link whose run is going shows the Zotero screen's running words", async () => {
    useService(() => stateOf([{ ref: "group:77", projectId: "p1", status: "Not synced yet." }, { ref: "user:42", projectId: "p1", status: "Not synced yet." }], { running: { ref: "group:77", done: 120, total: 400 } }));
    await open();
    const items = [...(await screen.findByTestId("zotero-lines")).querySelectorAll("p")];
    expect(items[0]!.textContent).toBe("Syncing “Zotero group 77”: 120 of 400 items");
    expect(items[1]!.textContent).toBe("Zotero library user:42: Not synced yet.");
  });

  it("a finished event makes one read; a later-started read wins; an answer for a project left is dropped", async () => {
    const user = userEvent.setup();
    let version = 0;
    const gates: Array<() => void> = [];
    const svc = useService(async () => {
      const mine = ++version;
      // The 2nd read (an event) is slow; the 3rd is quick: the later-started answer must win.
      if (mine === 2) await new Promise<void>((r) => gates.push(r));
      const text = mine === 1 ? "first" : mine === 2 ? "second (slow, started earlier)" : "third";
      return stateOf([{ ref: "user:42", projectId: "p1", status: text }, { ref: "group:5", projectId: "p2", status: `other ${mine}` }]);
    });
    await open();
    await waitFor(() => expect(lines()?.textContent).toContain("first"));
    expect(svc.reads).toHaveLength(1);

    // One finished event: exactly one read. (A run of several libraries: three events in a burst are still one read.)
    const r = run();
    for (let i = 0; i < 3; i++) svc.ev.send("zotero.sync", finished(r));
    await waitFor(() => expect(svc.reads.length).toBeGreaterThanOrEqual(2));
    await delay(60);
    expect(svc.reads).toHaveLength(2);
    // Events that are not "finished" read nothing.
    svc.ev.send("zotero.sync", { ref: "user:42", projectId: "p1", state: "checking" });
    svc.ev.send("zotero.sync", { ref: "user:42", projectId: "p1", state: "running", done: 1, total: 4 });
    await delay(60);
    expect(svc.reads).toHaveLength(2);

    // While the slow read is out, another project is chosen (a read for it starts, quick): the slow answer, for the
    // project left, is dropped when it comes; the later-started answer shows.
    await user.click(within(screen.getByRole("navigation", { name: "Projects" })).getByRole("button", { name: /Clinic interviews/ }));
    await waitFor(() => expect(svc.reads.length).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(screen.getByTestId("zotero-lines").textContent).toContain("other 3"));
    await act(async () => gates.forEach((g) => g()));
    await delay(60);
    expect(screen.getByTestId("zotero-lines").textContent).toContain("other 3");
    expect(screen.getByTestId("zotero-lines").textContent).not.toContain("second");
  });

  it("of two reads for the same project the one started later wins, whatever order they are answered in", async () => {
    let n = 0;
    const gates = new Map<number, () => void>();
    const svc = useService(async () => {
      const mine = ++n;
      if (mine === 2) await new Promise<void>((r) => gates.set(mine, r));
      return stateOf([{ ref: "user:42", projectId: "p1", status: `read ${mine}` }]);
    });
    await open();
    await waitFor(() => expect(lines()?.textContent).toContain("read 1"));
    // Read 2 starts (an event) and is slow; a second event arrives meanwhile: read 3 starts after it, answers first.
    svc.ev.send("zotero.sync", finished(run()));
    await waitFor(() => expect(n).toBe(2));
    svc.ev.send("zotero.sync", finished(run()));
    // The slow one answers last, and is older: it must not overwrite the newer answer.
    await waitFor(() => expect(n).toBeGreaterThanOrEqual(2));
    await act(async () => gates.get(2)?.());
    await waitFor(() => expect(lines()?.textContent).toContain(`read ${n}`));
    expect(lines()?.textContent).not.toContain("read 2");
  });

  it("an unreadable state leaves the screen as it was", async () => {
    const before = (view: ReturnType<typeof render>) => view.container.querySelector("main, .ao-library")?.innerHTML;
    for (const answer of [
      () => serviceError(503, "LIBRARY_OFFLINE", "The library is offline."),
      () => serviceError(500, "INTERNAL", "Something broke."),
      () => HttpResponse.json({ nonsense: true }),
      () => HttpResponse.text("not json", { status: 200 }),
    ]) {
      const svc = useService(answer as never);
      const view = await open();
      await waitFor(() => expect(svc.reads.length).toBe(1));
      await delay(60);
      expect(lines()).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(view.container.textContent).not.toContain("Something broke");
      expect(view.container.textContent).not.toContain("offline.");
      expect(before(view)).toBeTruthy();
      // The rest of the screen still works.
      await screen.findByRole("table", { name: "Sources" });
      view.unmount();
      server.resetHandlers();
    }
  });

  // R299 e (the review's M4): this test said "keeps the lines it had"; after a finished sync a line from before the run
  // could read as if the run that just ended had succeeded, so a re-read that fails then takes the lines away.
  it("R299 e: an unreadable state after a finished event takes the lines away (an older success is not left standing)", async () => {
    for (const fail of [
      () => serviceError(500, "INTERNAL", "boom"),
      () => serviceError(503, "LIBRARY_OFFLINE", "The library is offline."),
      () => HttpResponse.json({ nonsense: true }),
      () => HttpResponse.text("not json", { status: 200 }),
    ]) {
      let n = 0;
      const ok = run({ ref: "user:42" });
      const svc = useService(() => (++n === 1 ? stateOf([{ ref: "user:42", projectId: "p1", lastRun: ok }]) : (fail() as never)));
      const view = await open();
      await waitFor(() => expect(lines()?.textContent).toContain("Last synced"));
      svc.ev.send("zotero.sync", finished(run({ outcome: "failed", reason: "offline", counts: undefined as never })));
      await waitFor(() => expect(n).toBe(2));
      await waitFor(() => expect(lines()).toBeNull());
      expect(screen.queryByRole("alert")).toBeNull();
      expect(view.container.textContent).not.toMatch(/boom|offline\./u);
      // The rest of the screen still works.
      await screen.findByRole("table", { name: "Sources" });
      view.unmount();
      server.resetHandlers();
    }
  });

  it("the generation guard alone: a slow answer started before the project was left, and come back to, is dropped", async () => {
    const user = userEvent.setup();
    let n = 0;
    const gates = new Map<number, () => void>();
    const svc = useService(async () => {
      const mine = ++n;
      if (mine === 2 || mine === 4) await new Promise<void>((r) => gates.set(mine, r));
      // The read for the other project cannot be read: nothing newer is applied meanwhile, so the start order alone would not drop read 2.
      if (mine === 3) return serviceError(500, "INTERNAL", "boom");
      return stateOf([{ ref: "user:42", projectId: "p1", status: `read ${mine}` }, { ref: "group:5", projectId: "p2", status: `other ${mine}` }]);
    });
    await open();
    await waitFor(() => expect(lines()?.textContent).toContain("read 1"));
    // Read 2 (an event, for the first project) is out and slow; the other project is shown (read 3, unreadable), then the first again (read 4, slow).
    svc.ev.send("zotero.sync", finished(run()));
    await waitFor(() => expect(n).toBe(2));
    const nav = within(screen.getByRole("navigation", { name: "Projects" }));
    await user.click(nav.getByRole("button", { name: /Clinic interviews/ }));
    await waitFor(() => expect(n).toBe(3));
    await delay(30);
    await user.click(nav.getByRole("button", { name: /Dissertation/ }));
    await waitFor(() => expect(n).toBe(4));
    // Read 2 answers now: it started before the project was left, so it is not shown (it started after read 1, which the
    // start order alone would let it replace).
    await act(async () => gates.get(2)?.());
    await delay(60);
    expect(lines()?.textContent ?? "").not.toContain("read 2");
    await act(async () => gates.get(4)?.());
    await waitFor(() => expect(lines()?.textContent).toContain("read 4"));
  });

  it("nothing is requested when no library is open", async () => {
    const svc = useService(() => stateOf([{ ref: "user:42", projectId: "p1", status: "x" }]));
    // A library with no projects: no project is shown, so nothing about Zotero is asked.
    server.use(http.get(url("/projects"), () => HttpResponse.json({ projects: [] })));
    const view = render(<Library api={testApi()} current={CURRENT_RW as never} />);
    await screen.findByRole("navigation", { name: "Projects" });
    await delay(80);
    svc.ev.send("zotero.sync", finished(run()));
    await delay(80);
    expect(svc.reads).toHaveLength(0);
    expect(lines()).toBeNull();
    view.unmount();
  });

  it("after the library closes, a finished event reads nothing", async () => {
    let closed = 0;
    const svc = useService(() => stateOf([{ ref: "user:42", projectId: "p1", status: "x" }]));
    const view = render(<Library api={testApi()} current={CURRENT_RW as never} onClosed={() => closed++} />);
    await screen.findByTestId("zotero-lines");
    expect(svc.reads).toHaveLength(1);
    svc.ev.send("library.state", { open: false });
    await waitFor(() => expect(closed).toBe(1));
    svc.ev.send("zotero.sync", finished(run()));
    await delay(80);
    expect(svc.reads).toHaveLength(1);
    view.unmount();
  });
});
