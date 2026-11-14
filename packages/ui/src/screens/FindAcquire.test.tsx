/**
 * The "Find and acquire" screen, slice 1 (Task F6), against a mocked service shaped exactly like F5's handlers
 * (apps/library-service/src/routes/find.ts) and shared types (@ao/shared api/find.ts): the box, the queue and its
 * states in words, the acts and their answers, the order of reads and events, the switch and the selects, the
 * dialog (R145) and the one polite status region.
 */
import {
  FIND_LIBRARY_FILE_TEXT,
  FIND_LIBRARY_TEXT,
  FIND_REASON_TEXT,
  FIND_ROUTE_TEXT,
  FIND_STOPPED_TEXT,
  findLineRefusal,
  type FindEntryView,
  type FindPersonCandidate,
  type FindPersonWork,
  type FindQueueResponse,
  type FindScreenSettings,
  type FindWorkCandidate,
} from "@ao/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findApi } from "../api/find";
import { routeFor } from "../App";
import { PATHS } from "../navigation";
import type { LibraryWindowEvent } from "../desktopShell";
import { fakeShell, type FakeShell } from "../test/desktopShell";
import { SOURCE_FILE, server, testClient, url, useMockService } from "../test/service";
import { ACT_SAID_MS, FindAcquire, LIBRARY_CLOSE_WAIT_MS, LIBRARY_SHELL_TIMEOUT_MS, SWITCH_TIMEOUT_MS } from "./FindAcquire";

useMockService();

// The desktop shell's bridge (F16): absent (a browser) unless a test sets the stand-in (R340: the desktop app).
const fake = vi.hoisted(() => ({ shell: undefined as FakeShell | undefined }));
vi.mock("../desktopShell", async (original) => ({ ...(await original<typeof import("../desktopShell")>()), desktopShell: () => fake.shell, inDesktopShell: () => !!fake.shell }));
afterEach(() => {
  fake.shell = undefined;
});

const PID = "0190a000-0000-7000-8000-0000000000a1";
const PID_LOCKED = "0190a000-0000-7000-8000-0000000000a2";
const PID_OTHER = "0190a000-0000-7000-8000-0000000000a3";
const CID = "0190a000-0000-7000-8000-0000000000c1";
const SID = "0190a000-0000-7000-8000-0000000000s1".replace("s", "b");
const PROJECTS = {
  projects: [
    { id: PID, name: "Market study", folder: "Market study", encrypted: false, unlocked: true },
    { id: PID_LOCKED, name: "Clinic interviews", folder: "Clinic interviews", encrypted: true, unlocked: false },
    { id: PID_OTHER, name: "Archive", folder: "Archive", encrypted: false, unlocked: true },
  ],
};

let n = 0;
const eid = () => `0190a000-0000-7000-8000-${String(++n).padStart(12, "0")}`;

const cand = (o: Partial<FindWorkCandidate> & { id: string }): FindWorkCandidate => ({
  title: "Distinction",
  creators: [{ family: "Bourdieu", given: "Pierre", role: "author" }],
  issued: "1984",
  type: "book",
  identifiers: { isbn: ["9780674212770"] },
  providers: ["crossref"],
  ...o,
});

function entry(o: Partial<FindEntryView> = {}): FindEntryView {
  return {
    id: eid(),
    projectId: PID,
    typed: "Bourdieu, Distinction 1984",
    state: "looking-up",
    createdAt: `2026-11-13T10:00:${String(n).padStart(2, "0")}.000Z`,
    updatedAt: `2026-11-13T10:00:${String(n).padStart(2, "0")}.000Z`,
    attempts: 0,
    ...o,
  };
}

const queue = (entries: FindEntryView[], o: Partial<FindQueueResponse> = {}): FindQueueResponse => ({
  entries,
  checkEverything: false,
  lockedProjectsNotChecked: 0,
  readOnly: false,
  unreadableLines: 0,
  ...o,
});

const refusal = (status: number, code: string, message: string, reason?: string) => HttpResponse.json({ error: { code, message, ...(reason ? { reason } : {}) } }, { status });

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
    /** Several events in ONE chunk. */
    push(...evs: Array<{ type: string; data: unknown }>) {
      ctl!.enqueue(enc.encode(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`).join("")));
    },
  };
}

let events: ReturnType<typeof eventStream>;
/** Every request the screen made: method, path (with query) and body. */
let calls: Array<{ method: string; path: string; body: unknown }>;
let screenSettings: FindScreenSettings;
let queues: Record<string, FindQueueResponse | (() => Response | Promise<Response>)>;

function useService(o: { screen?: FindScreenSettings; queues?: typeof queues; mode?: "read-write" | "read-only" } = {}) {
  events = eventStream();
  screenSettings = o.screen ?? { checkEverything: false };
  queues = o.queues ?? { [PID]: queue([]) };
  server.use(
    events.handler,
    http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: { libraryId: "lib-1", name: "Thesis library", mode: o.mode ?? "read-write" } })),
    http.get(url("/projects"), () => HttpResponse.json(PROJECTS)),
    http.get(url("/projects/:id/collections"), ({ params }) =>
      params.id === PID ? HttpResponse.json({ collections: [{ id: CID, projectId: PID, name: "Chapter 1" }] }) : params.id === PID_LOCKED ? refusal(423, "PROJECT_LOCKED", "The project is locked.") : HttpResponse.json({ collections: [] }),
    ),
    http.get(url("/find/screen"), () => HttpResponse.json(screenSettings)),
    http.put(url("/find/screen"), async ({ request }) => {
      screenSettings = (await request.json()) as FindScreenSettings;
      return HttpResponse.json(screenSettings);
    }),
    http.get(url("/projects/:id/find"), ({ params }) => {
      const q = queues[String(params.id)];
      if (params.id === PID_LOCKED && !q) return refusal(423, "PROJECT_LOCKED", FIND_ROUTE_TEXT.locked, "locked");
      if (!q) return HttpResponse.json(queue([]));
      return typeof q === "function" ? q() : HttpResponse.json(q);
    }),
    http.get(url("/projects/:id/sources/:sid"), () => HttpResponse.json(SOURCE_FILE)),
  );
}

const onRequest = ({ request }: { request: Request }) => {
  const u = new URL(request.url);
  if (u.pathname === "/events") return;
  void request
    .clone()
    .text()
    .then((t) => calls.push({ method: request.method, path: `${u.pathname}${u.search}`, body: t ? JSON.parse(t) : undefined }));
};

beforeEach(() => {
  calls = [];
  n = 0;
  server.events.on("request:start", onRequest);
  window.history.replaceState(null, "", "/find");
});
afterEach(() => {
  server.events.removeListener("request:start", onRequest);
});

function show(search = "") {
  return render(<FindAcquire client={testClient()} loc={{ pathname: "/find", search }} />);
}

const live = () => screen.getByTestId("find-live");
const queueList = () => screen.getByRole("list", { name: "Queue" });
/** The queue's rows (a row's own lists, such as "Where to get it", are not rows). */
const rows = () => [...queueList().querySelectorAll<HTMLElement>(":scope > li")];
const row = (typed: string) => {
  const r = rows().find((li) => li.querySelector("[data-entry-text]")?.textContent === typed);
  if (!r) throw new Error(`no row for ${typed}`);
  return r;
};
const box = () => screen.getByRole("textbox", { name: "References" }) as HTMLTextAreaElement;
const reads = (pid = PID) => calls.filter((c) => c.method === "GET" && c.path === `/projects/${pid}/find`).length;

function held<T>() {
  let release!: (v: T) => void;
  const p = new Promise<T>((r) => (release = r));
  return { p, release };
}

/** Every text the status region was given, in order. */
function heard() {
  const said: string[] = [];
  const mo = new MutationObserver(() => {
    const t = live().textContent ?? "";
    if (t) said.push(t);
  });
  mo.observe(live(), { childList: true, subtree: true, characterData: true });
  return { said, stop: () => mo.disconnect() };
}

describe("FindAcquire: the page", () => {
  it("the app's route table shows it at /find, with Back to library", async () => {
    useService();
    render(routeFor({ pathname: PATHS.find, search: `?project=${PID}` }, testClient()));
    expect(await screen.findByRole("heading", { level: 1, name: "Find and acquire" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to library" }).getAttribute("href")).toBe(`/?project=${PID}`);
    expect(await screen.findByText("Nothing is in the queue yet.")).toBeTruthy();
    await waitFor(() => expect(events.open()).toBe(true));
    await within(screen.getByRole("combobox", { name: "Collection" })).findByRole("option", { name: "Chapter 1" });
  });

  it("heading, selects, box, hint, Add and switch, as the plan names them", async () => {
    useService();
    show();
    expect(await screen.findByRole("heading", { level: 1, name: "Find and acquire" })).toBeTruthy();
    const project = await screen.findByRole("combobox", { name: "Project" });
    await waitFor(() => expect((project as HTMLSelectElement).value).toBe(PID));
    const collection = screen.getByRole("combobox", { name: "Collection" });
    await within(collection).findByRole("option", { name: "Chapter 1" });
    expect(within(collection).getByRole("option", { name: "(none)" })).toBeTruthy();
    expect(box().getAttribute("aria-describedby")).toBeTruthy();
    const hint = document.getElementById(box().getAttribute("aria-describedby")!.split(" ")[0]!);
    expect(hint?.textContent).toBe("One reference per line: a title and author, or an author alone.");
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    const sw = screen.getByRole("switch", { name: "Check everything I have" });
    expect((sw as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("heading", { level: 2, name: "Queue" })).toBeTruthy();
    // No control of a later slice.
    for (const later of [/Get through my library/, /Where to get it/, /Choose the person/, /Choose works/, /Search sources/]) expect(screen.queryByRole("button", { name: later })).toBeNull();
  });

  it("states are words, never colour alone", async () => {
    const entries = [
      entry({ typed: "a looking", state: "looking-up" }),
      entry({ typed: "b choose", state: "choose", candidates: [cand({ id: "c1" }), cand({ id: "c2" }), cand({ id: "c3" })] }),
      entry({ typed: "b2 choose one", state: "choose", candidates: [cand({ id: "c1" })] }),
      entry({ typed: "c maybe", state: "maybe-duplicate", duplicateOf: SID, candidates: [cand({ id: "c1" })], chosen: "c1" }),
      entry({ typed: "d complete", state: "record-complete", sourceId: SID, candidates: [cand({ id: "c1" })], chosen: "c1", match: { method: "find-match", confidence: 0.95 } }),
      entry({ typed: "e already", state: "already", duplicateOf: SID }),
      entry({ typed: "f not found", state: "not-found" }),
      entry({ typed: "g failed", state: "failed", reason: { code: "unreachable" } }),
    ];
    useService({ queues: { [PID]: queue(entries) } });
    show();
    await waitFor(() => expect(rows()).toHaveLength(8));
    const words: Record<string, string> = {
      "a looking": "Looking it up",
      "b choose": "3 possible matches",
      "b2 choose one": "1 possible match",
      "c maybe": "Possibly already in your library",
      "d complete": "Record complete",
      "e already": "Already in your library",
      "f not found": "Not found",
      "g failed": `Could not be done: ${FIND_REASON_TEXT.unreachable}`,
    };
    for (const [typed, w] of Object.entries(words)) {
      const r = row(typed);
      expect(r.querySelector(".ao-find__state")?.textContent, typed).toBe(w);
      // Any symbol is decoration: hidden from screen readers, with the state in words beside it.
      for (const s of r.querySelectorAll(".ao-find__mark")) expect(s.getAttribute("aria-hidden")).toBe("true");
    }
    // The matched work is said beside the typed text.
    expect(row("d complete").textContent).toContain("Distinction");
    expect(row("d complete").textContent).toContain("Pierre Bourdieu");
    // The actions of each state, named with the typed text.
    expect(within(row("b choose")).getByRole("button", { name: "Choose: “b choose”" })).toBeTruthy();
    expect(within(row("c maybe")).getByRole("button", { name: "It is the same work: “c maybe”" })).toBeTruthy();
    expect(within(row("c maybe")).getByRole("button", { name: "It is a different work: “c maybe”" })).toBeTruthy();
    expect(within(row("c maybe")).getByRole("button", { name: "Open: “c maybe”" })).toBeTruthy();
    expect(within(row("d complete")).getByRole("button", { name: "Open: “d complete”" })).toBeTruthy();
    expect(within(row("e already")).getByRole("button", { name: "Open: “e already”" })).toBeTruthy();
    expect(within(row("f not found")).getByRole("button", { name: "Try again: “f not found”" })).toBeTruthy();
    expect(within(row("g failed")).getByRole("button", { name: "Try again: “g failed”" })).toBeTruthy();
    expect(within(row("a looking")).queryByRole("button", { name: /Try again/ })).toBeNull();
    for (const r of rows()) expect(within(r).getByRole("button", { name: /^Remove from the queue: “/ })).toBeTruthy();
  });

  it("typed text renders through UserText: markup is text, right-to-left keeps its direction, long lines wrap", async () => {
    const long = "x".repeat(500);
    const rtl = "مقدمة ابن خلدون";
    useService({ queues: { [PID]: queue([entry({ typed: "<b>bold</b> & <img src=x>" }), entry({ typed: rtl }), entry({ typed: long, state: "record-complete", sourceId: SID, chosen: "c1", candidates: [cand({ id: "c1", title: "t".repeat(1000) })] })]) } });
    show();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const t = row("<b>bold</b> & <img src=x>").querySelector("[data-entry-text] [dir=auto]")!;
    expect(t.getAttribute("dir")).toBe("auto");
    expect(queueList().querySelector("b, img")).toBeNull();
    expect(row(rtl).querySelector("[data-entry-text] [dir=auto]")!.getAttribute("dir")).toBe("auto");
    // The row shows it all; the button's NAME is cut at 80 characters with an ellipsis.
    expect(row(long).querySelector("[data-entry-text]")!.textContent).toBe(long);
    expect(within(row(long)).getByRole("button", { name: `Remove from the queue: “${"x".repeat(80)}…”` })).toBeTruthy();
    expect(within(row(long)).getByText("t".repeat(1000)).getAttribute("dir")).toBe("auto");
    expect(document.querySelector("main")!.className).toContain("ao-find");
  });

  it("an unknown state is shown as needing a newer version, with only Remove", async () => {
    useService({ queues: { [PID]: queue([entry({ typed: "from the future", state: "teleported" as never })]) } });
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const r = row("from the future");
    expect(r.querySelector(".ao-find__state")?.textContent).toBe("This entry needs a newer version of the app.");
    expect(within(r).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Remove from the queue: “from the future”"]);
    expect(r.textContent).not.toContain("teleported");
  });

  it("a reason is the service's sentence, never a code", async () => {
    useService({
      queues: {
        [PID]: queue([
          entry({ typed: "refused", state: "failed", reason: { code: "not-allowed", by: "rules" } }),
          entry({ typed: "legal", state: "failed", reason: { code: "no-legal-basis", by: "rules" } }),
          entry({ typed: "off", state: "failed", reason: { code: "switched-off", by: "settings" } }),
          entry({ typed: "odd", state: "failed", reason: { code: "unexpected" } }),
          entry({ typed: "budget", state: "looking-up", reason: { code: "budget" }, nextTryAt: "2026-11-14T00:00:00.000Z" }),
          entry({ typed: "later", state: "failed", reason: { code: "free_copy" as never } }),
        ]),
      },
    });
    show();
    await waitFor(() => expect(rows()).toHaveLength(6));
    expect(row("refused").querySelector(".ao-find__state")?.textContent).toBe(`Could not be done: ${FIND_REASON_TEXT["not-allowed"]}`);
    expect(row("legal").querySelector(".ao-find__state")?.textContent).toBe(`Could not be done: ${FIND_REASON_TEXT["no-legal-basis"]}`);
    expect(row("off").querySelector(".ao-find__state")?.textContent).toBe(`Could not be done: ${FIND_REASON_TEXT["switched-off"]}`);
    expect(row("odd").querySelector(".ao-find__state")?.textContent).toBe(`Could not be done: ${FIND_REASON_TEXT.unexpected}`);
    // Waiting for OpenAlex's allowance: still looking it up, with the sentence beside it, and "Try again".
    expect(row("budget").querySelector(".ao-find__state")?.textContent).toBe("Looking it up");
    expect(row("budget").textContent).toContain(FIND_REASON_TEXT.budget);
    expect(within(row("budget")).getByRole("button", { name: "Try again: “budget”" })).toBeTruthy();
    // A code this build does not know is never shown.
    expect(row("later").textContent).not.toMatch(/free_copy|not-allowed|switched-off|unexpected|budget/);
    for (const r of rows()) expect(r.textContent).not.toMatch(/not-allowed|no-legal-basis|switched-off|free_copy/);
  });

  it("stopped is said once above the queue and rows are not shown as looking up", async () => {
    useService({ queues: { [PID]: queue([entry({ typed: "one" }), entry({ typed: "two" })], { stopped: { code: "rules-unreadable", text: FIND_STOPPED_TEXT["rules-unreadable"] } }) } });
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getAllByText(FIND_STOPPED_TEXT["rules-unreadable"])).toHaveLength(1);
    // Above the queue.
    const said = screen.getByText(FIND_STOPPED_TEXT["rules-unreadable"]);
    expect(said.compareDocumentPosition(queueList()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const r of rows()) {
      expect(r.querySelector(".ao-find__state")?.textContent).not.toBe("Looking it up");
      expect(r.querySelector(".ao-find__state")?.textContent).toBe("Not being looked up now");
    }
  });

  it("unreadable lines are said once above the queue", async () => {
    useService({ queues: { [PID]: queue([entry({ typed: "one" })], { unreadableLines: 3 }) } });
    show();
    expect(await screen.findByText("3 lines of the queue could not be read and are kept.")).toBeTruthy();
    expect(screen.getAllByText(/could not be read and are kept/)).toHaveLength(1);
  });

  it("a queue that cannot be read shows the service's sentence and disables the box", async () => {
    useService({ queues: { [PID]: () => refusal(409, "CONFLICT", FIND_STOPPED_TEXT["queue-unreadable"], "queue-unreadable") } });
    show();
    expect(await screen.findByText(FIND_STOPPED_TEXT["queue-unreadable"])).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Queue" })).toBeNull();
    await waitFor(() => expect(box().disabled).toBe(true));
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(FIND_STOPPED_TEXT["queue-unreadable"])).toHaveLength(1);
  });

  it("read-only disables the box with the reason", async () => {
    useService({ mode: "read-only", queues: { [PID]: queue([entry({ typed: "kept", state: "not-found" })], { readOnly: true, stopped: { code: "read-only", text: FIND_STOPPED_TEXT["read-only"] } }) } });
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(box().disabled).toBe(true));
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    // The reason, once, and the box points at it.
    expect(screen.getAllByText(FIND_STOPPED_TEXT["read-only"])).toHaveLength(1);
    const reasonId = screen.getByText(FIND_STOPPED_TEXT["read-only"]).id;
    expect(box().getAttribute("aria-describedby")).toContain(reasonId);
    // Nothing that changes the library can be pressed.
    expect((within(row("kept")).getByRole("button", { name: "Try again: “kept”" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(row("kept")).getByRole("button", { name: "Remove from the queue: “kept”" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a locked project disables the box with the reason, once, and offers the unlock", async () => {
    useService({ queues: {} });
    show(`?project=${PID_LOCKED}`);
    expect(await screen.findByText(FIND_ROUTE_TEXT.locked)).toBeTruthy();
    await waitFor(() => expect(box().disabled).toBe(true));
    expect(screen.getAllByText(FIND_ROUTE_TEXT.locked)).toHaveLength(1);
    expect(box().getAttribute("aria-describedby")).toContain(screen.getByText(FIND_ROUTE_TEXT.locked).id);
    expect(screen.getByRole("heading", { name: /Clinic interviews is locked/ })).toBeTruthy();
  });
});

describe("FindAcquire: adding", () => {
  it("after a successful add the box is empty and focused; the status says what was added", async () => {
    useService();
    let body: unknown;
    server.use(
      http.post(url(`/projects/${PID}/find`), async ({ request }) => {
        body = await request.json();
        const added = [entry({ typed: "Bourdieu, Distinction 1984" }), entry({ typed: "Granovetter, The strength of weak ties" }), entry({ typed: "Hochschild, The Managed Heart" })];
        queues[PID] = queue(added);
        return HttpResponse.json({ added, mergedLines: 1 });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    const h = heard();
    await user.click(box());
    await user.type(box(), "Bourdieu, Distinction 1984{Enter}Granovetter, The strength of weak ties{Enter}  {Enter}Hochschild, The Managed Heart{Enter}Bourdieu, Distinction 1984");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    // Blank lines are not sent; the rest go as typed (the service trims and merges).
    expect(body).toEqual({ lines: ["Bourdieu, Distinction 1984", "Granovetter, The strength of weak ties", "Hochschild, The Managed Heart", "Bourdieu, Distinction 1984"] });
    expect(box().value).toBe("");
    expect(document.activeElement).toBe(box());
    await waitFor(() => expect(h.said.join(" | ")).toContain("Added 3 references."));
    expect(h.said.join(" | ")).toContain("1 line was the same as another and was added once.");
    h.stop();
  });

  it("Ctrl+Enter in the box sends; the collection chosen goes with it; an empty box does nothing", async () => {
    useService();
    const bodies: unknown[] = [];
    server.use(
      http.post(url(`/projects/${PID}/find`), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ added: [entry({ typed: "Weber, Economy and Society" })], mergedLines: 0 });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    // Empty, or only spaces: nothing is sent.
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.type(box(), "   {Control>}{Enter}{/Control}");
    expect(bodies).toHaveLength(0);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Collection" }), CID);
    await user.clear(box());
    await user.type(box(), "Weber, Economy and Society{Control>}{Enter}{/Control}");
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ lines: ["Weber, Economy and Society"], collectionId: CID });
    await waitFor(() => expect(live().textContent).toContain("Added 1 reference."));
  });

  it("a refused add keeps the text and shows the line's number", async () => {
    useService();
    server.use(http.post(url(`/projects/${PID}/find`), () => refusal(400, "VALIDATION", findLineRefusal(2), "line")));
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    const text = "Weber, Economy and Society\nx";
    await user.type(box(), "Weber, Economy and Society{Enter}x");
    await user.click(screen.getByRole("button", { name: "Add" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(findLineRefusal(2));
    expect(box().value).toBe(text);
    expect(rows()).toHaveLength(0);
  });

  it("a refused add after blank lines says which line of the box it is", async () => {
    useService();
    server.use(http.post(url(`/projects/${PID}/find`), () => refusal(400, "VALIDATION", findLineRefusal(2), "line")));
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    await user.type(box(), "Weber, Economy and Society{Enter}{Enter}{Enter}x");
    await user.click(screen.getByRole("button", { name: "Add" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(`${findLineRefusal(2)} Empty lines are not counted: that is line 4 in the box.`);
  });

  it("the full queue and a locked project are said in the service's words, and the text is kept", async () => {
    useService();
    server.use(http.post(url(`/projects/${PID}/find`), () => refusal(409, "CONFLICT", FIND_ROUTE_TEXT.queueFull, "queue-full")));
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    await user.type(box(), "Weber, Economy and Society");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toBe(FIND_ROUTE_TEXT.queueFull);
    expect(box().value).toBe("Weber, Economy and Society");
  });

  it("one request per press: a double press of Add sends once and the button shows it is working", async () => {
    useService();
    const answer = held<void>();
    let posts = 0;
    server.use(
      http.post(url(`/projects/${PID}/find`), async () => {
        posts++;
        await answer.p;
        const added = [entry({ typed: "Weber" })];
        queues[PID] = queue(added);
        return HttpResponse.json({ added, mergedLines: 0 });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    await user.type(box(), "Weber");
    const add = screen.getByRole("button", { name: "Add" });
    act(() => {
      add.click();
      add.click();
    });
    await waitFor(() => expect(add.getAttribute("aria-busy")).toBe("true"));
    answer.release();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(posts).toBe(1);
  });
});

describe("FindAcquire: acts and focus", () => {
  it("after Remove focus goes to the next row, the previous one, or the box", async () => {
    const a = entry({ typed: "first", state: "not-found" });
    const b = entry({ typed: "second", state: "not-found" });
    const c = entry({ typed: "third", state: "not-found" });
    useService({ queues: { [PID]: queue([a, b, c]) } });
    const removed: string[] = [];
    server.use(
      http.delete(url(`/projects/${PID}/find/:eid`), ({ params }) => {
        removed.push(String(params.eid));
        queues[PID] = queue((queues[PID] as FindQueueResponse).entries.filter((e) => e.id !== params.eid));
        return HttpResponse.json({ removed: true });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const h = heard();
    // The middle row: focus to the next row.
    await user.click(within(row("second")).getByRole("button", { name: "Remove from the queue: “second”" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(document.activeElement).toBe(row("third").querySelector("[data-entry-text]")));
    expect(h.said.join(" | ")).toContain("Removed “second” from the queue.");
    // The last row: focus to the previous one.
    await user.click(within(row("third")).getByRole("button", { name: "Remove from the queue: “third”" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(document.activeElement).toBe(row("first").querySelector("[data-entry-text]")));
    // The only row: focus to the box.
    await user.click(within(row("first")).getByRole("button", { name: "Remove from the queue: “first”" }));
    await waitFor(() => expect(rows()).toHaveLength(0));
    await waitFor(() => expect(document.activeElement).toBe(box()));
    expect(removed).toEqual([b.id, c.id, a.id]);
    h.stop();
  });

  it("Remove from the queue keeps focus on the next row, and a double press sends one request", async () => {
    const a = entry({ typed: "first", state: "not-found" });
    const b = entry({ typed: "second", state: "not-found" });
    useService({ queues: { [PID]: queue([a, b]) } });
    const answer = held<void>();
    let deletes = 0;
    server.use(
      http.delete(url(`/projects/${PID}/find/:eid`), async () => {
        deletes++;
        await answer.p;
        queues[PID] = queue([b]);
        return HttpResponse.json({ removed: true });
      }),
    );
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const rm = within(row("first")).getByRole("button", { name: "Remove from the queue: “first”" });
    rm.focus();
    act(() => {
      rm.click();
      rm.click();
    });
    await waitFor(() => expect(rm.getAttribute("aria-busy")).toBe("true"));
    expect(rm.textContent).toBe("Removing…");
    answer.release();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(document.activeElement).toBe(row("second").querySelector("[data-entry-text]")));
    expect(deletes).toBe(1);
  });

  it("Try again sends one retry and shows the service's answer; focus stays in the row when the control goes", async () => {
    const e = entry({ typed: "Merton, Social Theory", state: "not-found" });
    useService({ queues: { [PID]: queue([e]) } });
    server.use(
      http.post(url(`/projects/${PID}/find/${e.id}/retry`), () => {
        const next = { ...e, state: "looking-up" as const, updatedAt: "2026-11-13T11:00:00.000Z" };
        queues[PID] = queue([next]);
        return HttpResponse.json(next);
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const h = heard();
    await user.click(within(row("Merton, Social Theory")).getByRole("button", { name: "Try again: “Merton, Social Theory”" }));
    await waitFor(() => expect(row("Merton, Social Theory").querySelector(".ao-find__state")?.textContent).toBe("Looking it up"));
    // Its control went away: focus is on the row (its next control, else its text), never on the page.
    await waitFor(() => expect(row("Merton, Social Theory").contains(document.activeElement)).toBe(true));
    expect(h.said.join(" | ")).toContain("“Merton, Social Theory”: Looking it up.");
    h.stop();
  });

  it("the duplicate question: the same work, and a different work, each one request with the handler's body", async () => {
    const a = entry({ typed: "same one", state: "maybe-duplicate", duplicateOf: SID, candidates: [cand({ id: "c1" })], chosen: "c1" });
    const b = entry({ typed: "other one", state: "maybe-duplicate", duplicateOf: SID, candidates: [cand({ id: "c1" })], chosen: "c1" });
    useService({ queues: { [PID]: queue([a, b]) } });
    const bodies: Record<string, unknown> = {};
    server.use(
      http.post(url(`/projects/${PID}/find/:eid/duplicate`), async ({ params, request }) => {
        const body = (await request.json()) as { same: boolean };
        bodies[String(params.eid)] = body;
        const base = params.eid === a.id ? a : b;
        const next: FindEntryView = body.same ? { ...base, state: "already", updatedAt: "2026-11-13T11:00:00.000Z" } : { ...base, state: "record-complete", sourceId: SID, duplicateOf: undefined as never, updatedAt: "2026-11-13T11:00:00.000Z" };
        delete (next as { duplicateOf?: string }).duplicateOf;
        if (body.same) next.duplicateOf = SID;
        const cur = queues[PID] as FindQueueResponse;
        queues[PID] = queue(cur.entries.map((x) => (x.id === next.id ? next : x)));
        return HttpResponse.json(next);
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await user.click(within(row("same one")).getByRole("button", { name: "It is the same work: “same one”" }));
    await waitFor(() => expect(row("same one").querySelector(".ao-find__state")?.textContent).toBe("Already in your library"));
    await user.click(within(row("other one")).getByRole("button", { name: "It is a different work: “other one”" }));
    await waitFor(() => expect(row("other one").querySelector(".ao-find__state")?.textContent).toBe("Record complete"));
    expect(bodies).toEqual({ [a.id]: { same: true }, [b.id]: { same: false } });
  });

  it("Choose: the dialog, the choice sent, the row updated, focus back on the row's next control", async () => {
    const e = entry({ typed: "Bourdieu, Distinction", state: "choose", candidates: [cand({ id: "c1" }), cand({ id: "c2", title: "La distinction" })] });
    useService({ queues: { [PID]: queue([e]) } });
    let body: unknown;
    server.use(
      http.post(url(`/projects/${PID}/find/${e.id}/choose`), async ({ request }) => {
        body = await request.json();
        const next: FindEntryView = { ...e, state: "record-complete", chosen: "c2", sourceId: SID, match: { method: "find-chosen", confidence: 1 }, updatedAt: "2026-11-13T11:00:00.000Z" };
        queues[PID] = queue([next]);
        return HttpResponse.json(next);
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const choose = within(row("Bourdieu, Distinction")).getByRole("button", { name: "Choose: “Bourdieu, Distinction”" });
    await user.click(choose);
    const dialog = await screen.findByRole("dialog");
    expect(document.activeElement).toBe(within(dialog).getAllByRole("radio")[0]);
    await user.click(within(dialog).getAllByRole("radio")[1]!);
    await user.click(within(dialog).getByRole("button", { name: "Use this one" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(body).toEqual({ candidateId: "c2" });
    await waitFor(() => expect(row("Bourdieu, Distinction").querySelector(".ao-find__state")?.textContent).toBe("Record complete"));
    // The row changed state: focus on its next useful control.
    await waitFor(() => expect(document.activeElement).toBe(within(row("Bourdieu, Distinction")).getByRole("button", { name: "Open: “Bourdieu, Distinction”" })));
    await waitFor(() => expect(live().textContent).toContain("“Bourdieu, Distinction”: Record complete."));
  });

  it("Choose: None of these sends null; Cancel returns focus to Choose", async () => {
    const e = entry({ typed: "vague", state: "choose", candidates: [cand({ id: "c1" })] });
    useService({ queues: { [PID]: queue([e]) } });
    let body: unknown;
    server.use(
      http.post(url(`/projects/${PID}/find/${e.id}/choose`), async ({ request }) => {
        body = await request.json();
        const next: FindEntryView = { ...e, state: "not-found", updatedAt: "2026-11-13T11:00:00.000Z" };
        queues[PID] = queue([next]);
        return HttpResponse.json(next);
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const choose = within(row("vague")).getByRole("button", { name: "Choose: “vague”" });
    await user.click(choose);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(choose);
    await user.click(choose);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "None of these" }));
    await user.click(within(dialog).getByRole("button", { name: "Use this one" }));
    await waitFor(() => expect(row("vague").querySelector(".ao-find__state")?.textContent).toBe("Not found"));
    expect(body).toEqual({ candidateId: null });
  });

  it("Choose: a 409 shows the service's sentence in the dialog and changes nothing", async () => {
    const e = entry({ typed: "late", state: "choose", candidates: [cand({ id: "c1" })] });
    useService({ queues: { [PID]: queue([e]) } });
    server.use(http.post(url(`/projects/${PID}/find/${e.id}/choose`), () => refusal(409, "CONFLICT", FIND_ROUTE_TEXT.indexNotReady, "index-not-ready")));
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(within(row("late")).getByRole("button", { name: "Choose: “late”" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getAllByRole("radio")[0]!);
    await user.click(within(dialog).getByRole("button", { name: "Use this one" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(FIND_ROUTE_TEXT.indexNotReady);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(row("late").querySelector(".ao-find__state")?.textContent).toBe("1 possible match");
  });

  it("Open shows the record in place; closing it returns focus to Open", async () => {
    const e = entry({ typed: "done", state: "record-complete", sourceId: SID, candidates: [cand({ id: "c1" })], chosen: "c1" });
    useService({ queues: { [PID]: queue([e]) } });
    server.use(http.get(url("/projects/:id/sources/:sid/watch-origin"), () => HttpResponse.json({ origin: null })));
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const open = within(row("done")).getByRole("button", { name: "Open: “done”" });
    await user.click(open);
    const region = await screen.findByRole("region", { name: "Record" });
    await waitFor(() => expect(calls.some((c) => c.path === `/projects/${PID}/sources/${SID}`)).toBe(true));
    expect(region).toBeTruthy();
  });

  it("elsewhere: Already in your project <name>, Open it there and Add it to this project as well; null says the project is locked now", async () => {
    const a = entry({ typed: "elsewhere known", state: "already", elsewhere: true, candidates: [cand({ id: "c1" })], chosen: "c1" });
    const b = entry({ typed: "elsewhere locked", state: "already", elsewhere: true, candidates: [cand({ id: "c1" })], chosen: "c1" });
    useService({ queues: { [PID]: queue([a, b]) } });
    let addHere = 0;
    server.use(
      http.get(url(`/projects/${PID}/find/:eid/elsewhere`), ({ params }) => (params.eid === a.id ? HttpResponse.json({ projectId: PID_OTHER, projectName: "Archive <i>2</i>", sourceId: SID }) : HttpResponse.json(null))),
      http.post(url(`/projects/${PID}/find/${a.id}/add-here`), () => {
        addHere++;
        const next: FindEntryView = { ...a, state: "record-complete", sourceId: SID, updatedAt: "2026-11-13T11:00:00.000Z" };
        delete next.elsewhere;
        queues[PID] = queue([next, b]);
        return HttpResponse.json(next);
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(row("elsewhere known").querySelector(".ao-find__state")?.textContent).toBe("Already in your project Archive <i>2</i>"));
    expect(row("elsewhere known").querySelector("i")).toBeNull();
    expect(within(row("elsewhere known")).getByRole("button", { name: "Open it there: “elsewhere known”" })).toBeTruthy();
    await waitFor(() => expect(row("elsewhere locked").querySelector(".ao-find__state")?.textContent).toBe("Already in another project that is locked now."));
    expect(within(row("elsewhere locked")).queryByRole("button", { name: /Open it there/ })).toBeNull();
    await user.click(within(row("elsewhere known")).getByRole("button", { name: "Add it to this project as well: “elsewhere known”" }));
    await waitFor(() => expect(row("elsewhere known").querySelector(".ao-find__state")?.textContent).toBe("Record complete"));
    expect(addHere).toBe(1);
    // Where it is was asked for by id only, with no body.
    const asked = calls.filter((c) => c.path.endsWith("/elsewhere"));
    expect(asked.every((c) => c.method === "GET" && c.body === undefined)).toBe(true);
  });

  it("a row's change of state is said once in the polite region, not every event of a burst", async () => {
    const e = entry({ typed: "Bourdieu, Distinction 1984", state: "looking-up" });
    useService({ queues: { [PID]: queue([e]) } });
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(events.open()).toBe(true));
    const h = heard();
    queues[PID] = queue([{ ...e, state: "record-complete", sourceId: SID, updatedAt: "2026-11-13T11:00:00.000Z" }]);
    events.push(...Array.from({ length: 5 }, () => ({ type: "find.progress", data: { projectId: PID, entryId: e.id, state: "record-complete" } })));
    await waitFor(() => expect(row("Bourdieu, Distinction 1984").querySelector(".ao-find__state")?.textContent).toBe("Record complete"));
    await new Promise((r) => setTimeout(r, 100));
    expect(h.said.filter((s) => s === "“Bourdieu, Distinction 1984”: Record complete.")).toHaveLength(1);
    expect(screen.getAllByRole("status").filter((s) => s.getAttribute("aria-live") === "polite")).toHaveLength(1);
    h.stop();
  });
});

describe("FindAcquire: the order of reads and events", () => {
  it("a burst of fifty progress events makes at most two reads", async () => {
    const e = entry({ typed: "one" });
    useService({ queues: { [PID]: queue([e]) } });
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(events.open()).toBe(true));
    const before = reads();
    events.push(...Array.from({ length: 50 }, (_, i) => ({ type: "find.progress", data: { projectId: PID, entryId: e.id, state: i % 2 ? "looking-up" : "choose" } })));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await new Promise((r) => setTimeout(r, 300));
    expect(reads() - before).toBeGreaterThanOrEqual(1);
    expect(reads() - before).toBeLessThanOrEqual(2);
    // Events of another project, or of another shape, read nothing.
    const now = reads();
    events.push({ type: "find.progress", data: { projectId: PID_OTHER, entryId: e.id, state: "choose" } }, { type: "find.progress", data: { projectId: PID, entryId: e.id, state: "choose", typed: "x" } }, { type: "find.progress", data: "junk" });
    await new Promise((r) => setTimeout(r, 200));
    expect(reads()).toBe(now);
  });

  it("of two reads the later-started wins, whatever order they answer in", async () => {
    const e = entry({ typed: "racing", state: "looking-up" });
    const first = held<void>();
    let k = 0;
    useService({
      queues: {
        [PID]: async () => {
          const mine = ++k;
          if (mine === 1) {
            await first.p;
            return HttpResponse.json(queue([e]));
          }
          return HttpResponse.json(queue([{ ...e, state: "record-complete", sourceId: SID, updatedAt: "2026-11-13T11:00:00.000Z" }], { checkEverything: true }));
        },
      },
    });
    const user = userEvent.setup();
    show();
    // The first read is held; the switch's PUT starts a second read, which answers first.
    const sw = await screen.findByRole("switch", { name: "Check everything I have" });
    await waitFor(() => expect(k).toBe(1));
    await user.click(sw);
    await waitFor(() => expect(k).toBe(2));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(row("racing").querySelector(".ao-find__state")?.textContent).toBe("Record complete");
    first.release();
    await new Promise((r) => setTimeout(r, 100));
    expect(row("racing").querySelector(".ao-find__state")?.textContent).toBe("Record complete");
  });

  it("changing the project drops the old rows and a late answer", async () => {
    const late = held<void>();
    let firstRead = true;
    useService({
      queues: {
        [PID]: async () => {
          if (firstRead) {
            firstRead = false;
            return HttpResponse.json(queue([entry({ typed: "market row" })]));
          }
          await late.p;
          return HttpResponse.json(queue([entry({ typed: "late market row" })]));
        },
        [PID_OTHER]: queue([entry({ typed: "archive row", projectId: PID_OTHER })]),
      },
    });
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(events.open()).toBe(true));
    // An event starts a read of the old project that is still out when the project changes.
    events.push({ type: "find.progress", data: { projectId: PID, entryId: eid(), state: "choose" } });
    await waitFor(() => expect(reads(PID)).toBe(2));
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), PID_OTHER);
    await waitFor(() => expect(screen.queryByText("market row")).toBeNull());
    await waitFor(() => expect(rows().map((r) => r.querySelector("[data-entry-text]")?.textContent)).toEqual(["archive row"]));
    late.release();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByText("late market row")).toBeNull();
    expect(rows().map((r) => r.querySelector("[data-entry-text]")?.textContent)).toEqual(["archive row"]);
    // The choice is remembered on this computer (no collection: the old one was the other project's).
    await waitFor(() => expect(screenSettings).toEqual({ checkEverything: false, projectId: PID_OTHER }));
    // The collection select lists the new project's collections.
    const collection = screen.getByRole("combobox", { name: "Collection" });
    await waitFor(() => expect(within(collection).getAllByRole("option").map((o) => o.textContent)).toEqual(["(none)"]));
  });
});

describe("FindAcquire: the switch and the remembered choices", () => {
  it("the switch is remembered and the locked count is said", async () => {
    useService({ screen: { checkEverything: false, projectId: PID } });
    const user = userEvent.setup();
    show();
    const sw = (await screen.findByRole("switch", { name: "Check everything I have" })) as HTMLInputElement;
    await waitFor(() => expect(rows).not.toThrow());
    expect(sw.checked).toBe(false);
    expect(screen.queryByText(/locked projects? (were|was) not checked/)).toBeNull();
    queues[PID] = queue([], { checkEverything: true, lockedProjectsNotChecked: 2 });
    await user.click(sw);
    await waitFor(() => expect(screenSettings).toEqual({ checkEverything: true, projectId: PID }));
    expect(await screen.findByText("2 locked projects were not checked")).toBeTruthy();
    expect(sw.checked).toBe(true);
    // The singular.
    queues[PID] = queue([], { checkEverything: true, lockedProjectsNotChecked: 1 });
    await user.click(sw);
    await waitFor(() => expect(screenSettings.checkEverything).toBe(false));
    await waitFor(() => expect(sw.checked).toBe(false));
    await user.click(sw);
    await waitFor(() => expect(screenSettings.checkEverything).toBe(true));
    expect(await screen.findByText("1 locked project was not checked")).toBeTruthy();
  });

  it("the switch starts as the service stores it", async () => {
    useService({ screen: { checkEverything: true }, queues: { [PID]: queue([], { checkEverything: true, lockedProjectsNotChecked: 1 }) } });
    show();
    const sw = (await screen.findByRole("switch", { name: "Check everything I have" })) as HTMLInputElement;
    await waitFor(() => expect(sw.checked).toBe(true));
    expect(await screen.findByText("1 locked project was not checked")).toBeTruthy();
  });

  it("the switch goes back when its PUT fails, and says why", async () => {
    useService();
    server.use(http.put(url("/find/screen"), () => refusal(400, "VALIDATION", '"checkEverything" must be true or false.')));
    const user = userEvent.setup();
    show();
    const sw = (await screen.findByRole("switch", { name: "Check everything I have" })) as HTMLInputElement;
    await waitFor(() => expect(rows).not.toThrow());
    await user.click(sw);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain('"checkEverything" must be true or false.');
    expect(sw.checked).toBe(false);
  });

  it("the remembered project and collection are used; a remembered project the library does not hold is not", async () => {
    useService({ screen: { checkEverything: false, projectId: PID, collectionId: CID } });
    show();
    const collection = (await screen.findByRole("combobox", { name: "Collection" })) as HTMLSelectElement;
    await waitFor(() => expect(collection.value).toBe(CID));
  });

  it("a stale remembered project falls back to the first unlocked one", async () => {
    useService({ screen: { checkEverything: false, projectId: "0190a000-0000-7000-8000-0000000000ff" } });
    show();
    const project = (await screen.findByRole("combobox", { name: "Project" })) as HTMLSelectElement;
    await waitFor(() => expect(project.value).toBe(PID));
  });
});

describe("FindAcquire: what was typed stays in request bodies", () => {
  it("typed text is only in a request body: not in the address, the title or the console", async () => {
    const SECRET = "Zorblatt Quillfeather, Vexmoor";
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const titleBefore = document.title;
    useService();
    const choiceEntry = () => entry({ typed: SECRET, state: "choose", candidates: [cand({ id: "c1", title: SECRET })] });
    let added: FindEntryView | undefined;
    server.use(
      http.post(url(`/projects/${PID}/find`), async ({ request }) => {
        const b = (await request.json()) as { lines: string[] };
        if (b.lines.length > 1) return refusal(400, "VALIDATION", findLineRefusal(2), "line");
        added = choiceEntry();
        queues[PID] = queue([added]);
        return HttpResponse.json({ added: [added], mergedLines: 0 });
      }),
      http.post(url(`/projects/${PID}/find/:eid/choose`), () => refusal(409, "CONFLICT", FIND_ROUTE_TEXT.entryState, "entry-state")),
      http.delete(url(`/projects/${PID}/find/:eid`), () => {
        queues[PID] = queue([]);
        return HttpResponse.json({ removed: true });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    await user.type(box(), `${SECRET}{Enter}x`);
    await user.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByRole("alert");
    await user.clear(box());
    await user.type(box(), SECRET);
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(within(rows()[0]!).getByRole("button", { name: /^Choose: / }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getAllByRole("radio")[0]!);
    await user.click(within(dialog).getByRole("button", { name: "Use this one" }));
    await within(dialog).findByRole("alert");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(rows()[0]!).getByRole("button", { name: /^Remove from the queue: / }));
    await waitFor(() => expect(rows()).toHaveLength(0));
    // In a body, and nowhere else.
    const words = ["Zorblatt", "Quillfeather", "Vexmoor"];
    expect(calls.some((c) => c.method === "POST" && JSON.stringify(c.body).includes("Zorblatt"))).toBe(true);
    for (const c of calls) for (const w of words) expect(c.path, c.path).not.toContain(w);
    for (const w of words) {
      expect(window.location.href).not.toContain(w);
      expect(document.title).not.toContain(w);
      for (const s of spies) for (const args of s.mock.calls) expect(JSON.stringify(args)).not.toContain(w);
    }
    expect(document.title).toBe(titleBefore);
    for (const s of spies) s.mockRestore();
  });
});

describe("FindAcquire: a 500-entry queue", () => {
  it("renders 500 entries of 10 candidates each, and an update of one row keeps the rest", async () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      entry({ typed: `Reference number ${i}`, state: "choose", candidates: Array.from({ length: 10 }, (_, j) => cand({ id: `c${j}`, title: `Candidate ${j} of ${i}` })) }),
    );
    useService({ queues: { [PID]: queue(many) } });
    show();
    await waitFor(() => expect(queueList().getAttribute("data-count")).toBe("500"), { timeout: 20_000 });
    await waitFor(() => expect(events.open()).toBe(true));
    const target = many[250]!;
    const others = queueList().querySelectorAll("li").length;
    queues[PID] = queue(many.map((e) => (e.id === target.id ? { ...e, state: "not-found", updatedAt: "2026-11-13T11:00:00.000Z" } : e)));
    events.push({ type: "find.progress", data: { projectId: PID, entryId: target.id, state: "not-found" } });
    await waitFor(() => expect(document.querySelector(`[data-entry-id="${target.id}"] .ao-find__state`)?.textContent ?? "Not found").toBe("Not found"), { timeout: 20_000 });
    expect(queueList().querySelectorAll("li").length).toBe(others);
  }, 60_000);
});

describe("FindAcquire: round 3 (R258)", () => {
  const PID_NEW = "0190a000-0000-7000-8000-0000000000a9";
  const libState = (libraryId: string, mode = "read-write") => ({ type: "library.state", data: { open: true, libraryId, name: "L", mode } });
  const optionTexts = () => within(screen.getByRole("combobox", { name: "Project" })).getAllByRole("option").map((o) => o.textContent);
  const rowTexts = () => rows().map((r) => r.querySelector("[data-entry-text]")?.textContent);

  it("I1: another library opened while shown: nothing of the old one stays — rows, projects, dialog — and the new one is read", async () => {
    const old = entry({ typed: "old row", state: "choose", candidates: [cand({ id: "c1" })] });
    useService({ queues: { [PID]: queue([old]) } });
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rowTexts()).toEqual(["old row"]));
    await waitFor(() => expect(events.open()).toBe(true));
    events.push(libState("lib-1"));
    await user.click(within(row("old row")).getByRole("button", { name: "Choose: “old row”" }));
    await screen.findByRole("dialog");
    // The service now holds another library.
    server.use(
      http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: PID_NEW, name: "Grant 2025", folder: "Grant 2025", encrypted: false, unlocked: true }] })),
      http.get(url(`/projects/${PID}/find`), () => refusal(404, "NOT_FOUND", "That project was not found.")),
    );
    queues[PID_NEW] = queue([entry({ typed: "new row", projectId: PID_NEW })]);
    screenSettings = { checkEverything: false };
    events.push(libState("lib-2"));
    await waitFor(() => expect(rowTexts()).toEqual(["new row"]));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(optionTexts()).toEqual(["Grant 2025"]);
    expect(screen.queryByText("old row")).toBeNull();
    expect(screen.queryByText("That project was not found.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("M8: the project list is read again when the service says a project changed (an unlock)", async () => {
    useService();
    show();
    await waitFor(() => expect(optionTexts()).toContain("Clinic interviews (locked)"));
    await waitFor(() => expect(events.open()).toBe(true));
    events.push(libState("lib-1"));
    server.use(http.get(url("/projects"), () => HttpResponse.json({ projects: PROJECTS.projects.map((p) => ({ ...p, unlocked: true })) })));
    events.push(libState("lib-1"));
    await waitFor(() => expect(optionTexts()).toContain("Clinic interviews"));
    expect(optionTexts()).not.toContain("Clinic interviews (locked)");
  });

  for (const outcome of ["success", "refusal"] as const) {
    it(`I2: nothing typed is lost — the box is read-only while an add is out (${outcome})`, async () => {
      useService();
      const answer = held<void>();
      server.use(
        http.post(url(`/projects/${PID}/find`), async () => {
          await answer.p;
          if (outcome === "refusal") return refusal(409, "CONFLICT", FIND_ROUTE_TEXT.queueFull, "queue-full");
          const added = [entry({ typed: "first line" })];
          queues[PID] = queue(added);
          return HttpResponse.json({ added, mergedLines: 0 });
        }),
      );
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(box().disabled).toBe(false));
      await user.type(box(), "first line{Control>}{Enter}{/Control}");
      await waitFor(() => expect(box().readOnly).toBe(true));
      expect(box().getAttribute("aria-busy")).toBe("true");
      expect(box().disabled).toBe(false);
      expect(document.activeElement).toBe(box());
      await user.type(box(), "{Enter}second line typed while sending");
      expect(box().value).toBe("first line");
      answer.release();
      await waitFor(() => expect(box().readOnly).toBe(false));
      expect(document.activeElement).toBe(box());
      expect(box().value).toBe(outcome === "success" ? "" : "first line");
      expect(box().getAttribute("aria-busy")).toBeNull();
    });
  }

  it("M1: an act's answer older than a read started after the act was sent never undoes it, and nothing older is said", async () => {
    const e = entry({ typed: "Merton", state: "not-found" });
    useService({ queues: { [PID]: queue([e]) } });
    const answer = held<void>();
    server.use(
      http.post(url(`/projects/${PID}/find/${e.id}/retry`), async () => {
        await answer.p;
        return HttpResponse.json({ ...e, state: "looking-up", updatedAt: "2026-11-13T11:00:00.000Z" });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(events.open()).toBe(true));
    const h = heard();
    await user.click(within(row("Merton")).getByRole("button", { name: "Try again: “Merton”" }));
    // The runner moved on meanwhile; a read started after the press shows it.
    queues[PID] = queue([{ ...e, state: "record-complete", sourceId: SID, updatedAt: "2026-11-13T11:00:05.000Z" }]);
    const before = reads();
    events.push({ type: "find.progress", data: { projectId: PID, entryId: e.id, state: "record-complete" } });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await waitFor(() => expect(row("Merton").querySelector(".ao-find__state")?.textContent).toBe("Record complete"));
    answer.release();
    await new Promise((r) => setTimeout(r, 700));
    expect(row("Merton").querySelector(".ao-find__state")?.textContent).toBe("Record complete");
    expect(h.said.some((s) => s.includes("Looking it up"))).toBe(false);
    h.stop();
  });

  it("M2: remembered settings go one PUT at a time from the last confirmed answer; a failed switch and a successful project agree with the service", async () => {
    useService();
    const switchAnswer = held<void>();
    const puts: FindScreenSettings[] = [];
    server.use(
      http.put(url("/find/screen"), async ({ request }) => {
        const b = (await request.json()) as FindScreenSettings;
        puts.push(b);
        if (b.checkEverything) {
          await switchAnswer.p;
          return refusal(503, "UNAVAILABLE", "This computer's settings could not be written.");
        }
        screenSettings = b;
        return HttpResponse.json(b);
      }),
    );
    const user = userEvent.setup();
    show();
    const sw = (await screen.findByRole("switch", { name: "Check everything I have" })) as HTMLInputElement;
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement).value).toBe(PID));
    await user.click(sw);
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), PID_OTHER);
    // The project's PUT waits for the switch's.
    expect(puts).toHaveLength(1);
    switchAnswer.release();
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({ checkEverything: false, projectId: PID_OTHER });
    await waitFor(() => expect(sw.checked).toBe(false));
    expect(screenSettings.checkEverything).toBe(false);
    expect((await screen.findAllByRole("alert")).some((a) => a.textContent?.includes("This computer's settings could not be written."))).toBe(true);
  });

  it("M3: when the remembered settings cannot be read, the switch shows what the queue says is stored, and the sentence is said once", async () => {
    useService({ queues: { [PID]: queue([], { checkEverything: true, lockedProjectsNotChecked: 1 }) } });
    server.use(http.get(url("/find/screen"), () => refusal(503, "UNAVAILABLE", "This computer's Find and acquire settings could not be read.")));
    show();
    const sw = (await screen.findByRole("switch", { name: "Check everything I have" })) as HTMLInputElement;
    await waitFor(() => expect(sw.checked).toBe(true));
    expect(await screen.findByText("1 locked project was not checked")).toBeTruthy();
    expect(screen.getAllByText("This computer's Find and acquire settings could not be read.")).toHaveLength(1);
  });

  it("M4: an unreachable library folder is said in the service's words", async () => {
    useService({ queues: { [PID]: () => HttpResponse.json({ error: { code: "LIBRARY_OFFLINE", message: "The library's folder is not reachable.", reason: "offline" } }, { status: 503 }) } });
    show();
    expect(await screen.findByText("The library's folder is not reachable.")).toBeTruthy();
    expect(screen.queryByText(/No library is open/)).toBeNull();
    await waitFor(() => expect(box().disabled).toBe(true));
  });

  it("M5: only possibly a duplicate elsewhere, in a project locked now; a choice with nothing to choose", async () => {
    const a = entry({ typed: "maybe there", state: "maybe-duplicate", elsewhere: true, candidates: [cand({ id: "c1" })], chosen: "c1" });
    const b = entry({ typed: "nothing offered", state: "choose", candidates: [] });
    useService({ queues: { [PID]: queue([a, b]) } });
    server.use(http.get(url(`/projects/${PID}/find/:eid/elsewhere`), () => HttpResponse.json(null)));
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(row("maybe there").querySelector(".ao-find__state")?.textContent).toBe("Possibly already in another project that is locked now."));
    expect(row("nothing offered").querySelector(".ao-find__state")?.textContent).toBe("No possible matches.");
    expect(within(row("nothing offered")).getAllByRole("button").map((x) => x.getAttribute("aria-label"))).toEqual(["Remove from the queue: “nothing offered”"]);
  });

  it("M6: an entry whose typed text is not text is shown as needing a newer version; the screen stays", async () => {
    const bad = entry({ state: "record-complete" });
    delete (bad as { typed?: string }).typed;
    useService({ queues: { [PID]: queue([bad, entry({ typed: "fine" })]) } });
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByRole("heading", { level: 1, name: "Find and acquire" })).toBeTruthy();
    const r = rows().find((li) => li.getAttribute("data-entry-id") === bad.id)!;
    expect(r.querySelector(".ao-find__state")?.textContent).toBe("This entry needs a newer version of the app.");
    expect(within(r).getAllByRole("button").map((x) => x.getAttribute("aria-label"))).toEqual(["Remove from the queue"]);
    expect(row("fine").querySelector(".ao-find__state")?.textContent).toBe("Looking it up");
  });

  it("M7: while events keep coming, reads are at least 400 ms apart; the last event is followed by a read", async () => {
    const e = entry({ typed: "busy one" });
    useService({ queues: { [PID]: queue([e]) } });
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(events.open()).toBe(true));
    const before = reads();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      for (let i = 0; i < 50; i++) {
        if (i === 49) queues[PID] = queue([{ ...e, state: "not-found", updatedAt: "2026-11-13T12:00:00.000Z" }]);
        events.push({ type: "find.progress", data: { projectId: PID, entryId: e.id, state: "looking-up" } });
        await vi.advanceTimersByTimeAsync(30);
      }
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(row("busy one").querySelector(".ao-find__state")?.textContent).toBe("Not found"));
    const made = reads() - before;
    expect(made).toBeGreaterThanOrEqual(2);
    expect(made).toBeLessThanOrEqual(6);
  });
});

describe("FindAcquire: round 4 (R262)", () => {
  const libState = (libraryId: string) => ({ type: "library.state", data: { open: true, libraryId, name: "L", mode: "read-write" } });
  const rowTexts = () => rows().map((r) => r.querySelector("[data-entry-text]")?.textContent);
  const stateOf = (typed: string) => row(typed).querySelector(".ao-find__state")?.textContent;

  it("N1 (A2): after Try again, a read that started while the act was out and answers late does not put back the old state, and the status never says it", async () => {
    // Order: the retry's answer is held; Try again is pressed; a read starts while the act is out (the service handles
    // it first, so it sees the old entry) and is held; the act's answer arrives; then the older read's answer arrives.
    const e = entry({ typed: "Merton", state: "not-found", updatedAt: "2026-11-13T10:00:00.000Z" });
    let hold: ReturnType<typeof held<void>> | undefined;
    /** What the service stores: as the real retry does, the entry is written "looking-up" before the act is answered. */
    let stored: FindEntryView = e;
    useService({
      queues: {
        [PID]: async () => {
          if (hold) {
            const h = hold;
            hold = undefined;
            await h.p;
            return HttpResponse.json(queue([e])); // read the queue before the retry was applied
          }
          return HttpResponse.json(queue([stored]));
        },
      },
    });
    const answer = held<void>();
    server.use(
      http.post(url(`/projects/${PID}/find/${e.id}/retry`), async () => {
        await answer.p;
        stored = { ...e, state: "looking-up", updatedAt: "2026-11-13T10:05:00.000Z" };
        return HttpResponse.json(stored);
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(events.open()).toBe(true));
    const h = heard();
    await user.click(within(row("Merton")).getByRole("button", { name: "Try again: “Merton”" }));
    const stale = held<void>();
    hold = stale;
    const before = reads();
    events.push({ type: "find.progress", data: { projectId: PID, entryId: e.id, state: "not-found" } });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    answer.release();
    await waitFor(() => expect(stateOf("Merton")).toBe("Looking it up"));
    stale.release();
    await new Promise((r) => setTimeout(r, 300));
    expect(stateOf("Merton")).toBe("Looking it up");
    expect(h.said.some((s) => s.includes("Not found"))).toBe(false);
    h.stop();
  });

  it("N1 (A3): rows just added do not vanish when a read that started before the add's answer arrives", async () => {
    let hold: ReturnType<typeof held<void>> | undefined;
    let stored: FindEntryView[] = [];
    useService({
      queues: {
        [PID]: async () => {
          if (hold) {
            const h = hold;
            hold = undefined;
            await h.p;
            return HttpResponse.json(queue([])); // read before the add was written
          }
          return HttpResponse.json(queue(stored));
        },
      },
    });
    const addAnswer = held<void>();
    server.use(
      http.post(url(`/projects/${PID}/find`), async () => {
        await addAnswer.p;
        stored = [entry({ typed: "one added" }), entry({ typed: "two added" })];
        return HttpResponse.json({ added: stored, mergedLines: 0 });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    await waitFor(() => expect(events.open()).toBe(true));
    await user.type(box(), "one added{Enter}two added{Control>}{Enter}{/Control}");
    const stale = held<void>();
    hold = stale;
    const before = reads();
    events.push({ type: "find.progress", data: { projectId: PID, entryId: eid(), state: "looking-up" } });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    addAnswer.release();
    await waitFor(() => expect(rows()).toHaveLength(2));
    // From now on the rows never vanish, not even for a moment.
    const counts: number[] = [];
    const mo = new MutationObserver(() => counts.push(rows().length));
    mo.observe(queueList(), { childList: true, subtree: true });
    stale.release();
    await new Promise((r) => setTimeout(r, 300));
    mo.disconnect();
    expect(rowTexts()).toEqual(["one added", "two added"]);
    expect(counts.every((c) => c === 2)).toBe(true);
  });

  it("N1: of two reads with equal stamps, the later-started wins whatever order they answer in", async () => {
    const e = entry({ typed: "same stamp", state: "looking-up", updatedAt: "2026-11-13T10:00:00.000Z" });
    const first = held<void>();
    let k = 0;
    useService({
      queues: {
        [PID]: async () => {
          const mine = ++k;
          if (mine === 1) {
            await first.p;
            return HttpResponse.json(queue([{ ...e, state: "choose", candidates: [cand({ id: "c1" })] }]));
          }
          return HttpResponse.json(queue([e]));
        },
      },
    });
    const user = userEvent.setup();
    show();
    const sw = await screen.findByRole("switch", { name: "Check everything I have" });
    await waitFor(() => expect(k).toBe(1));
    await user.click(sw);
    await waitFor(() => expect(rows()).toHaveLength(1));
    first.release();
    await new Promise((r) => setTimeout(r, 150));
    expect(stateOf("same stamp")).toBe("Looking it up");
  });

  it("N1: a removed row is not brought back by a stale read", async () => {
    const a = entry({ typed: "gone one", state: "not-found" });
    const b = entry({ typed: "kept one", state: "not-found" });
    let hold: ReturnType<typeof held<void>> | undefined;
    useService({
      queues: {
        [PID]: async () => {
          if (hold) {
            const h = hold;
            hold = undefined;
            await h.p;
            return HttpResponse.json(queue([a, b]));
          }
          return HttpResponse.json(queue([b]));
        },
      },
    });
    server.use(http.delete(url(`/projects/${PID}/find/:eid`), () => HttpResponse.json({ removed: true })));
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    // The first load showed only b; put a back by a fresh read that holds a and b, then remove a while a stale read is out.
    queues[PID] = queue([a, b]);
    await waitFor(() => expect(events.open()).toBe(true));
    events.push({ type: "find.progress", data: { projectId: PID, entryId: a.id, state: "not-found" } });
    await waitFor(() => expect(rows()).toHaveLength(2));
    queues[PID] = async () => {
      if (hold) {
        const h = hold;
        hold = undefined;
        await h.p;
        return HttpResponse.json(queue([a, b]));
      }
      return HttpResponse.json(queue([b]));
    };
    const stale = held<void>();
    hold = stale;
    const before = reads();
    events.push({ type: "find.progress", data: { projectId: PID, entryId: a.id, state: "not-found" } });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await user.click(within(row("gone one")).getByRole("button", { name: "Remove from the queue: “gone one”" }));
    await waitFor(() => expect(rowTexts()).toEqual(["kept one"]));
    stale.release();
    await new Promise((r) => setTimeout(r, 300));
    expect(rowTexts()).toEqual(["kept one"]);
  });

  it("N2: a refused change of project goes back, select and address, when nothing was remembered before", async () => {
    useService();
    server.use(http.put(url("/find/screen"), () => refusal(503, "UNAVAILABLE", "This computer's settings could not be written.")));
    const user = userEvent.setup();
    show();
    const project = (await screen.findByRole("combobox", { name: "Project" })) as HTMLSelectElement;
    await waitFor(() => expect(project.value).toBe(PID));
    await user.selectOptions(project, PID_OTHER);
    expect(await screen.findByText(/could not remember the choice/)).toBeTruthy();
    await waitFor(() => expect(project.value).toBe(PID));
    expect(new URLSearchParams(window.location.search).get("project")).toBe(PID);
  });

  it("N3 (B4): the project shown stays when it is locked elsewhere; the unlock is offered", async () => {
    useService();
    show();
    const project = (await screen.findByRole("combobox", { name: "Project" })) as HTMLSelectElement;
    await waitFor(() => expect(project.value).toBe(PID));
    await waitFor(() => expect(events.open()).toBe(true));
    events.push(libState("lib-1"));
    server.use(http.get(url("/projects"), () => HttpResponse.json({ projects: PROJECTS.projects.map((p) => (p.id === PID ? { ...p, encrypted: true, unlocked: false } : p)) })));
    queues[PID] = () => refusal(423, "PROJECT_LOCKED", FIND_ROUTE_TEXT.locked, "locked");
    events.push(libState("lib-1"));
    await waitFor(() => expect(within(project).getAllByRole("option").map((o) => o.textContent)).toContain("Market study (locked)"));
    expect(await screen.findByRole("heading", { name: /Market study is locked/ })).toBeTruthy();
    expect(project.value).toBe(PID);
  });

  it("N4: after a change of library, focus goes to the screen's heading", async () => {
    const e = entry({ typed: "focus here", state: "not-found" });
    useService({ queues: { [PID]: queue([e]) } });
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(events.open()).toBe(true));
    events.push(libState("lib-1"));
    within(row("focus here")).getByRole("button", { name: "Try again: “focus here”" }).focus();
    events.push(libState("lib-2"));
    const heading = screen.getByRole("heading", { level: 1, name: "Find and acquire" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });

  it("N5 (a): after an add refused because the project was locked, focus goes to the unlock's field", async () => {
    useService();
    server.use(http.post(url(`/projects/${PID}/find`), () => refusal(423, "PROJECT_LOCKED", FIND_ROUTE_TEXT.locked, "locked")));
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    await user.type(box(), "Weber{Control>}{Enter}{/Control}");
    const field = await screen.findByLabelText("Passphrase or recovery code");
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it("N5 (b): an add with no answer for 60 seconds is given up: the box is editable, its text kept, the status says so, and the queue is read", async () => {
    useService();
    server.use(http.post(url(`/projects/${PID}/find`), () => new Promise<Response>(() => {})));
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    await user.type(box(), "Weber");
    const before = reads();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
      await vi.advanceTimersByTimeAsync(10);
      expect(box().readOnly).toBe(true);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(box().readOnly).toBe(true);
      await vi.advanceTimersByTimeAsync(1_500);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(box().readOnly).toBe(false));
    expect(box().value).toBe("Weber");
    await waitFor(() => expect(live().textContent).toBe("The service did not answer. Nothing was added that the queue does not show."));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it("R263 (R4-3 a): the sentence for an add with no answer is also visible beside the box, tied to it, and said once in the status", async () => {
    useService();
    server.use(http.post(url(`/projects/${PID}/find`), () => new Promise<Response>(() => {})));
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    await user.type(box(), "Weber");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(60_500);
    } finally {
      vi.useRealTimers();
    }
    const sentence = "The service did not answer. Nothing was added that the queue does not show.";
    const visible = await screen.findByRole("alert");
    expect(visible.textContent).toBe(sentence);
    expect(visible.className).toBe("ao-error");
    expect(box().getAttribute("aria-describedby")?.split(" ")).toContain(visible.id);
    await waitFor(() => expect(live().textContent).toBe(sentence));
    expect(screen.getAllByText(sentence, { exact: true }).filter((x) => live().contains(x))).toHaveLength(1);
  });

  it("R263 (C1): a read started after the last act's answer is taken whatever its stamp (a clock that stepped back)", async () => {
    const e = entry({ typed: "Merton", state: "not-found", updatedAt: "2026-11-13T10:00:00.000Z" });
    let current: FindEntryView = e;
    useService({ queues: { [PID]: async () => HttpResponse.json(queue([current])) } });
    server.use(
      http.post(url(`/projects/${PID}/find/${e.id}/retry`), () => {
        current = { ...e, state: "record-complete", updatedAt: "2026-11-13T11:59:00.000Z" };
        return HttpResponse.json({ ...e, state: "looking-up", updatedAt: "2026-11-13T12:00:00.000Z" });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(within(row("Merton")).getByRole("button", { name: "Try again: “Merton”" }));
    await waitFor(() => expect(stateOf("Merton")).toBe("Record complete"));
  });

  it("R263 (C3): reads with unreadable stamps: the later-started wins", async () => {
    const e = entry({ typed: "Garbled", state: "looking-up", updatedAt: "garbage" });
    const first = held<void>();
    let k = 0;
    useService({
      queues: {
        [PID]: async () => {
          const mine = ++k;
          if (mine === 1) {
            await first.p;
            return HttpResponse.json(queue([{ ...e, state: "choose", candidates: [cand({ id: "c1" })], updatedAt: "garbage" }]));
          }
          return HttpResponse.json(queue([{ ...e, updatedAt: "aaa" }]));
        },
      },
    });
    const user = userEvent.setup();
    show();
    const sw = await screen.findByRole("switch", { name: "Check everything I have" });
    await waitFor(() => expect(k).toBe(1));
    await user.click(sw);
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(stateOf("Garbled")).toBe("Looking it up"));
    first.release();
    await new Promise((r) => setTimeout(r, 150));
    expect(stateOf("Garbled")).toBe("Looking it up");
  });

  it("R263 (C3b): a read after an act's answer is taken even when its stamp is missing", async () => {
    const e = entry({ typed: "Nostamp", state: "not-found", updatedAt: "2026-11-13T10:00:00.000Z" });
    let current: FindEntryView = e;
    useService({ queues: { [PID]: async () => HttpResponse.json(queue([current])) } });
    server.use(
      http.post(url(`/projects/${PID}/find/${e.id}/retry`), () => {
        current = { ...e, state: "record-complete", updatedAt: undefined } as unknown as FindEntryView;
        return HttpResponse.json({ ...e, state: "looking-up", updatedAt: "2026-11-13T12:00:00.000Z" });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(within(row("Nostamp")).getByRole("button", { name: "Try again: “Nostamp”" }));
    await waitFor(() => expect(stateOf("Nostamp")).toBe("Record complete"));
  });

  it("N6 (E3): a malformed candidate is left out; with none left the row offers only Remove", async () => {
    const bad = { id: "cx", title: "No identifiers", creators: [], type: "book", providers: [] } as unknown as FindWorkCandidate;
    const notitle = { id: "cy", creators: [], type: "book", identifiers: {}, providers: [] } as unknown as FindWorkCandidate;
    const a = entry({ typed: "one good", state: "choose", candidates: [bad, cand({ id: "c1", title: "Good title" }), notitle] });
    const b = entry({ typed: "all bad", state: "choose", candidates: [bad, notitle] });
    useService({ queues: { [PID]: queue([a, b]) } });
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(stateOf("one good")).toBe("1 possible match");
    expect(stateOf("all bad")).toBe("No possible matches.");
    expect(within(row("all bad")).getAllByRole("button").map((x) => x.getAttribute("aria-label"))).toEqual(["Remove from the queue: “all bad”"]);
    await user.click(within(row("one good")).getByRole("button", { name: "Choose: “one good”" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByRole("heading", { level: 1, name: "Find and acquire" })).toBeTruthy();
  });
});

describe("FindAcquire: the contract (each request exactly as the handler takes it)", () => {
  const api = () => findApi(testClient());
  const E = "0190a000-0000-7000-8000-0000000000e9";
  const record = () => {
    const seen: Array<{ method: string; path: string; body: unknown; query: string }> = [];
    server.use(
      http.all(url("/*"), async ({ request }) => {
        const u = new URL(request.url);
        const t = await request.text();
        seen.push({ method: request.method, path: u.pathname, body: t ? JSON.parse(t) : undefined, query: u.search });
        if (u.pathname === `/projects/${PID}/find/${E}`) return HttpResponse.json({ removed: true });
        if (u.pathname.endsWith("/elsewhere")) return HttpResponse.json(null);
        if (u.pathname === "/find/screen") return HttpResponse.json(t ? JSON.parse(t) : { checkEverything: false });
        if (u.pathname === `/projects/${PID}/find` && request.method === "POST") return HttpResponse.json({ added: [], mergedLines: 0 });
        if (u.pathname === `/projects/${PID}/find`) return HttpResponse.json(queue([]));
        return HttpResponse.json(entry());
      }),
    );
    return seen;
  };

  it("GET /projects/:id/find", async () => {
    const seen = record();
    const r = await api().queue(PID);
    expect(seen).toEqual([{ method: "GET", path: `/projects/${PID}/find`, body: undefined, query: "" }]);
    expect(r.unreadableLines).toBe(0);
  });
  it("POST /projects/:id/find { lines, collectionId? }", async () => {
    const seen = record();
    await api().add(PID, { lines: ["a b"] });
    await api().add(PID, { lines: ["a b", "c d"], collectionId: CID });
    expect(seen).toEqual([
      { method: "POST", path: `/projects/${PID}/find`, body: { lines: ["a b"] }, query: "" },
      { method: "POST", path: `/projects/${PID}/find`, body: { lines: ["a b", "c d"], collectionId: CID }, query: "" },
    ]);
  });
  it("POST …/:eid/choose { candidateId }", async () => {
    const seen = record();
    await api().choose(PID, E, "c1");
    await api().choose(PID, E, null);
    expect(seen).toEqual([
      { method: "POST", path: `/projects/${PID}/find/${E}/choose`, body: { candidateId: "c1" }, query: "" },
      { method: "POST", path: `/projects/${PID}/find/${E}/choose`, body: { candidateId: null }, query: "" },
    ]);
  });
  it("POST …/:eid/duplicate { same }", async () => {
    const seen = record();
    await api().duplicate(PID, E, false);
    expect(seen).toEqual([{ method: "POST", path: `/projects/${PID}/find/${E}/duplicate`, body: { same: false }, query: "" }]);
  });
  it("POST …/:eid/add-here (no body)", async () => {
    const seen = record();
    await api().addHere(PID, E);
    expect(seen).toEqual([{ method: "POST", path: `/projects/${PID}/find/${E}/add-here`, body: undefined, query: "" }]);
  });
  it("POST …/:eid/retry (no body)", async () => {
    const seen = record();
    await api().retry(PID, E);
    expect(seen).toEqual([{ method: "POST", path: `/projects/${PID}/find/${E}/retry`, body: undefined, query: "" }]);
  });
  it("DELETE …/:eid", async () => {
    const seen = record();
    expect(await api().remove(PID, E)).toEqual({ removed: true });
    expect(seen).toEqual([{ method: "DELETE", path: `/projects/${PID}/find/${E}`, body: undefined, query: "" }]);
  });
  it("GET …/:eid/elsewhere", async () => {
    const seen = record();
    expect(await api().elsewhere(PID, E)).toBeNull();
    expect(seen).toEqual([{ method: "GET", path: `/projects/${PID}/find/${E}/elsewhere`, body: undefined, query: "" }]);
  });
  it("GET /find/screen and PUT /find/screen { checkEverything, projectId?, collectionId? }", async () => {
    const seen = record();
    await api().screen();
    await api().putScreen({ checkEverything: true, projectId: PID, collectionId: CID });
    await api().putScreen({ checkEverything: false });
    expect(seen).toEqual([
      { method: "GET", path: "/find/screen", body: undefined, query: "" },
      { method: "PUT", path: "/find/screen", body: { checkEverything: true, projectId: PID, collectionId: CID }, query: "" },
      { method: "PUT", path: "/find/screen", body: { checkEverything: false }, query: "" },
    ]);
  });
  // Task F9: the three routes of an author's entry (F8's handlers, routes/find.ts: options, person, works).
  it("GET …/:eid/options (no body)", async () => {
    const seen = record();
    await api().options(PID, E);
    expect(seen).toEqual([{ method: "GET", path: `/projects/${PID}/find/${E}/options`, body: undefined, query: "" }]);
  });
  it("POST …/:eid/person { personId }", async () => {
    const seen = record();
    await api().person(PID, E, "A5055013655");
    expect(seen).toEqual([{ method: "POST", path: `/projects/${PID}/find/${E}/person`, body: { personId: "A5055013655" }, query: "" }]);
  });
  it("POST …/:eid/works { workIds }", async () => {
    const seen = record();
    await api().works(PID, E, ["W2038217319", "W2621405455"]);
    expect(seen).toEqual([{ method: "POST", path: `/projects/${PID}/find/${E}/works`, body: { workIds: ["W2038217319", "W2621405455"] }, query: "" }]);
  });
  it("a malformed id is refused before anything is sent, and the error does not repeat it", async () => {
    const seen = record();
    expect(() => api().retry(PID, "Zorblatt")).toThrow();
    try {
      api().retry("Zorblatt", E);
    } catch (err) {
      expect(String(err)).not.toContain("Zorblatt");
    }
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Task F9 (R267, R270–R272): an author alone — the rows' words, the two dialogs on the screen, and the two
// improvements to the screen that its reviews left for this task (an add waits for the switch; the result of the
// researcher's own act is said first and stays). The service is mocked exactly as F8's handlers answer
// (apps/library-service/src/routes/find.ts: options, person, works).

describe("FindAcquire: an author alone (F9)", () => {
  const PERSON_A = "A5055013655";
  const PERSON_B = "A5108208998";
  const person = (o: Partial<FindPersonCandidate> & { id: string; name: string }): FindPersonCandidate => ({ worksCount: 10, subjects: [], ...o });
  const work = (o: Partial<FindPersonWork> & { id: string; title: string }): FindPersonWork => ({
    creators: [{ family: "Stark", role: "author" }],
    issued: "2015",
    type: "article-journal",
    identifiers: {},
    providers: ["openalex"],
    ...o,
  });
  const PEOPLE = [
    person({ id: PERSON_A, name: "David Stark", worksCount: 160, subjects: ["Post-Communist Economic and Political Transition", "Eastern European Communism and Reforms", "Management and Organizational Studies"] }),
    person({ id: PERSON_B, name: "David Stark", affiliation: "The People of the United Methodist Church", worksCount: 46, subjects: ["Colonialism, slavery, and trade"] }),
  ];
  const WORKS = [
    work({ id: "W3015927993", title: "Put to the test: For a new sociology of testing", issued: "2020-04-19", container: "British Journal of Sociology", creators: [{ family: "Marres", role: "author" }] }),
    work({ id: "W2621405455", title: "For What It’s Worth", issued: "2017-06-01", type: "chapter", container: "Research in the sociology of organizations" }),
    work({ id: "W2038217319", title: "Game Changer: The Topology of Creativity", issued: "2015-01-01", container: "American Journal of Sociology", creators: [{ family: "Vaan", role: "author" }] }),
    work({ id: "W2588831772", title: "The Sense of Dissonance: Accounts of Worth in Economic Life", issued: "2009-12-31", type: "book", container: "Princeton University Press eBooks" }),
  ];
  const stateText = (r: HTMLElement) => r.querySelector(".ao-find__state")?.textContent;
  const authorRow = (typed: string) => row(`Author: ${typed}`);
  const progress = (e: FindEntryView, state = e.state) => events.push({ type: "find.progress", data: { projectId: PID, entryId: e.id, state } });

  it("an author's row says Author: … and N people match; Choose works with N added; Remove stays offered", async () => {
    const a = entry({ typed: "David Stark", state: "choose-person", peopleCount: 2, morePeople: true });
    const b = entry({ typed: "Ann Swidler", state: "choose-person", peopleCount: 1 });
    const c = entry({ typed: "Mario Small", state: "choose-works", peopleCount: 1, chosen: PERSON_A, worksCount: 12, addedCount: 3 });
    const d = entry({ typed: "Nobody Known", state: "choose-works", peopleCount: 1, chosen: PERSON_B, worksCount: 0 });
    const e = entry({ typed: "Viviana Zelizer", state: "choose-works", peopleCount: 1, chosen: PERSON_A, worksCount: 7 });
    const f = entry({ typed: "Gary Fine", state: "looking-up", peopleCount: 1, chosen: PERSON_A });
    useService({ queues: { [PID]: queue([a, b, c, d, e, f]) } });
    show();
    await waitFor(() => expect(rows()).toHaveLength(6));
    expect(stateText(authorRow("David Stark"))).toBe("2 people match");
    expect(authorRow("David Stark").textContent).toContain("More people have this name; add a word from a title to narrow it.");
    expect(within(authorRow("David Stark")).getByRole("button", { name: "Choose the person: “David Stark”" })).toBeTruthy();
    expect(stateText(authorRow("Ann Swidler"))).toBe("1 person matches");
    expect(authorRow("Ann Swidler").textContent).not.toContain("More people have this name");
    expect(stateText(authorRow("Mario Small"))).toBe("Choose works · 3 added");
    expect(within(authorRow("Mario Small")).getByRole("button", { name: "Choose works: “Mario Small”" })).toBeTruthy();
    expect(stateText(authorRow("Viviana Zelizer"))).toBe("Choose works");
    // A person with no works listed: said, and nothing to choose from.
    expect(stateText(authorRow("Nobody Known"))).toBe("No works are listed for this person.");
    expect(within(authorRow("Nobody Known")).queryByRole("button", { name: /Choose works/ })).toBeNull();
    // After the person was chosen, while the works are fetched.
    expect(stateText(authorRow("Gary Fine"))).toBe("Looking it up");
    for (const r of rows()) expect(within(r).getByRole("button", { name: /^Remove from the queue: “/ })).toBeTruthy();
    // What was typed is outside text: through UserText, and the prefix is not part of it.
    const typed = authorRow("David Stark").querySelector("[data-entry-text] [dir=auto]")!;
    expect(typed.textContent).toBe("David Stark");
  });

  it("a row made from an author's entry is shown as a work, with where it came from; its names and the status say it without the marks of typed text (R281 a)", async () => {
    const parent = entry({ typed: "David Stark", state: "choose-works", peopleCount: 1, chosen: PERSON_A, worksCount: 4, addedCount: 2 });
    const w = WORKS[2]!;
    const child = entry({ typed: "Game Changer, Vaan", state: "looking-up", parentId: parent.id, work: w.id, chosen: w.id, candidates: [w] });
    const orphan = entry({ typed: "For What It’s Worth, Stark", state: "record-complete", sourceId: SID, parentId: eid(), work: "W2621405455", chosen: "W2621405455", candidates: [WORKS[1]!] });
    useService({ queues: { [PID]: queue([parent, child, orphan]) } });
    show();
    await waitFor(() => expect(rows()).toHaveLength(3));
    await waitFor(() => expect(events.open()).toBe(true));
    const c = row("Work: Game Changer, Vaan");
    // The line reads "Work: …"; the built line through UserText.
    expect(c.querySelector("[data-entry-text] [dir=auto]")?.textContent).toBe("Game Changer, Vaan");
    const origin = c.querySelector(".ao-find__origin")!;
    expect(origin.textContent).toBe("Added from “David Stark”");
    expect(origin.querySelector("[dir=auto]")?.textContent).toBe("David Stark");
    expect(c.querySelector(".ao-find__match")?.textContent).toContain("Game Changer: The Topology of Creativity");
    // Names: the built line WITHOUT the quotation marks of typed text, and where it came from.
    expect(within(c).getByRole("button", { name: "Remove from the queue: Game Changer, Vaan (added from “David Stark”)" })).toBeTruthy();
    // Its parent removed: "added from an author's works".
    const o = row("Work: For What It’s Worth, Stark");
    expect(o.querySelector(".ao-find__origin")?.textContent).toBe("Added from an author's works");
    expect(within(o).getByRole("button", { name: "Open: For What It’s Worth, Stark (added from an author's works)" })).toBeTruthy();
    // An ordinary row says nothing of the kind.
    expect(authorRow("David Stark").querySelector(".ao-find__origin")).toBeNull();
    // The status region says it the same way.
    queues[PID] = queue([parent, { ...child, state: "record-complete", sourceId: SID, updatedAt: "2026-11-13T11:00:00.000Z" }, orphan]);
    progress(child, "record-complete");
    await waitFor(() => expect(live().textContent).toBe("Game Changer, Vaan (added from “David Stark”): Record complete."));
  });

  it("the lists are read from options when the dialog opens (the dialog says so while they load), and are not kept after it closes", async () => {
    const a = entry({ typed: "David Stark", state: "choose-person", peopleCount: 2 });
    useService({ queues: { [PID]: queue([a]) } });
    const hold = held<void>();
    let asked = 0;
    server.use(
      http.get(url(`/projects/${PID}/find/${a.id}/options`), async () => {
        asked++;
        if (asked === 1) await hold.p;
        return HttpResponse.json({ people: PEOPLE });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    // The queue's answer carries counts only: nothing asked before the press.
    expect(asked).toBe(0);
    const opener = within(authorRow("David Stark")).getByRole("button", { name: "Choose the person: “David Stark”" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Choose the person for “David Stark”" });
    expect(within(dialog).getByText("Reading the people of this name…")).toBeTruthy();
    expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
    hold.release();
    await waitFor(() => expect(within(dialog).getAllByRole("radio")).toHaveLength(2));
    expect(within(dialog).queryByText("Reading the people of this name…")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    // Opened again: read again.
    await user.click(opener);
    const again = await screen.findByRole("dialog");
    await waitFor(() => expect(within(again).getAllByRole("radio")).toHaveLength(2));
    expect(asked).toBe(2);
    expect(calls.filter((c) => c.path === `/projects/${PID}/find/${a.id}/options`).every((c) => c.method === "GET" && c.body === undefined)).toBe(true);
  });

  it("a failed options read shows the service's sentence in the dialog, and nothing else changes", async () => {
    const a = entry({ typed: "David Stark", state: "choose-person", peopleCount: 2 });
    const b = entry({ typed: "Ann Swidler", state: "choose-works", peopleCount: 1, chosen: PERSON_A, worksCount: 3 });
    useService({ queues: { [PID]: queue([a, b]) } });
    server.use(
      http.get(url(`/projects/${PID}/find/${a.id}/options`), () => refusal(404, "NOT_FOUND", FIND_ROUTE_TEXT.entryNotFound)),
      // An entry that no longer holds the list asked for (another state now): said in the service's words for that.
      http.get(url(`/projects/${PID}/find/${b.id}/options`), () => HttpResponse.json({})),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await user.click(within(authorRow("David Stark")).getByRole("button", { name: "Choose the person: “David Stark”" }));
    let dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findByRole("alert")).textContent).toBe(FIND_ROUTE_TEXT.entryNotFound);
    expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
    expect((within(dialog).getByRole("button", { name: "This is the person" }) as HTMLButtonElement).disabled).toBe(true);
    expect(stateText(authorRow("David Stark"))).toBe("2 people match");
    await user.keyboard("{Escape}");
    await user.click(within(authorRow("Ann Swidler")).getByRole("button", { name: "Choose works: “Ann Swidler”" }));
    dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findByRole("alert")).textContent).toBe(FIND_ROUTE_TEXT.entryState);
    expect(within(dialog).queryAllByRole("checkbox")).toHaveLength(0);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("This is the person: the person's id in the body; the dialog closes, the row says Looking it up then Choose works; focus on the row's next control", async () => {
    const a = entry({ typed: "David Stark", state: "choose-person", peopleCount: 2, morePeople: true });
    useService({ queues: { [PID]: queue([a]) } });
    let body: unknown;
    server.use(
      http.get(url(`/projects/${PID}/find/${a.id}/options`), () => HttpResponse.json({ people: PEOPLE })),
      http.post(url(`/projects/${PID}/find/${a.id}/person`), async ({ request }) => {
        body = await request.json();
        const next: FindEntryView = { ...a, state: "looking-up", chosen: PERSON_A, peopleCount: 1, updatedAt: "2026-11-13T11:00:00.000Z" };
        delete next.morePeople;
        queues[PID] = queue([next]);
        return HttpResponse.json(next);
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(events.open()).toBe(true));
    await user.click(within(authorRow("David Stark")).getByRole("button", { name: "Choose the person: “David Stark”" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByRole("radio")).toHaveLength(2));
    await user.click(within(dialog).getAllByRole("radio")[0]!);
    await user.click(within(dialog).getByRole("button", { name: "This is the person" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(body).toEqual({ personId: PERSON_A });
    await waitFor(() => expect(stateText(authorRow("David Stark"))).toBe("Looking it up"));
    expect(authorRow("David Stark").textContent).not.toContain("More people have this name");
    // Focus: the row's next control, never the page.
    await waitFor(() => expect(document.activeElement).toBe(within(authorRow("David Stark")).getByRole("button", { name: "Remove from the queue: “David Stark”" })));
    // The works have come: the event, a read, "Choose works".
    const ready: FindEntryView = { ...a, state: "choose-works", chosen: PERSON_A, peopleCount: 1, worksCount: 4, updatedAt: "2026-11-13T11:00:05.000Z" };
    delete ready.morePeople;
    queues[PID] = queue([ready]);
    progress(a, "choose-works");
    await waitFor(() => expect(stateText(authorRow("David Stark"))).toBe("Choose works"));
    expect(within(authorRow("David Stark")).getByRole("button", { name: "Choose works: “David Stark”" })).toBeTruthy();
  });

  it("Choose works: ticked works sent; new rows that say where they came from; the status says Added 3 works.; focus on Choose works", async () => {
    const a = entry({ typed: "David Stark", state: "choose-works", peopleCount: 1, chosen: PERSON_A, worksCount: 4 });
    useService({ queues: { [PID]: queue([a]) } });
    let body: { workIds: string[] } | undefined;
    server.use(
      http.get(url(`/projects/${PID}/find/${a.id}/options`), () => HttpResponse.json({ works: WORKS, person: { name: "David Stark", subjects: ["Management and Organizational Studies"] } })),
      http.post(url(`/projects/${PID}/find/${a.id}/works`), async ({ request }) => {
        body = (await request.json()) as { workIds: string[] };
        const added = body.workIds.map((id) => {
          const w = WORKS.find((x) => x.id === id)!;
          return entry({ typed: `${w.title}, ${w.creators[0]!.family}`, state: "looking-up", parentId: a.id, work: id, chosen: id, candidates: [w] });
        });
        const parent: FindEntryView = { ...a, addedCount: added.length, updatedAt: "2026-11-13T11:00:00.000Z" };
        queues[PID] = queue([parent, ...added]);
        return HttpResponse.json({ added, entry: parent });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const h = heard();
    await user.click(within(authorRow("David Stark")).getByRole("button", { name: "Choose works: “David Stark”" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByRole("checkbox")).toHaveLength(4));
    for (const i of [0, 1, 2]) await user.click(within(dialog).getAllByRole("checkbox")[i]!);
    await user.click(within(dialog).getByRole("button", { name: "Add the chosen works (3)" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(body).toEqual({ workIds: ["W3015927993", "W2621405455", "W2038217319"] });
    await waitFor(() => expect(rows()).toHaveLength(4));
    for (const r of rows().slice(1)) expect(r.querySelector(".ao-find__origin")?.textContent).toBe("Added from “David Stark”");
    expect(stateText(authorRow("David Stark"))).toBe("Choose works · 3 added");
    await waitFor(() => expect(h.said).toContain("Added 3 works."));
    expect(document.activeElement).toBe(within(authorRow("David Stark")).getByRole("button", { name: "Choose works: “David Stark”" }));
    h.stop();
  });

  it("a 409 in either dialog is said in the dialog in the service's words, and changes nothing", async () => {
    const a = entry({ typed: "David Stark", state: "choose-person", peopleCount: 2 });
    const b = entry({ typed: "Ann Swidler", state: "choose-works", peopleCount: 1, chosen: PERSON_A, worksCount: 4 });
    useService({ queues: { [PID]: queue([a, b]) } });
    server.use(
      http.get(url(`/projects/${PID}/find/${a.id}/options`), () => HttpResponse.json({ people: PEOPLE })),
      http.get(url(`/projects/${PID}/find/${b.id}/options`), () => HttpResponse.json({ works: WORKS, person: { name: "Ann Swidler", subjects: [] } })),
      http.post(url(`/projects/${PID}/find/${a.id}/person`), () => refusal(409, "CONFLICT", FIND_ROUTE_TEXT.entryState, "entry-state")),
      http.post(url(`/projects/${PID}/find/${b.id}/works`), () => refusal(409, "CONFLICT", FIND_ROUTE_TEXT.queueFull, "queue-full")),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await user.click(within(authorRow("David Stark")).getByRole("button", { name: "Choose the person: “David Stark”" }));
    let dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByRole("radio")).toHaveLength(2));
    await user.click(within(dialog).getAllByRole("radio")[1]!);
    await user.click(within(dialog).getByRole("button", { name: "This is the person" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(FIND_ROUTE_TEXT.entryState);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(stateText(authorRow("David Stark"))).toBe("2 people match");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(authorRow("Ann Swidler")).getByRole("button", { name: "Choose works: “Ann Swidler”" }));
    dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByRole("checkbox")).toHaveLength(4));
    await user.click(within(dialog).getAllByRole("checkbox")[0]!);
    await user.click(within(dialog).getByRole("button", { name: "Add the chosen works (1)" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(FIND_ROUTE_TEXT.queueFull);
    // Nothing half-shown: the tick stays, no row was added, the row says what it said.
    expect((within(dialog).getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(true);
    expect(rows()).toHaveLength(2);
    expect(stateText(authorRow("Ann Swidler"))).toBe("Choose works");
  });

  it("focus after a dialog closes on a row that changed or vanished meanwhile: the row's next control, else the next row", async () => {
    const a = entry({ typed: "David Stark", state: "choose-person", peopleCount: 2 });
    const b = entry({ typed: "Merton", state: "not-found" });
    useService({ queues: { [PID]: queue([a, b]) } });
    server.use(http.get(url(`/projects/${PID}/find/:eid/options`), () => HttpResponse.json({ people: PEOPLE })));
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(events.open()).toBe(true));
    await user.click(within(authorRow("David Stark")).getByRole("button", { name: "Choose the person: “David Stark”" }));
    let dialog = await screen.findByRole("dialog");
    // The entry is removed elsewhere while the dialog is open.
    queues[PID] = queue([b]);
    progress(a);
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(row("Merton").querySelector("[data-entry-text]")));
    // The row changed state while open (its opener gone): the row's next control.
    const c = entry({ typed: "Ann Swidler", state: "choose-person", peopleCount: 2 });
    queues[PID] = queue([b, c]);
    progress(c);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await user.click(within(authorRow("Ann Swidler")).getByRole("button", { name: "Choose the person: “Ann Swidler”" }));
    dialog = await screen.findByRole("dialog");
    queues[PID] = queue([b, { ...c, state: "not-found", updatedAt: "2026-11-13T12:00:00.000Z" }]);
    progress(c, "not-found");
    await waitFor(() => expect(stateText(authorRow("Ann Swidler"))).toBe("Not found"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(within(authorRow("Ann Swidler")).getByRole("button", { name: "Try again: “Ann Swidler”" })));
  });

  it("another library opened closes the dialog and forgets its lists", async () => {
    const a = entry({ typed: "David Stark", state: "choose-works", peopleCount: 1, chosen: PERSON_A, worksCount: 4 });
    useService({ queues: { [PID]: queue([a]) } });
    const late = held<void>();
    let asked = 0;
    server.use(
      http.get(url(`/projects/${PID}/find/${a.id}/options`), async () => {
        asked++;
        if (asked === 2) await late.p;
        return HttpResponse.json({ works: WORKS, person: { name: "David Stark", subjects: [] } });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(events.open()).toBe(true));
    events.push({ type: "library.state", data: { open: true, libraryId: "lib-1", name: "L", mode: "read-write" } });
    await user.click(within(authorRow("David Stark")).getByRole("button", { name: "Choose works: “David Stark”" }));
    let dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByRole("checkbox")).toHaveLength(4));
    // Closed and opened again: the second read is held when another library opens.
    await user.keyboard("{Escape}");
    await user.click(within(authorRow("David Stark")).getByRole("button", { name: "Choose works: “David Stark”" }));
    dialog = await screen.findByRole("dialog");
    const PID_NEW = "0190a000-0000-7000-8000-0000000000a9";
    server.use(http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: PID_NEW, name: "Grant 2025", folder: "Grant 2025", encrypted: false, unlocked: true }] })));
    queues[PID_NEW] = queue([entry({ typed: "new row", projectId: PID_NEW })]);
    events.push({ type: "library.state", data: { open: true, libraryId: "lib-2", name: "L2", mode: "read-write" } });
    await waitFor(() => expect(rows().map((r) => r.querySelector("[data-entry-text]")?.textContent)).toEqual(["new row"]));
    expect(screen.queryByRole("dialog")).toBeNull();
    late.release();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Game Changer: The Topology of Creativity")).toBeNull();
  });

  it("an add waits for the switch: sent once its change is confirmed, and not sent (the text kept, the failure said) if it fails", async () => {
    useService();
    const put = held<void>();
    let added: unknown[] = [];
    server.use(
      http.put(url("/find/screen"), async ({ request }) => {
        const b = (await request.json()) as FindScreenSettings;
        await put.p;
        screenSettings = b;
        return HttpResponse.json(b);
      }),
      http.post(url(`/projects/${PID}/find`), async ({ request }) => {
        added.push({ body: await request.json(), check: screenSettings.checkEverything });
        const e = entry({ typed: "Weber" });
        return HttpResponse.json({ added: [e], mergedLines: 0 });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    const sw = screen.getByRole("switch", { name: "Check everything I have" }) as HTMLInputElement;
    await user.click(sw);
    expect(sw.checked).toBe(true);
    expect(sw.getAttribute("aria-busy")).toBe("true");
    await user.type(box(), "Weber");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await new Promise((r) => setTimeout(r, 100));
    // Not sent while the switch's change is out; the box is read-only meanwhile.
    expect(added).toEqual([]);
    expect(box().readOnly).toBe(true);
    put.release();
    await waitFor(() => expect(added).toHaveLength(1));
    expect(added[0]).toEqual({ body: { lines: ["Weber"] }, check: true });
    await waitFor(() => expect(box().value).toBe(""));
    // The switch's change fails: the add is not sent; the text is kept; the failure is said.
    added = [];
    const put2 = held<void>();
    server.use(
      http.put(url("/find/screen"), async () => {
        await put2.p;
        return refusal(503, "LIBRARY_OFFLINE", "The library's folder is not reachable.");
      }),
    );
    await user.click(sw);
    expect(sw.checked).toBe(false);
    await user.type(box(), "Simmel");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await new Promise((r) => setTimeout(r, 100));
    expect(added).toEqual([]);
    put2.release();
    await waitFor(() => expect(sw.checked).toBe(true));
    // Said beside the box (tied to it) and in the status region.
    await waitFor(() => {
      const ids = (box().getAttribute("aria-describedby") ?? "").split(" ");
      expect(ids.map((i) => document.getElementById(i)?.textContent ?? "").some((t) => t.startsWith("Nothing was added, because “Check everything I have” could not be changed."))).toBe(true);
    });
    await waitFor(() => expect(live().textContent).toMatch(/^Nothing was added, because “Check everything I have” could not be changed\./));
    expect(box().value).toBe("Simmel");
    expect(box().readOnly).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(added).toEqual([]);
  });

  it("the result of an act stays a second; rows' changes follow it, the latest per row, never twice and never older than shown", async () => {
    const x = entry({ typed: "Simmel" });
    const y = entry({ typed: "Merton" });
    useService({ queues: { [PID]: queue([x, y]) } });
    server.use(
      http.post(url(`/projects/${PID}/find`), () => {
        const e = entry({ typed: "Weber" });
        queues[PID] = queue([x, y, e]);
        return HttpResponse.json({ added: [e], mergedLines: 0 });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(events.open()).toBe(true));
    await user.type(box(), "Weber");
    const h = heard();
    /** Fake time in small steps, so that the mocked service's answers come in between. */
    const step = async (ms: number) => {
      for (let t = 0; t < ms; t += 10) await vi.advanceTimersByTimeAsync(10);
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
      // The add's answer (the mocked service answers on its own timers): the act's result is said.
      for (let i = 0; i < 50 && !live().textContent; i++) await vi.advanceTimersByTimeAsync(5);
      expect(live().textContent).toBe("Added 1 reference.");
      // Rows change meanwhile: Simmel twice (only its latest is said), Merton once.
      const weber = (queues[PID] as FindQueueResponse).entries[2]!;
      queues[PID] = queue([{ ...x, state: "not-found", updatedAt: "2026-11-13T11:00:00.000Z" }, { ...y, state: "record-complete", sourceId: SID, updatedAt: "2026-11-13T11:00:00.000Z" }, weber]);
      progress(x, "not-found");
      await step(450);
      expect(row("Simmel").querySelector(".ao-find__state")?.textContent).toBe("Not found");
      expect(live().textContent).toBe("Added 1 reference.");
      queues[PID] = queue([{ ...x, state: "record-complete", sourceId: SID, updatedAt: "2026-11-13T11:00:01.000Z" }, { ...y, state: "record-complete", sourceId: SID, updatedAt: "2026-11-13T11:00:00.000Z" }, weber]);
      progress(x, "record-complete");
      await step(450);
      expect(row("Simmel").querySelector(".ao-find__state")?.textContent).toBe("Record complete");
      expect(live().textContent).toBe("Added 1 reference.");
      await step(200);
      // After a second: each row's latest, once.
      expect(live().textContent).toBe("“Simmel”: Record complete. “Merton”: Record complete.");
      // The same state read again is not said again.
      progress(y, "record-complete");
      await step(1000);
    } finally {
      vi.useRealTimers();
    }
    expect(h.said.filter((s) => s.includes("Not found"))).toEqual([]);
    expect(h.said.filter((s) => s.includes("“Simmel”: Record complete."))).toHaveLength(1);
    expect(h.said[0]).toBe("Added 1 reference.");
    h.stop();
  });
});

// ---------------------------------------------------------------------------------------------
// Task F9, round 2 (R279 d, R281): a lock met in any dialog; a switch with no answer; the screen read again when the
// library is reported open; the status region's "never twice"; timers cleared; a stale list dropped; "already added"
// read again; "Show this author's works".

describe("FindAcquire: round 2 (R279, R281)", () => {
  const PERSON_A = "A5055013655";
  const PEOPLE: FindPersonCandidate[] = [
    { id: PERSON_A, name: "David Stark", worksCount: 160, subjects: ["Post-Communist Economic and Political Transition"] },
    { id: "A5108208998", name: "David Stark", affiliation: "The People of the United Methodist Church", worksCount: 46, subjects: [] },
  ];
  const work = (id: string, title: string, o: Partial<FindPersonWork> = {}): FindPersonWork => ({ id, title, creators: [{ family: "Stark", role: "author" }], issued: "2015", type: "article-journal", identifiers: {}, providers: ["openalex"], ...o });
  const WORKS = [work("W3015927993", "Put to the test: For a new sociology of testing"), work("W2621405455", "For What It’s Worth", { type: "chapter" }), work("W2038217319", "Game Changer: The Topology of Creativity")];
  const progress = (e: FindEntryView, state = e.state) => events.push({ type: "find.progress", data: { projectId: PID, entryId: e.id, state } });
  const stateText = (r: HTMLElement) => r.querySelector(".ao-find__state")?.textContent;
  const unlockField = () => screen.findByLabelText("Passphrase or recovery code");
  const locked = () => refusal(423, "PROJECT_LOCKED", FIND_ROUTE_TEXT.locked, "locked");
  /** An entry in "choose" whose words may also name an author (R279; F8b's contract). */
  const offered = (o: Partial<FindEntryView> = {}) => entry({ typed: "David Stark", state: "choose", candidates: [cand({ id: "c1", title: "Stark, (a reference entry)" }), cand({ id: "c2" })], ...o, authorOffer: { peopleCount: 2 } } as Partial<FindEntryView>);

  it("I2: a locked project met in any dialog — options, This is the person, Add the chosen works, Choose — sends focus to the unlock's field", async () => {
    const user = userEvent.setup();
    const cases: Array<{ e: FindEntryView; open: string; route: string; press?: (d: HTMLElement) => Promise<void> }> = [
      { e: entry({ typed: "options locked", state: "choose-person", peopleCount: 2 }), open: "Choose the person: “options locked”", route: "options" },
      {
        e: entry({ typed: "person locked", state: "choose-person", peopleCount: 2 }),
        open: "Choose the person: “person locked”",
        route: "person",
        press: async (d) => {
          await waitFor(() => expect(within(d).getAllByRole("radio")).toHaveLength(2));
          await user.click(within(d).getAllByRole("radio")[0]!);
          await user.click(within(d).getByRole("button", { name: "This is the person" }));
        },
      },
      {
        e: entry({ typed: "works locked", state: "choose-works", peopleCount: 1, chosen: PERSON_A, worksCount: 3 }),
        open: "Choose works: “works locked”",
        route: "works",
        press: async (d) => {
          await waitFor(() => expect(within(d).getAllByRole("checkbox")).toHaveLength(3));
          await user.click(within(d).getAllByRole("checkbox")[0]!);
          await user.click(within(d).getByRole("button", { name: "Add the chosen works (1)" }));
        },
      },
      {
        e: entry({ typed: "choose locked", state: "choose", candidates: [cand({ id: "c1" })] }),
        open: "Choose: “choose locked”",
        route: "choose",
        press: async (d) => {
          await user.click(within(d).getAllByRole("radio")[0]!);
          await user.click(within(d).getByRole("button", { name: "Use this one" }));
        },
      },
    ];
    for (const k of cases) {
      useService({ queues: { [PID]: queue([k.e]) } });
      server.use(
        http.get(url(`/projects/${PID}/find/${k.e.id}/options`), () => (k.route === "options" ? locked() : HttpResponse.json({ people: PEOPLE, works: WORKS, person: { name: "David Stark", subjects: [] } }))),
        http.post(url(`/projects/${PID}/find/${k.e.id}/${k.route}`), () => locked()),
      );
      const view = show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      await user.click(screen.getByRole("button", { name: k.open }));
      if (k.press) await k.press(await screen.findByRole("dialog"));
      const field = await unlockField();
      await waitFor(() => expect(document.activeElement, k.route).toBe(field));
      expect(screen.queryByRole("dialog")).toBeNull();
      view.unmount();
    }
  });

  it("I3 / N1 (R281 c, R291 a): a change of the switch with no answer in 60 seconds, which the service did NOT store: the settings are read, the switch shows OFF, the waiting add is not sent, the text is kept and the box editable, and it is said", async () => {
    useService();
    let posts = 0;
    server.use(
      http.put(url("/find/screen"), () => new Promise<Response>(() => {})),
      http.post(url(`/projects/${PID}/find`), () => {
        posts++;
        return HttpResponse.json({ added: [], mergedLines: 0 });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    const sw = screen.getByRole("switch", { name: "Check everything I have" }) as HTMLInputElement;
    await user.type(box(), "Weber");
    const h = heard();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fireEvent.click(sw);
      await vi.advanceTimersByTimeAsync(10);
      expect(sw.checked).toBe(true);
      fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
      await vi.advanceTimersByTimeAsync(10);
      expect(box().readOnly).toBe(true);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(sw.getAttribute("aria-busy")).toBe("true");
      await vi.advanceTimersByTimeAsync(1_500);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(sw.checked).toBe(false));
    expect(sw.getAttribute("aria-busy")).toBeNull();
    expect(box().readOnly).toBe(false);
    expect(box().value).toBe("Weber");
    expect(posts).toBe(0);
    const OFF = "The service did not answer in time. “Check everything I have” is off.";
    const NOT_SENT = "Nothing was added. The text is kept: press “Add” to add it with the switch as it is now.";
    // Visibly: beside the switch (tied to it) what the service holds, beside the box (tied to it) that nothing was added;
    // and once in the status region.
    const swIds = (sw.getAttribute("aria-describedby") ?? "").split(" ");
    expect(swIds.map((i) => document.getElementById(i)?.textContent)).toContain(OFF);
    const ids = (box().getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((i) => document.getElementById(i)?.textContent)).toContain(NOT_SENT);
    await waitFor(() => expect(h.said.filter((x) => x.includes(OFF))).toEqual([`${OFF} ${NOT_SENT}`]));
    expect(screen.queryByText(/could not be changed/)).toBeNull();
    h.stop();
  });

  it("I5: loaded while the library was still being reopened (the reads refused), the screen reads everything again when the library is reported open", async () => {
    useService({ queues: { [PID]: queue([entry({ typed: "after the reopening" })]) } });
    let reopening = true;
    const offline = () => refusal(503, "LIBRARY_OFFLINE", "No library is open.");
    server.use(
      http.get(url("/projects"), () => (reopening ? offline() : HttpResponse.json(PROJECTS))),
      http.get(url("/find/screen"), () => (reopening ? offline() : HttpResponse.json(screenSettings))),
    );
    show();
    await waitFor(() => expect(events.open()).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.path === "/projects")).toBe(true));
    reopening = false;
    events.push({ type: "library.state", data: { open: true, libraryId: "lib-1", name: "L", mode: "read-write" } });
    await waitFor(() => expect(rows().map((r) => r.querySelector("[data-entry-text]")?.textContent)).toEqual(["after the reopening"]));
    expect(box().disabled).toBe(false);
  });

  it("M1: a row going A → B → A while an act's result holds the status region is not said again", async () => {
    const x = entry({ typed: "Simmel" });
    useService({ queues: { [PID]: queue([x]) } });
    server.use(
      http.post(url(`/projects/${PID}/find`), () => {
        const e = entry({ typed: "Weber" });
        queues[PID] = queue([{ ...x, state: "not-found", updatedAt: "2026-11-13T11:00:00.000Z" }, e]);
        return HttpResponse.json({ added: [e], mergedLines: 0 });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(events.open()).toBe(true));
    // A: said once, outside any hold.
    queues[PID] = queue([{ ...x, state: "not-found", updatedAt: "2026-11-13T11:00:00.000Z" }]);
    progress(x, "not-found");
    await waitFor(() => expect(live().textContent).toBe("“Simmel”: Not found."));
    await user.type(box(), "Weber");
    const h = heard();
    const step = async (ms: number) => {
      for (let t = 0; t < ms; t += 10) await vi.advanceTimersByTimeAsync(10);
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
      for (let i = 0; i < 50 && !h.said.length; i++) await vi.advanceTimersByTimeAsync(5);
      const weber = (queues[PID] as FindQueueResponse).entries[1]!;
      // B during the hold …
      queues[PID] = queue([{ ...x, state: "record-complete", sourceId: SID, updatedAt: "2026-11-13T11:00:01.000Z" }, weber]);
      progress(x, "record-complete");
      await step(450);
      expect(row("Simmel").querySelector(".ao-find__state")?.textContent).toBe("Record complete");
      // … and back to A, still during the hold.
      queues[PID] = queue([{ ...x, state: "not-found", updatedAt: "2026-11-13T11:00:02.000Z" }, weber]);
      progress(x, "not-found");
      await step(450);
      expect(row("Simmel").querySelector(".ao-find__state")?.textContent).toBe("Not found");
      await step(1200);
    } finally {
      vi.useRealTimers();
    }
    expect(h.said).toEqual(["Added 1 reference."]);
    h.stop();
  });

  it("M2: the status region's timer is cleared on unmount, on a change of project and on a change of library", async () => {
    for (const how of ["unmount", "project", "library"] as const) {
      useService({ queues: { [PID]: queue([]), [PID_OTHER]: queue([]) } });
      server.use(http.post(url(`/projects/${PID}/find`), () => HttpResponse.json({ added: [entry({ typed: "Weber" })], mergedLines: 0 })));
      const user = userEvent.setup();
      const view = show();
      await waitFor(() => expect(box().disabled).toBe(false));
      await waitFor(() => expect(events.open()).toBe(true));
      if (how === "library") events.push({ type: "library.state", data: { open: true, libraryId: "lib-1", name: "L", mode: "read-write" } });
      await user.type(box(), "Weber");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const set = vi.spyOn(globalThis, "setTimeout");
      const cleared = vi.spyOn(globalThis, "clearTimeout");
      try {
        fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
        for (let i = 0; i < 50 && !live().textContent; i++) await vi.advanceTimersByTimeAsync(5);
        expect(live().textContent).toBe("Added 1 reference.");
        const hold = set.mock.calls.findIndex((c) => c[1] === ACT_SAID_MS);
        expect(hold, how).toBeGreaterThanOrEqual(0);
        const id = set.mock.results[hold]!.value;
        if (how === "unmount") view.unmount();
        if (how === "project") fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: PID_OTHER } });
        if (how === "library") events.push({ type: "library.state", data: { open: true, libraryId: "lib-2", name: "L2", mode: "read-write" } });
        for (let i = 0; i < 20 && !cleared.mock.calls.some((c) => c[0] === id); i++) await vi.advanceTimersByTimeAsync(5);
        expect(cleared.mock.calls.some((c) => c[0] === id), how).toBe(true);
      } finally {
        set.mockRestore();
        cleared.mockRestore();
        vi.useRealTimers();
      }
      view.unmount();
    }
  });

  it("M4: an options answer for a dialog closed meanwhile is dropped; the dialog shows its own list", async () => {
    const a = entry({ typed: "David Stark", state: "choose-works", peopleCount: 1, chosen: PERSON_A, worksCount: 3 });
    useService({ queues: { [PID]: queue([a]) } });
    const first = held<void>();
    let asked = 0;
    server.use(
      http.get(url(`/projects/${PID}/find/${a.id}/options`), async () => {
        asked++;
        if (asked === 1) {
          await first.p;
          return HttpResponse.json({ works: [work("W1", "The stale list")], person: { name: "David Stark", subjects: [] } });
        }
        return HttpResponse.json({ works: WORKS, person: { name: "David Stark", subjects: [] } });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const opener = screen.getByRole("button", { name: "Choose works: “David Stark”" });
    await user.click(opener);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await user.click(opener);
    const d = await screen.findByRole("dialog");
    await waitFor(() => expect(within(d).getAllByRole("checkbox")).toHaveLength(3));
    first.release();
    await new Promise((r) => setTimeout(r, 100));
    expect(within(d).getAllByRole("checkbox")).toHaveLength(3);
    expect(within(d).queryByText("The stale list")).toBeNull();
  });

  it("M6: after Already added is refused, the works dialog reads options again and shows the new marks", async () => {
    const a = entry({ typed: "David Stark", state: "choose-works", peopleCount: 1, chosen: PERSON_A, worksCount: 3 });
    useService({ queues: { [PID]: queue([a]) } });
    let addedElsewhere = false;
    server.use(
      http.get(url(`/projects/${PID}/find/${a.id}/options`), () => HttpResponse.json({ works: WORKS.map((w, i) => (addedElsewhere && i === 0 ? { ...w, added: true } : w)), person: { name: "David Stark", subjects: [] } })),
      http.post(url(`/projects/${PID}/find/${a.id}/works`), () => {
        addedElsewhere = true;
        return refusal(409, "CONFLICT", "Work 1 was already added from this entry. Nothing was added.", "already-added");
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Choose works: “David Stark”" }));
    const d = await screen.findByRole("dialog");
    await waitFor(() => expect(within(d).getAllByRole("checkbox")).toHaveLength(3));
    await user.click(within(d).getAllByRole("checkbox")[0]!);
    await user.click(within(d).getAllByRole("checkbox")[1]!);
    await user.click(within(d).getByRole("button", { name: "Add the chosen works (2)" }));
    expect((await within(d).findByRole("alert")).textContent).toBe("Work 1 was already added from this entry. Nothing was added.");
    await waitFor(() => expect(within(d).getAllByRole("checkbox")[0]!.getAttribute("aria-disabled")).toBe("true"));
    expect(within(d).getAllByRole("checkbox")[0]!.closest("li")!.textContent).toContain("Added");
    // The work now added is no longer counted among the chosen.
    expect(within(d).getByRole("button", { name: "Add the chosen works (1)" })).toBeTruthy();
  });

  it("R279: a row that may also name an author says so; Choose offers Show this author's works only then; the act has no body, closes the dialog and focus goes to the row's next control", async () => {
    const a = offered();
    const b = entry({ typed: "Ann Swidler, Talk of Love", state: "choose", candidates: [cand({ id: "c1" })] });
    useService({ queues: { [PID]: queue([a, b]) } });
    let body: string | undefined;
    server.use(
      http.post(url(`/projects/${PID}/find/${a.id}/author`), async ({ request }) => {
        body = await request.text();
        const next = { ...a, state: "choose-person", peopleCount: 2, candidates: undefined, authorOffer: undefined, updatedAt: "2026-11-13T11:00:00.000Z" } as unknown as FindEntryView;
        queues[PID] = queue([next, b]);
        return HttpResponse.json(next);
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(stateText(row("David Stark"))).toBe("2 possible matches, or an author of this name");
    expect(row("David Stark").querySelector(".ao-lead, .ao-find__lead")).toBeNull();
    // Without the offer: no such words, no such button.
    expect(stateText(row("Ann Swidler, Talk of Love"))).toBe("1 possible match");
    await user.click(screen.getByRole("button", { name: "Choose: “Ann Swidler, Talk of Love”" }));
    let d = await screen.findByRole("dialog");
    expect(within(d).queryByRole("button", { name: /Show this author's works/ })).toBeNull();
    expect(d.textContent).not.toContain("may also be an author");
    await user.keyboard("{Escape}");
    // With it: the sentence and the button, below the candidates and above "Use this one".
    await user.click(screen.getByRole("button", { name: "Choose: “David Stark”" }));
    d = await screen.findByRole("dialog");
    expect(d.textContent).toContain("“David Stark” may also be an author.");
    const show_ = within(d).getByRole("button", { name: "Show this author's works: “David Stark”" });
    const order = [...d.querySelectorAll("input[type=radio], button")];
    expect(order.indexOf(show_)).toBeGreaterThan(order.indexOf(within(d).getByRole("radio", { name: "None of these" })));
    expect(order.indexOf(show_)).toBeLessThan(order.indexOf(within(d).getByRole("button", { name: "Use this one" })));
    await user.click(show_);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(body).toBe("");
    const call = calls.find((c) => c.path === `/projects/${PID}/find/${a.id}/author`)!;
    expect(call).toEqual({ method: "POST", path: `/projects/${PID}/find/${a.id}/author`, body: undefined });
    await waitFor(() => expect(stateText(row("Author: David Stark"))).toBe("2 people match"));
    await waitFor(() => expect(document.activeElement).toBe(within(row("Author: David Stark")).getByRole("button", { name: "Choose the person: “David Stark”" })));
  });

  it("R279: a 409 for Show this author's works is said in the dialog and changes nothing", async () => {
    const a = offered();
    useService({ queues: { [PID]: queue([a]) } });
    server.use(http.post(url(`/projects/${PID}/find/${a.id}/author`), () => refusal(409, "CONFLICT", "This entry has no author to show.", "entry-state")));
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Choose: “David Stark”" }));
    const d = await screen.findByRole("dialog");
    await user.click(within(d).getByRole("button", { name: "Show this author's works: “David Stark”" }));
    expect((await within(d).findByRole("alert")).textContent).toBe("This entry has no author to show.");
    expect(screen.getByRole("dialog")).toBe(d);
    expect(stateText(row("David Stark"))).toBe("2 possible matches, or an author of this name");
  });

  it("the contract: POST …/:eid/author with no body", async () => {
    const E = "0190a000-0000-7000-8000-0000000000e9";
    const seen: Array<{ method: string; path: string; body: string; query: string }> = [];
    server.use(
      http.all(url("/*"), async ({ request }) => {
        const u = new URL(request.url);
        seen.push({ method: request.method, path: u.pathname, body: await request.text(), query: u.search });
        return HttpResponse.json(entry());
      }),
    );
    await findApi(testClient()).author(PID, E);
    expect(seen).toEqual([{ method: "POST", path: `/projects/${PID}/find/${E}/author`, body: "", query: "" }]);
  });
});

describe("FindAcquire: round 3 (R291, R287 c)", () => {
  const ON = "The service did not answer in time. “Check everything I have” is on.";
  const NOT_SENT = "Nothing was added. The text is kept: press “Add” to add it with the switch as it is now.";
  const screenGets = () => calls.filter((c) => c.method === "GET" && c.path === "/find/screen").length;
  const sw = () => screen.getByRole("switch", { name: "Check everything I have" }) as HTMLInputElement;
  const fake = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

  it("N1 (Q1): a change the service STORED but never answered: after the give-up the settings are read before anything else; the switch shows ON, it is said once, and the waiting reference is added once, after that read", async () => {
    useService();
    let posts = 0;
    let gets = 0;
    const reread = held<void>();
    server.use(
      http.put(url("/find/screen"), async ({ request }) => {
        screenSettings = (await request.json()) as FindScreenSettings;
        return new Promise<Response>(() => {});
      }),
      http.get(url("/find/screen"), async () => {
        if (++gets > 1) await reread.p;
        return HttpResponse.json(screenSettings);
      }),
      http.post(url(`/projects/${PID}/find`), () => {
        posts++;
        return HttpResponse.json({ added: [entry({ typed: "Weber" })], mergedLines: 0 });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    await user.type(box(), "Weber");
    const h = heard();
    fake();
    try {
      fireEvent.click(sw());
      await vi.advanceTimersByTimeAsync(10);
      fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
      await vi.advanceTimersByTimeAsync(SWITCH_TIMEOUT_MS + 1_000);
      // The read is out: the switch and Add are busy exactly as while the change was out, and nothing is sent.
      expect(gets).toBe(2);
      expect(sw().checked).toBe(true);
      expect(sw().getAttribute("aria-busy")).toBe("true");
      expect(box().readOnly).toBe(true);
      expect(screen.getByRole("button", { name: "Adding…" }).getAttribute("aria-busy")).toBe("true");
      expect(posts).toBe(0);
      reread.release();
      await vi.advanceTimersByTimeAsync(50);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(posts).toBe(1));
    expect(sw().checked).toBe(true);
    expect(sw().getAttribute("aria-busy")).toBeNull();
    const swIds = (sw().getAttribute("aria-describedby") ?? "").split(" ");
    expect(swIds.map((i) => document.getElementById(i)?.textContent)).toContain(ON);
    await waitFor(() => expect(box().value).toBe(""));
    // Said once, at the head of the add's result (one message: neither can replace the other unheard).
    await waitFor(() => expect(h.said.filter((x) => x.includes(ON))).toEqual([`${ON} Added 1 reference.`]));
    expect(screen.queryByText(/could not be changed/)).toBeNull();
    h.stop();
  });

  it("N1: with no add waiting, the sentence for what the service holds is said once by itself", async () => {
    useService();
    server.use(
      http.put(url("/find/screen"), async ({ request }) => {
        screenSettings = (await request.json()) as FindScreenSettings;
        return new Promise<Response>(() => {});
      }),
    );
    show();
    await waitFor(() => expect(box().disabled).toBe(false));
    const h = heard();
    fake();
    try {
      fireEvent.click(sw());
      await vi.advanceTimersByTimeAsync(SWITCH_TIMEOUT_MS + 1_000);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(sw().getAttribute("aria-busy")).toBeNull());
    expect(sw().checked).toBe(true);
    await waitFor(() => expect(h.said.filter((x) => x.includes(ON))).toEqual([ON]));
    h.stop();
  });

  it("N1: when the settings read after the give-up fails or gets no answer either, the screen is in its unreadable-settings state (the queue says what is stored) and nothing is added; the text is kept", async () => {
    for (const how of ["fails", "no answer"] as const) {
      useService();
      let posts = 0;
      let gets = 0;
      server.use(
        http.put(url("/find/screen"), async ({ request }) => {
          screenSettings = (await request.json()) as FindScreenSettings;
          return new Promise<Response>(() => {});
        }),
        http.get(url("/find/screen"), () => {
          if (++gets === 1) return HttpResponse.json(screenSettings);
          return how === "fails" ? refusal(503, "UNAVAILABLE", "This computer's Find and acquire settings could not be read.") : new Promise<Response>(() => {});
        }),
        http.get(url(`/projects/${PID}/find`), () => HttpResponse.json(queue([], { checkEverything: screenSettings.checkEverything }))),
        http.post(url(`/projects/${PID}/find`), () => {
          posts++;
          return HttpResponse.json({ added: [], mergedLines: 0 });
        }),
      );
      const user = userEvent.setup();
      const view = show();
      await waitFor(() => expect(box().disabled).toBe(false));
      await user.type(box(), "Weber");
      fake();
      try {
        fireEvent.click(sw());
        await vi.advanceTimersByTimeAsync(10);
        fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
        await vi.advanceTimersByTimeAsync(SWITCH_TIMEOUT_MS + 1_000);
        if (how === "no answer") {
          expect(sw().getAttribute("aria-busy"), how).toBe("true");
          expect(box().readOnly, how).toBe(true);
          await vi.advanceTimersByTimeAsync(SWITCH_TIMEOUT_MS + 1_000);
        }
      } finally {
        vi.useRealTimers();
      }
      await waitFor(() => expect(box().readOnly, how).toBe(false));
      expect(gets, how).toBe(2);
      // The state for settings that cannot be read (M3): its sentence, once, and the switch as the queue says.
      await waitFor(() => expect(screen.getAllByText("This computer's Find and acquire settings could not be read."), how).toHaveLength(1));
      await waitFor(() => expect(sw().checked, how).toBe(true));
      expect(sw().getAttribute("aria-busy"), how).toBeNull();
      expect(posts, how).toBe(0);
      expect(box().value, how).toBe("Weber");
      const ids = (box().getAttribute("aria-describedby") ?? "").split(" ");
      expect(ids.map((i) => document.getElementById(i)?.textContent), how).toContain(NOT_SENT);
      view.unmount();
    }
  });

  it("N1: the settings read after the give-up leaves no timer and changes nothing late when the screen is unmounted or another library opens", async () => {
    for (const how of ["unmount", "library"] as const) {
      useService();
      let posts = 0;
      let gets = 0;
      const reread = held<void>();
      server.use(
        http.put(url("/find/screen"), () => new Promise<Response>(() => {})),
        http.get(url("/find/screen"), async () => {
          if (++gets === 2) await reread.p;
          return HttpResponse.json(screenSettings);
        }),
        http.post(url(`/projects/${PID}/find`), () => {
          posts++;
          return HttpResponse.json({ added: [], mergedLines: 0 });
        }),
      );
      const user = userEvent.setup();
      const view = show();
      await waitFor(() => expect(box().disabled).toBe(false));
      await waitFor(() => expect(events.open()).toBe(true));
      if (how === "library") events.push({ type: "library.state", data: { open: true, libraryId: "lib-1", name: "L", mode: "read-write" } });
      await user.type(box(), "Weber");
      fake();
      const set = vi.spyOn(globalThis, "setTimeout");
      const cleared = vi.spyOn(globalThis, "clearTimeout");
      try {
        fireEvent.click(sw());
        await vi.advanceTimersByTimeAsync(10);
        fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
        await vi.advanceTimersByTimeAsync(SWITCH_TIMEOUT_MS + 1_000);
        expect(gets, how).toBe(2);
        const limits = set.mock.calls.map((c, i) => ({ ms: c[1], id: set.mock.results[i]!.value })).filter((x) => x.ms === SWITCH_TIMEOUT_MS);
        expect(limits.length, how).toBe(2);
        const readLimit = limits[1]!.id;
        if (how === "unmount") view.unmount();
        else events.push({ type: "library.state", data: { open: true, libraryId: "lib-2", name: "L2", mode: "read-write" } });
        for (let i = 0; i < 20 && !cleared.mock.calls.some((c) => c[0] === readLimit); i++) await vi.advanceTimersByTimeAsync(5);
        expect(cleared.mock.calls.some((c) => c[0] === readLimit), how).toBe(true);
        const before = calls.length;
        reread.release();
        await vi.advanceTimersByTimeAsync(SWITCH_TIMEOUT_MS * 2);
        expect(posts, how).toBe(0);
        if (how === "unmount") expect(calls.length, how).toBe(before);
      } finally {
        set.mockRestore();
        cleared.mockRestore();
        vi.useRealTimers();
      }
      if (how === "library") {
        // The new library's screen: nothing of the old change is shown or said.
        await waitFor(() => expect(sw().getAttribute("aria-busy")).toBeNull());
        expect(screen.queryByText(ON)).toBeNull();
        expect(sw().checked).toBe(false);
      }
      view.unmount();
    }
  });

  it("N2 (Q2): an event about the same library while the settings cannot be read keeps the dialog, focus and the draft, and asks for the settings once more; another library still resets everything", async () => {
    const e = entry({ typed: "vague", state: "choose", candidates: [cand({ id: "c1" })] });
    useService({ queues: { [PID]: queue([e]) } });
    server.use(http.get(url("/find/screen"), () => refusal(500, "INTERNAL", "Something went wrong.")));
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(events.open()).toBe(true));
    await waitFor(() => expect(screen.getAllByText("Something went wrong.")).toHaveLength(1));
    await user.type(box(), "a draft");
    await user.click(screen.getByRole("button", { name: "Choose: “vague”" }));
    const d = await screen.findByRole("dialog");
    const focused = document.activeElement;
    expect(d.contains(focused)).toBe(true);
    const before = screenGets();
    for (let k = 1; k <= 2; k++) {
      events.push({ type: "library.state", data: { open: true, libraryId: "lib-1", name: "L", mode: "read-write" } });
      await waitFor(() => expect(screenGets()).toBe(before + k));
      await new Promise((r) => setTimeout(r, 100));
      expect(screen.getByRole("dialog")).toBe(d);
      expect(document.activeElement).toBe(focused);
      expect(box().value).toBe("a draft");
    }
    expect(screenGets()).toBe(before + 2);
    // Another library: the full reset, as before.
    events.push({ type: "library.state", data: { open: true, libraryId: "lib-2", name: "L2", mode: "read-write" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Find and acquire" })));
    // The new library is read afresh (and the test ends only when those reads are done).
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(calls.filter((c) => c.path === `/projects/${PID}/collections`).length).toBeGreaterThanOrEqual(2));
  });

  it("N3 b (R291 d): after “This entry has no author to show.” the dialog drops its offer of the author, keeps the works, and focus goes to its first remaining control", async () => {
    const a = entry({ typed: "David Stark", state: "choose", candidates: [cand({ id: "c1", title: "Stark, (a reference entry)" }), cand({ id: "c2" })], authorOffer: { peopleCount: 2 } });
    useService({ queues: { [PID]: queue([a]) } });
    let chose: unknown;
    server.use(
      http.post(url(`/projects/${PID}/find/${a.id}/author`), () => refusal(409, "CONFLICT", FIND_ROUTE_TEXT.noAuthor, "no-author")),
      http.post(url(`/projects/${PID}/find/${a.id}/choose`), async ({ request }) => {
        chose = await request.json();
        return HttpResponse.json({ ...a, state: "record-complete", chosen: "c2", sourceId: SID, updatedAt: "2026-11-13T11:00:00.000Z" });
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Choose: “David Stark”" }));
    const d = await screen.findByRole("dialog");
    await user.click(within(d).getByRole("button", { name: "Show this author's works: “David Stark”" }));
    await waitFor(() => expect(within(d).queryByRole("button", { name: /Show this author's works/ })).toBeNull());
    expect(d.textContent).not.toContain("may also be an author");
    expect(within(d).getByRole("alert").textContent).toBe("This entry has no author to show.");
    expect(document.activeElement).toBe(within(d).getAllByRole("radio")[0]);
    // The works are still there and can be chosen.
    expect(within(d).getAllByRole("radio")).toHaveLength(3);
    await user.click(within(d).getAllByRole("radio")[1]!);
    await user.click(within(d).getByRole("button", { name: "Use this one" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(chose).toEqual({ candidateId: "c2" });
  });

  it("R287 c: a “choose” entry whose people could not be looked up offers Try again after Choose and before Remove, with the service's sentence; the press sends the retry and the row follows it", async () => {
    const p = entry({ typed: "Ann Swidler", state: "choose", candidates: [cand({ id: "c1" })], reason: { code: "people-unavailable" } });
    const q = entry({ typed: "no reason", state: "choose", candidates: [cand({ id: "c1" })] });
    const r = entry({ typed: "another reason", state: "choose", candidates: [cand({ id: "c1" })], reason: { code: "unexpected" } });
    useService({ queues: { [PID]: queue([p, q, r]) } });
    const answer = held<void>();
    server.use(
      http.post(url(`/projects/${PID}/find/${p.id}/retry`), async () => {
        await answer.p;
        const next: FindEntryView = { ...p, state: "looking-up", updatedAt: "2026-11-13T11:00:00.000Z" };
        delete next.reason;
        queues[PID] = queue([next, q, r]);
        return HttpResponse.json(next);
      }),
    );
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const names = (t: string) => within(row(t)).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names("Ann Swidler")).toEqual(["Choose: “Ann Swidler”", "Try again: “Ann Swidler”", "Remove from the queue: “Ann Swidler”"]);
    expect(row("Ann Swidler").querySelector(".ao-find__reason")?.textContent).toBe(FIND_REASON_TEXT["people-unavailable"]);
    expect(names("no reason")).toEqual(["Choose: “no reason”", "Remove from the queue: “no reason”"]);
    expect(names("another reason")).toEqual(["Choose: “another reason”", "Remove from the queue: “another reason”"]);
    const h = heard();
    const before = calls.length;
    await user.click(within(row("Ann Swidler")).getByRole("button", { name: "Try again: “Ann Swidler”" }));
    const busy = within(row("Ann Swidler")).getByRole("button", { name: "Trying again…: “Ann Swidler”" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    answer.release();
    await waitFor(() => expect(row("Ann Swidler").querySelector(".ao-find__state")?.textContent).toBe("Looking it up"));
    expect(calls.slice(before).filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/projects/${PID}/find/${p.id}/retry`, body: undefined }]);
    await waitFor(() => expect(document.activeElement).toBe(within(row("Ann Swidler")).getByRole("button", { name: "Remove from the queue: “Ann Swidler”" })));
    await waitFor(() => expect(h.said.join(" | ")).toContain("“Ann Swidler”: Looking it up."));
    h.stop();
  });
});

describe("FindAcquire: the copy part (F11; R282, R296, R301, R303)", () => {
  type Case = { typed: string; o: Partial<FindEntryView>; phrase: string; sentence?: string; controls: string[] };
  const T = (s: string) => `“${s}”`;
  const tryAgain = (t: string) => `Try again: ${T(t)}`;
  const open = (t: string) => `Open: ${T(t)}`;
  const removeIt = (t: string) => `Remove from the queue: ${T(t)}`;
  const check = (t: string) => `Check the file: ${T(t)}`;
  const withSource = (o: Partial<FindEntryView>): Partial<FindEntryView> => ({ sourceId: SID, chosen: "c1", candidates: [cand({ id: "c1" })], ...o });
  const rc = (code: string) => withSource({ state: "record-complete", reason: { code: code as never } });
  const nc = (code: string) => withSource({ state: "needs-check", reason: { code: code as never } });
  const noc = (code?: string) => withSource({ state: "no-open-copy", ...(code ? { reason: { code: code as never } } : {}) });
  // The engine's list ("What the screens must now show"): every state and reason, its phrase, its sentence, exactly its controls.
  const cases: Case[] = [
    ...["copy-not-allowed", "copy-store-not-allowed", "copy-no-legal-basis", "held-full"].map((code) => ({ typed: `rc ${code}`, o: rc(code), phrase: "Record complete", sentence: FIND_REASON_TEXT[code as keyof typeof FIND_REASON_TEXT], controls: ["try", "open", "remove"] })),
    // R326: "Try again" looks at the Search sources settings again.
    { typed: "rc switched-off", o: withSource({ state: "record-complete", reason: { code: "switched-off", by: "settings" } }), phrase: "Record complete", sentence: FIND_REASON_TEXT["switched-off"], controls: ["try", "open", "remove"] },
    { typed: "rc plain", o: withSource({ state: "record-complete" }), phrase: "Record complete", controls: ["open", "remove"] },
    { typed: "looking for copy", o: withSource({ state: "looking-for-copy" }), phrase: "Looking for a copy", controls: ["open", "remove"] },
    { typed: "copy next try", o: withSource({ state: "looking-for-copy", nextTryAt: "2026-11-14T12:00:00.000Z" }), phrase: "Looking for a copy", controls: ["try", "open", "remove"] },
    { typed: "fetching", o: withSource({ state: "fetching" }), phrase: "Fetching", controls: ["open", "remove"] },
    ...["file-looks-right", "file-other-doi", "file-title-absent", "file-no-text", "file-other-version", "file-other-kind"].map((code) => ({ typed: `nc ${code}`, o: nc(code), phrase: "Needs your check", sentence: FIND_REASON_TEXT[code as keyof typeof FIND_REASON_TEXT], controls: ["check", "open", "remove"] })),
    { typed: "no copy", o: noc(), phrase: "No open copy", controls: ["open", "remove"] },
    { typed: "no copy unreachable", o: noc("copy-some-unreachable"), phrase: "No open copy", sentence: FIND_REASON_TEXT["copy-some-unreachable"], controls: ["try", "open", "remove"] },
    { typed: "no copy not this file", o: noc("not-this-file"), phrase: "No open copy", sentence: FIND_REASON_TEXT["not-this-file"], controls: ["open", "remove"] },
    { typed: "no copy removed", o: noc("record-removed"), phrase: "No open copy", sentence: FIND_REASON_TEXT["record-removed"], controls: ["remove"] },
    { typed: "failed unreachable", o: withSource({ state: "failed", reason: { code: "unreachable" } }), phrase: `Could not be done: ${FIND_REASON_TEXT.unreachable}`, controls: ["try", "remove"] },
    { typed: "failed unexpected", o: withSource({ state: "failed", reason: { code: "unexpected" } }), phrase: `Could not be done: ${FIND_REASON_TEXT.unexpected}`, controls: ["try", "remove"] },
    { typed: "failed held-full", o: withSource({ state: "failed", reason: { code: "held-full" } }), phrase: `Could not be done: ${FIND_REASON_TEXT["held-full"]}`, controls: ["try", "remove"] },
    { typed: "in library", o: withSource({ state: "in-library" }), phrase: "In your library", controls: ["open", "remove"] },
    { typed: "rc unknown reason", o: rc("from-a-later-build"), phrase: "Record complete", controls: ["open", "remove"] },
  ];
  const nameOf = (kind: string, t: string) => ({ try: tryAgain, open, remove: removeIt, check })[kind]!(t);

  it("each state and reason of the copy part: its phrase, the service's sentence and exactly its controls", async () => {
    useService({ queues: { [PID]: queue(cases.map((c) => entry({ typed: c.typed, ...c.o }))) } });
    show();
    await waitFor(() => expect(rows()).toHaveLength(cases.length));
    for (const c of cases) {
      const r = row(c.typed);
      expect(r.querySelector(".ao-find__state")?.textContent, c.typed).toBe(c.phrase);
      const reason = r.querySelector(".ao-find__reason")?.textContent;
      // A failed entry says its sentence in its phrase; every other says it beside the phrase.
      expect(reason, c.typed).toBe(c.sentence && !c.phrase.startsWith("Could not") ? c.sentence : undefined);
      // The controls, in order, buttons and links alike; never a code in the row.
      const controls = [...r.querySelectorAll(".ao-find__actions button, .ao-find__actions a")].map((el) => el.getAttribute("aria-label"));
      expect(controls, c.typed).toEqual(c.controls.map((k) => nameOf(k, c.typed)));
      const shown = r.textContent!.replace(r.querySelector("[data-entry-text]")!.textContent!, "");
      expect(shown, c.typed).not.toMatch(/copy-|file-|held-full|not-this-file|record-removed|switched-off|from-a-later-build/u);
      // No offers were given: no "Where to get it".
      expect(r.textContent, c.typed).not.toContain("Where to get it");
    }
  });

  it("Check the file leads to that file's review entry", async () => {
    const e = entry({ typed: "a found file", ...nc("file-looks-right") });
    useService({ queues: { [PID]: queue([e]) } });
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const link = within(row("a found file")).getByRole("link", { name: "Check the file: “a found file”" });
    expect(link.textContent).toBe("Check the file");
    const want = `${PATHS.reviewQueue}?project=${encodeURIComponent(PID)}&source=${encodeURIComponent(SID)}`;
    expect(link.getAttribute("href")).toBe(want);
    await user.click(link);
    expect(`${window.location.pathname}${window.location.search}`).toBe(want);
    // The app's route table shows the review queue there, for that record's entries only.
    expect(routeFor({ pathname: window.location.pathname, search: window.location.search }, testClient())).toBeTruthy();
  });

  it("Where to get it lists the offers as links and refuses a link that is not https", async () => {
    const offers = [
      { label: "Publisher's page", url: "https://doi.org/10.5555/ao.where", host: "doi.org" },
      { label: "WorldCat", url: "http://www.worldcat.org/search?q=x", host: "www.worldcat.org" },
      { label: "Open Library", url: "javascript:alert(1)", host: "openlibrary.org" },
      { label: "A free copy may be at", url: "https://user:secret@files.example.org/a.pdf", host: "files.example.org" },
      { label: "A free copy may be at", url: "not an address", host: "nowhere" },
      { label: "Your library's catalogue", url: "https://catalogue.example.edu/search?q=Distinction", host: "<b>catalogue.example.edu</b>" },
    ] as FindEntryView["offers"];
    const refusedOnly = [{ label: "WorldCat", url: "ftp://worldcat.org/x", host: "worldcat.org" }] as FindEntryView["offers"];
    useService({
      queues: {
        [PID]: queue([
          entry({ typed: "with offers", ...noc(), offers }),
          entry({ typed: "only refused", ...noc(), offers: refusedOnly }),
          entry({ typed: "unreachable with offers", ...noc("copy-some-unreachable"), offers }),
          entry({ typed: "removed with offers", ...noc("record-removed"), offers }),
        ]),
      },
    });
    show();
    await waitFor(() => expect(rows()).toHaveLength(4));
    const list = within(row("with offers")).getByRole("list", { name: "Where to get it: “with offers”" });
    const links = within(list).getAllByRole("link");
    expect(links.map((a) => [a.getAttribute("href"), a.getAttribute("aria-label")])).toEqual([
      ["https://doi.org/10.5555/ao.where", "Publisher's page (doi.org): “with offers”"],
      // R313 h: the host named is the address's own, never the one the service sent.
      ["https://catalogue.example.edu/search?q=Distinction", "Your library's catalogue (catalogue.example.edu): “with offers”"],
    ]);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    // Label and host are outside text (UserText): markup is shown as text.
    expect(list.querySelector("b")).toBeNull();
    expect(links[1]!.querySelectorAll("[dir=auto]").length).toBeGreaterThan(0);
    expect(row("with offers").textContent).toContain("Where to get it");
    expect(queueList().innerHTML).not.toMatch(/javascript:|secret|ftp:|http:\/\/www\.worldcat/u);
    // Nothing left after the refusals: no "Where to get it".
    expect(row("only refused").textContent).not.toContain("Where to get it");
    expect(within(row("only refused")).queryAllByRole("link")).toHaveLength(0);
    // Beside Try again; and never on a record that was removed.
    expect(within(row("unreachable with offers")).getAllByRole("link")).toHaveLength(2);
    expect(row("removed with offers").textContent).not.toContain("Where to get it");
    expect(within(row("removed with offers")).queryAllByRole("link")).toHaveLength(0);
  });

  describe("R311 a, R340 d: in the desktop app, Where to get it is never a dead link", () => {
    const offers = [
      { label: "Publisher's page", url: "https://doi.org/10.5555/ao.where", host: "doi.org" },
      { label: "WorldCat", url: "http://www.worldcat.org/search?q=x", host: "www.worldcat.org" },
      { label: "Open Library", url: "javascript:alert(1)", host: "openlibrary.org" },
      { label: "Your library's catalogue", url: "https://catalogue.example.edu/search?q=Distinction", host: "<b>catalogue.example.edu</b>" },
    ] as FindEntryView["offers"];
    const stubClipboard = (fail = false) => {
      const writeText = vi.fn(async (_: string) => {
        if (fail) throw new Error("denied");
      });
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      return writeText;
    };
    beforeEach(() => {
      fake.shell = fakeShell();
    });
    afterEach(() => {
      Reflect.deleteProperty(navigator, "clipboard");
    });

    // R340 d changed this test: each place now has "Open in my browser" beside "Copy address", so R311's line "Paste an
    // address into your browser." above the list (written for a list that could only be copied) is gone.
    it("each place is its label and host with Open in my browser and Copy address; no link; a press copies exactly that address and says so once, focus kept", async () => {
      useService({ queues: { [PID]: queue([entry({ typed: "with offers", ...noc(), offers })]) } });
      const user = userEvent.setup(); // installs its own clipboard: stubbed after it
      const writeText = stubClipboard();
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      const r = row("with offers");
      const list = within(r).getByRole("list", { name: "Where to get it: “with offers”" });
      expect(within(r).queryAllByRole("link").filter((a) => a.getAttribute("data-act") !== "check")).toHaveLength(0);
      expect(r.querySelector("a[target=_blank]")).toBeNull();
      expect(r.textContent).not.toContain("Paste an address into your browser.");
      expect(within(list).getAllByRole("button", { name: /^Open in my browser: / }).map((b) => b.getAttribute("aria-label"))).toEqual([
        "Open in my browser: Publisher's page (doi.org): “with offers”",
        "Open in my browser: Your library's catalogue (catalogue.example.edu): “with offers”",
      ]);
      const copies = within(list).getAllByRole("button", { name: /^Copy address: / });
      // R318 e: each Copy address is named with its row, as the links are.
      expect(copies.map((b) => b.getAttribute("aria-label"))).toEqual([
        "Copy address: Publisher's page (doi.org): “with offers”",
        "Copy address: Your library's catalogue (catalogue.example.edu): “with offers”",
      ]);
      for (const b of copies) expect(b.textContent).toBe("Copy address");
      // Label and host shown as outside text (UserText): markup stays text.
      expect(list.querySelector("b")).toBeNull();
      expect(list.querySelectorAll("[dir=auto]").length).toBeGreaterThan(0);
      expect(r.innerHTML).not.toMatch(/javascript:|http:\/\/www\.worldcat|openlibrary/u);
      await user.click(copies[1]!);
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      expect(writeText).toHaveBeenCalledWith("https://catalogue.example.edu/search?q=Distinction");
      await waitFor(() => expect(within(r).getAllByText("Address copied.")).toHaveLength(1));
      expect(within(r).getByText("Address copied.").closest("[aria-live=polite]")).toBeTruthy();
      expect(document.activeElement).toBe(copies[1]);
    });

    it("R315 c: a copy that fails shows that place's address as text to select, with the sentence, once; focus kept", async () => {
      useService({ queues: { [PID]: queue([entry({ typed: "with offers", ...noc(), offers })]) } });
      const user = userEvent.setup();
      stubClipboard(true);
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      const r = row("with offers");
      const [first, second] = within(r).getAllByRole("button", { name: /^Copy address: / });
      await user.click(first!);
      const SAID = "Copying did not work here. Select the address and copy it.";
      await waitFor(() => expect(within(r).getAllByText(SAID)).toHaveLength(1));
      // Under that place, not another: the address itself, as outside text, never a link.
      const place = first!.closest("li")!;
      expect(within(place).getByText(SAID)).toBeTruthy();
      const address = within(place).getByText("https://doi.org/10.5555/ao.where");
      expect(address.closest("[dir=auto]")).toBeTruthy();
      expect(address.closest("a")).toBeNull();
      expect(within(second!.closest("li")!).queryByText(/catalogue\.example\.edu\/search/u)).toBeNull();
      expect(within(r).queryByText("Address copied.")).toBeNull();
      expect(document.activeElement).toBe(first);
    });

    it("R313 h: an offer whose host says one site and whose address leads to another is named by the address's host", async () => {
      const lying = [{ label: "Publisher's page", url: "https://evil.example.net/a.pdf", host: "doi.org" }] as FindEntryView["offers"];
      useService({ queues: { [PID]: queue([entry({ typed: "lying offer", ...noc(), offers: lying })]) } });
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      const r = row("lying offer");
      expect(within(r).getByRole("button", { name: "Copy address: Publisher's page (evil.example.net): “lying offer”" })).toBeTruthy();
      expect(within(r).getByText("evil.example.net")).toBeTruthy();
      expect(r.textContent).not.toContain("doi.org");
    });

    it("in a browser the links stay (no Copy address, no hint)", async () => {
      fake.shell = undefined;
      useService({ queues: { [PID]: queue([entry({ typed: "with offers", ...noc(), offers })]) } });
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      const r = row("with offers");
      expect(within(r).queryAllByRole("button", { name: /^Copy address/ })).toHaveLength(0);
      expect(r.textContent).not.toContain("Paste an address into your browser.");
      expect(within(within(r).getByRole("list", { name: "Where to get it: “with offers”" })).getAllByRole("link")).toHaveLength(2);
    });

    it("R313 h: in a browser too, the link is named by the host its address leads to", async () => {
      fake.shell = undefined;
      const lying = [{ label: "Publisher's page", url: "https://evil.example.net/a.pdf", host: "doi.org" }] as FindEntryView["offers"];
      useService({ queues: { [PID]: queue([entry({ typed: "lying offer", ...noc(), offers: lying })]) } });
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      const r = row("lying offer");
      const link = within(r).getByRole("link", { name: "Publisher's page (evil.example.net): “lying offer”" });
      expect(link.getAttribute("href")).toBe("https://evil.example.net/a.pdf");
      expect(r.textContent).not.toContain("doi.org");
    });
  });

  it("a row's change to needs-check is said once", async () => {
    const e = entry({ typed: "Bourdieu, Distinction 1984", ...withSource({ state: "fetching" }) });
    useService({ queues: { [PID]: queue([e]) } });
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(events.open()).toBe(true));
    const h = heard();
    queues[PID] = queue([{ ...e, state: "needs-check", reason: { code: "file-looks-right" }, updatedAt: "2026-11-13T11:00:00.000Z" }]);
    events.push(...Array.from({ length: 5 }, () => ({ type: "find.progress", data: { projectId: PID, entryId: e.id, state: "needs-check" } })));
    await waitFor(() => expect(row("Bourdieu, Distinction 1984").querySelector(".ao-find__state")?.textContent).toBe("Needs your check"));
    await new Promise((r) => setTimeout(r, 100));
    expect(h.said.filter((s) => s === "“Bourdieu, Distinction 1984”: Needs your check.")).toHaveLength(1);
    expect(row("Bourdieu, Distinction 1984").querySelector(".ao-find__reason")?.textContent).toBe(FIND_REASON_TEXT["file-looks-right"]);
    h.stop();
  });

  it("Try again on a record waiting for a place among the waiting files sends one retry", async () => {
    const e = entry({ typed: "waiting for a place", ...rc("held-full") });
    useService({ queues: { [PID]: queue([e]) } });
    server.use(http.post(url(`/projects/${PID}/find/${e.id}/retry`), () => HttpResponse.json({ ...e, state: "looking-for-copy", reason: undefined, updatedAt: "2026-11-13T11:00:00.000Z" })));
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const before = calls.length;
    await user.dblClick(within(row("waiting for a place")).getByRole("button", { name: "Try again: “waiting for a place”" }));
    await waitFor(() => expect(row("waiting for a place").querySelector(".ao-find__state")?.textContent).toBe("Looking for a copy"));
    expect(calls.slice(before).filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/projects/${PID}/find/${e.id}/retry`, body: undefined }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Task F18b (R340 a–d): "Get through my library", the waiting row, the shell's events. Requests against F15's start and
// cancel (apps/library-service/src/routes/your-library.ts: no body; `{ url, ticket }`; 409 with a `reason`; the cancel
// answers the entry's view, 409 "entry-state" when it no longer waits) and the shell as F16's bridge gives it.

describe("FindAcquire: Get through my library (F18b; R340)", () => {
  const TICKET = "0123456789abcdef0123456789abcdef";
  const OTHER_TICKET = "fedcba9876543210fedcba9876543210";
  const LIB_URL = "https://ezproxy.lib.example.edu/login?url=https://doi.org/10.5555/ao.through.zq7";
  const T = (s: string) => `“${s}”`;
  const withSource = (o: Partial<FindEntryView>): Partial<FindEntryView> => ({ sourceId: SID, chosen: "c1", candidates: [cand({ id: "c1" })], ...o });
  const noc = (o: Partial<FindEntryView> = {}): Partial<FindEntryView> => withSource({ state: "no-open-copy", ...o });
  const startable = (o: Partial<FindEntryView> = {}) => noc({ library: { canStart: true }, ...o });
  const waiting = (o: Partial<FindEntryView> = {}) => withSource({ state: "waiting-sign-in", ...o });
  const later = (v: FindEntryView, o: Partial<FindEntryView>, at = "2026-11-13T11:00:00.000Z"): FindEntryView => {
    const next = { ...v, ...o, updatedAt: at } as FindEntryView;
    for (const k of Object.keys(o) as Array<keyof FindEntryView>) if (o[k] === undefined) delete next[k];
    return next;
  };
  const posts = (suffix: string) => calls.filter((c) => c.method === "POST" && c.path.endsWith(suffix));
  const say = async (e: LibraryWindowEvent) => {
    await waitFor(() => expect(fake.shell!.onLibraryWindow).toHaveBeenCalled());
    act(() => fake.shell!.libraryWindow(e));
  };
  const btn = (typed: string, name: string) => within(row(typed)).getByRole("button", { name: `${name}: ${T(typed)}` });
  const libLine = (typed: string) => row(typed).querySelector(".ao-find__library-text")?.textContent ?? undefined;
  const note = (typed: string) => row(typed).querySelector(".ao-find__library-note")?.textContent ?? undefined;
  /** The queue as the service holds it now (changed by the tests as the service would change it). */
  let current: FindEntryView[];
  function serve(entries: FindEntryView[], o: { start?: () => Response | Promise<Response>; cancel?: (eid: string) => Response | Promise<Response> } = {}) {
    current = entries;
    useService({ queues: { [PID]: () => HttpResponse.json(queue(current)) } });
    server.use(
      http.post(url("/projects/:id/find/:eid/library/start"), () => (o.start ? o.start() : HttpResponse.json({ url: LIB_URL, ticket: TICKET }))),
      http.post(url("/projects/:id/find/:eid/library/cancel"), ({ params }) => (o.cancel ? o.cancel(String(params.eid)) : refusal(409, "CONFLICT", FIND_ROUTE_TEXT.entryState, "entry-state"))),
    );
  }
  /** The service's own change: the queue now holds `v` in place of its older version. */
  const becomes = (v: FindEntryView) => {
    current = current.map((x) => (x.id === v.id ? v : x));
  };

  beforeEach(() => {
    fake.shell = fakeShell();
    // As the shell does (A13): closeLibraryWindow answers nothing; the closing is reported by the event `closed` (here
    // without a ticket — at once when no window is open). R342 b waits for it before it asks the shell again.
    const shell = fake.shell;
    shell.closeLibraryWindow.mockImplementation(async () => {
      queueMicrotask(() => shell.libraryWindow({ ticket: null, state: "closed" }));
    });
  });

  type Case ={ typed: string; o: Partial<FindEntryView>; phrase: string; sentence?: string; libText?: string; controls: string[] };
  const cases: Case[] = [
    { typed: "startable", o: startable(), phrase: "No open copy", controls: ["library", "open", "remove"] },
    { typed: "startable unreachable", o: startable({ reason: { code: "copy-some-unreachable" } }), phrase: "No open copy", sentence: FIND_REASON_TEXT["copy-some-unreachable"], controls: ["try", "library", "open", "remove"] },
    { typed: "startable rules", o: withSource({ state: "record-complete", reason: { code: "copy-not-allowed" }, library: { canStart: true } }), phrase: "Record complete", sentence: FIND_REASON_TEXT["copy-not-allowed"], controls: ["try", "library", "open", "remove"] },
    { typed: "startable switched off", o: withSource({ state: "record-complete", reason: { code: "switched-off", by: "settings" }, library: { canStart: true } }), phrase: "Record complete", sentence: FIND_REASON_TEXT["switched-off"], controls: ["try", "library", "open", "remove"] },
    { typed: "no library", o: noc({ library: { canStart: false, reason: "no-library" } }), phrase: "No open copy", libText: FIND_LIBRARY_TEXT.noLibrary, controls: ["open", "remove"] },
    { typed: "not offered kept", o: noc({ library: { canStart: false, reason: "not-offered", lastFile: "rules-store" } }), phrase: "No open copy", libText: FIND_LIBRARY_FILE_TEXT["rules-store"], controls: ["open", "remove"] },
    { typed: "again after a file", o: startable({ library: { canStart: true, lastFile: "not-pdf" } }), phrase: "No open copy", libText: FIND_LIBRARY_FILE_TEXT["not-pdf"], controls: ["library", "open", "remove"] },
    { typed: "a later outcome", o: startable({ library: { canStart: true, lastFile: "from-a-later-build" as never } }), phrase: "No open copy", controls: ["library", "open", "remove"] },
    { typed: "a later reason", o: noc({ library: { canStart: false, reason: "from-a-later-build" as never } }), phrase: "No open copy", controls: ["open", "remove"] },
    { typed: "no library part", o: noc(), phrase: "No open copy", controls: ["open", "remove"] },
    { typed: "not startable true", o: noc({ library: { canStart: "yes" as never } }), phrase: "No open copy", controls: ["open", "remove"] },
    { typed: "waiting", o: waiting(), phrase: "Waiting for you in the sign-in window", controls: ["take", "cancel", "open", "remove"] },
    { typed: "back unfinished", o: noc({ reason: { code: "library-unfinished" }, library: { canStart: true } }), phrase: "No open copy", sentence: FIND_REASON_TEXT["library-unfinished"], controls: ["library", "open", "remove"] },
  ];
  const NAMES: Record<string, string> = { try: "Try again", library: "Get through my library", open: "Open", remove: "Remove from the queue", take: "Add the PDF showing in the sign-in window", cancel: "Cancel" };

  it("the table: each library part of the view gives its phrase, the service's sentence and exactly its controls (the screen works out nothing)", async () => {
    serve(cases.map((c) => entry({ typed: c.typed, ...c.o })));
    show();
    await waitFor(() => expect(rows()).toHaveLength(cases.length));
    for (const c of cases) {
      const r = row(c.typed);
      expect(r.querySelector(".ao-find__state")?.textContent, c.typed).toBe(c.phrase);
      expect(r.querySelector(".ao-find__reason")?.textContent, c.typed).toBe(c.sentence);
      expect(libLine(c.typed), c.typed).toBe(c.libText);
      const controls = [...r.querySelectorAll(".ao-find__actions button, .ao-find__actions a")].map((el) => el.getAttribute("aria-label"));
      expect(controls, c.typed).toEqual(c.controls.map((k) => `${NAMES[k]}: ${T(c.typed)}`));
      // In the desktop app no control is shown unavailable, and no code is shown.
      for (const b of r.querySelectorAll(".ao-find__actions button")) expect(b.getAttribute("aria-disabled"), c.typed).toBeNull();
      expect(r.textContent, c.typed).not.toMatch(/Only in the desktop app|not-offered|no-library|rules-store|not-pdf|from-a-later-build/u);
    }
    // "No library": the service's sentence and a link to the Your library screen (outside the row's acts).
    const link = within(row("no library")).getByRole("link", { name: `Your library: ${T("no library")}` });
    expect(link.textContent).toBe("Your library");
    expect(link.getAttribute("href")).toBe(PATHS.yourLibrary);
    expect(link.closest(".ao-find__actions")).toBeNull();
    for (const c of cases.filter((x) => x.typed !== "no library")) expect(within(row(c.typed)).queryByRole("link", { name: /^Your library/ }), c.typed).toBeNull();
    // Nothing was asked of the service or the shell by showing the rows.
    expect(posts("/library/start")).toHaveLength(0);
    expect(fake.shell!.openLibraryWindow).not.toHaveBeenCalled();
  });

  it("the link Your library leads to the settings screen", async () => {
    serve([entry({ typed: "no library", ...noc({ library: { canStart: false, reason: "no-library" } }) })]);
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(within(row("no library")).getByRole("link", { name: /^Your library/ }));
    expect(window.location.pathname).toBe(PATHS.yourLibrary);
  });

  it("R340 d: a row resting Record complete shows Where to get it when its view carries links", async () => {
    const offers = [{ label: "Publisher's page", url: "https://doi.org/10.5555/ao.rc", host: "doi.org" }] as FindEntryView["offers"];
    serve([entry({ typed: "rc with offers", ...withSource({ state: "record-complete", reason: { code: "copy-not-allowed" }, offers, library: { canStart: true } }) })]);
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const list = within(row("rc with offers")).getByRole("list", { name: `Where to get it: ${T("rc with offers")}` });
    expect(within(list).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      `Open in my browser: Publisher's page (doi.org): ${T("rc with offers")}`,
      `Copy address: Publisher's page (doi.org): ${T("rc with offers")}`,
    ]);
  });

  it("a press: ONE start with no body; the shell opens the window with exactly the ticket and the address; the row follows the service", async () => {
    const e = entry({ typed: "through", ...startable() });
    serve([e], {
      start: () => {
        becomes(later(e, { state: "waiting-sign-in", library: undefined }));
        return HttpResponse.json({ url: LIB_URL, ticket: TICKET });
      },
    });
    fake.shell!.openLibraryWindow.mockResolvedValue(true);
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const h = heard();
    await user.dblClick(btn("through", "Get through my library"));
    await waitFor(() => expect(row("through").querySelector(".ao-find__state")?.textContent).toBe("Waiting for you in the sign-in window"));
    expect(posts("/library/start")).toEqual([{ method: "POST", path: `/projects/${PID}/find/${e.id}/library/start`, body: undefined }]);
    expect(fake.shell!.openLibraryWindow.mock.calls).toEqual([[TICKET, LIB_URL]]);
    expect(posts("/library/cancel")).toHaveLength(0);
    await waitFor(() => expect(h.said).toContain("“through”: Waiting for you in the sign-in window."));
    expect(within(row("through")).getByRole("button", { name: `Add the PDF showing in the sign-in window: ${T("through")}` })).toBeTruthy();
    h.stop();
  });

  for (const [how, answer] of [
    ["answers false", async () => false],
    ["throws", async () => Promise.reject(new Error("no"))],
  ] as const) {
    it(`the shell ${how}: the start is cancelled at the service and the row says so, once`, async () => {
      const e = entry({ typed: "not opened", ...startable() });
      serve([e], {
        start: () => {
          becomes(later(e, { state: "waiting-sign-in", library: undefined }));
          return HttpResponse.json({ url: LIB_URL, ticket: TICKET });
        },
        cancel: () => {
          becomes(later(e, {}, "2026-11-13T12:00:00.000Z"));
          return HttpResponse.json(current[0]);
        },
      });
      fake.shell!.openLibraryWindow.mockImplementation(answer);
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      const h = heard();
      const b = btn("not opened", "Get through my library");
      await user.click(b);
      const SAID = "The sign-in window could not be opened. Nothing was changed.";
      await waitFor(() => expect(note("not opened")).toBe(SAID));
      expect(posts("/library/cancel")).toEqual([{ method: "POST", path: `/projects/${PID}/find/${e.id}/library/cancel`, body: undefined }]);
      expect(row("not opened").querySelector(".ao-find__state")?.textContent).toBe("No open copy");
      await waitFor(() => expect(h.said.filter((s) => s.includes(SAID))).toHaveLength(1));
      await new Promise((r) => setTimeout(r, ACT_SAID_MS + 200));
      expect(h.said.filter((s) => s.includes(SAID))).toHaveLength(1);
      expect(document.activeElement).toBe(btn("not opened", "Get through my library"));
      h.stop();
    });
  }

  it("the shell gives no answer within the time limit: the start is cancelled and the row says so", async () => {
    const e = entry({ typed: "silent shell", ...startable() });
    serve([e], { cancel: () => HttpResponse.json(later(e, {})) });
    fake.shell!.openLibraryWindow.mockReturnValue(new Promise<boolean>(() => {}));
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const b = btn("silent shell", "Get through my library");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fireEvent.click(b);
      await vi.advanceTimersByTimeAsync(50);
      await vi.waitFor(() => expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(LIBRARY_SHELL_TIMEOUT_MS - 1_000);
      expect(posts("/library/cancel")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_500);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(posts("/library/cancel")).toHaveLength(1));
    await waitFor(() => expect(note("silent shell")).toBe("The sign-in window could not be opened. Nothing was changed."));
    expect(LIBRARY_SHELL_TIMEOUT_MS).toBe(60_000);
  });

  it("the cancel after a window that did not open fails: the row shows what the service then says of the entry", async () => {
    const e = entry({ typed: "cancel fails", ...startable() });
    serve([e], {
      start: () => {
        becomes(later(e, { state: "waiting-sign-in", library: undefined }));
        return HttpResponse.json({ url: LIB_URL, ticket: TICKET });
      },
      cancel: () => refusal(503, "UNAVAILABLE", FIND_ROUTE_TEXT.closed, "closed"),
    });
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(btn("cancel fails", "Get through my library"));
    await waitFor(() => expect(row("cancel fails").querySelector(".ao-find__state")?.textContent).toBe("Waiting for you in the sign-in window"));
    expect(posts("/library/cancel")).toHaveLength(1);
  });

  const REFUSALS: Array<[string, () => Response]> = [
    [FIND_LIBRARY_TEXT.busy, () => refusal(409, "CONFLICT", FIND_LIBRARY_TEXT.busy, "library-busy")],
    ["Ready in 12 seconds.", () => refusal(409, "CONFLICT", "Ready in 12 seconds.", "library-pause")],
    [FIND_LIBRARY_TEXT.heldFull, () => refusal(409, "CONFLICT", FIND_LIBRARY_TEXT.heldFull, "library-held-full")],
    [FIND_LIBRARY_TEXT.notOffered, () => refusal(409, "CONFLICT", FIND_LIBRARY_TEXT.notOffered, "library-not-offered")],
    [FIND_LIBRARY_TEXT.noLibrary, () => refusal(409, "CONFLICT", FIND_LIBRARY_TEXT.noLibrary, "no-library")],
    [FIND_ROUTE_TEXT.readOnly, () => refusal(409, "READ_ONLY", FIND_ROUTE_TEXT.readOnly, "read-only")],
    [FIND_ROUTE_TEXT.projectStopped, () => refusal(409, "CONFLICT", FIND_ROUTE_TEXT.projectStopped, "stopped")],
    [FIND_ROUTE_TEXT.closed, () => refusal(503, "UNAVAILABLE", FIND_ROUTE_TEXT.closed, "closed")],
    [FIND_ROUTE_TEXT.entryNotFound, () => refusal(404, "NOT_FOUND", FIND_ROUTE_TEXT.entryNotFound)],
  ];
  it("every refusal of the start shows the service's sentence exactly on that row, said once, focus kept on the control; no window is opened", async () => {
    const e = entry({ typed: "refused", ...startable() });
    let answer: () => Response = REFUSALS[0]![1];
    serve([e], { start: () => answer() });
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    for (const [sentence, give] of REFUSALS) {
      answer = give;
      const before = posts("/library/start").length;
      const b = btn("refused", "Get through my library");
      await user.click(b);
      await waitFor(() => expect(within(row("refused")).getByRole("alert").textContent).toBe(sentence));
      expect(within(row("refused")).getAllByRole("alert")).toHaveLength(1);
      expect(posts("/library/start").length - before).toBe(1);
      expect(document.activeElement).toBe(btn("refused", "Get through my library"));
    }
    expect(fake.shell!.openLibraryWindow).not.toHaveBeenCalled();
    expect(posts("/library/cancel")).toHaveLength(0);
  });

  it("a locked project refusing the start offers the unlock, as every act does", async () => {
    const e = entry({ typed: "locked start", ...startable() });
    serve([e], { start: () => refusal(423, "PROJECT_LOCKED", FIND_ROUTE_TEXT.locked, "locked") });
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(btn("locked start", "Get through my library"));
    expect(await screen.findByText(FIND_ROUTE_TEXT.locked)).toBeTruthy();
    expect(fake.shell!.openLibraryWindow).not.toHaveBeenCalled();
  });

  it("the second Get through my library waits out the pause and says so", async () => {
    const a = entry({ typed: "first work", ...startable() });
    const b = entry({ typed: "second work", ...startable() });
    let paused = true;
    serve([a, b], {
      start: () => {
        if (current.some((x) => x.state === "waiting-sign-in" || x.state === "needs-check") && paused) return refusal(409, "CONFLICT", "Ready in 14 seconds.", "library-pause");
        const which = current.find((x) => x.state === "no-open-copy")!;
        becomes(later(which, { state: "waiting-sign-in", library: undefined }));
        return HttpResponse.json({ url: LIB_URL, ticket: TICKET });
      },
    });
    fake.shell!.openLibraryWindow.mockResolvedValue(true);
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    // The first: through the window, handed over, waiting for the check.
    await user.click(btn("first work", "Get through my library"));
    await waitFor(() => expect(row("first work").querySelector(".ao-find__state")?.textContent).toBe("Waiting for you in the sign-in window"));
    await say({ ticket: TICKET, state: "fetching" });
    await say({ ticket: TICKET, state: "handed-over" });
    becomes(later(current[0]!, { state: "needs-check", reason: { code: "file-looks-right" } }, "2026-11-13T12:00:00.000Z"));
    events.push({ type: "find.progress", data: { projectId: PID, entryId: a.id, state: "needs-check" } });
    await waitFor(() => expect(row("first work").querySelector(".ao-find__state")?.textContent).toBe("Needs your check"));
    // The second, at once: the service says how long the pause still is; the row says so, and no window is opened.
    const second = btn("second work", "Get through my library");
    await user.click(second);
    await waitFor(() => expect(within(row("second work")).getByRole("alert").textContent).toBe("Ready in 14 seconds."));
    expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(btn("second work", "Get through my library"));
    // Pressed again once the pause is over: it goes through.
    paused = false;
    await user.click(btn("second work", "Get through my library"));
    await waitFor(() => expect(row("second work").querySelector(".ao-find__state")?.textContent).toBe("Waiting for you in the sign-in window"));
    expect(within(row("second work")).queryByRole("alert")).toBeNull();
    expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(2);
    expect(posts("/library/start")).toHaveLength(3);
  });

  it("R340 a: the ticket and the address go to the shell and nowhere else — not the page's address or history, storage, any element, the console", async () => {
    const e = entry({ typed: "kept out", ...startable() });
    serve([e], {
      start: () => {
        becomes(later(e, { state: "waiting-sign-in", library: undefined }));
        return HttpResponse.json({ url: LIB_URL, ticket: TICKET });
      },
      cancel: () => {
        becomes(later(e, {}, "2026-11-13T12:00:00.000Z"));
        return HttpResponse.json(current[0]);
      },
    });
    fake.shell!.openLibraryWindow.mockResolvedValue(true);
    fake.shell!.libraryWindowTakePdf.mockResolvedValue(true);
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((k) => vi.spyOn(console, k));
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const user = userEvent.setup();
    try {
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      const h = heard();
      const seen: string[] = [];
      const mo = new MutationObserver(() => seen.push(document.documentElement.outerHTML));
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      await user.click(btn("kept out", "Get through my library"));
      await waitFor(() => expect(row("kept out").querySelector(".ao-find__state")?.textContent).toBe("Waiting for you in the sign-in window"));
      for (const s of ["opened", "fetching", "not-a-pdf"] as const) await say({ ticket: TICKET, state: s });
      await say({ ticket: TICKET, state: "failed", reason: "pause" });
      await user.click(btn("kept out", "Add the PDF showing in the sign-in window"));
      await user.click(btn("kept out", "Cancel"));
      await waitFor(() => expect(row("kept out").querySelector(".ao-find__state")?.textContent).toBe("No open copy"));
      mo.disconnect();
      h.stop();
      seen.push(document.documentElement.outerHTML, ...h.said, window.location.href, JSON.stringify(window.history.state));
      for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i++) seen.push(store.key(i)!, store.getItem(store.key(i)!) ?? "");
      for (const sp of [...spies, pushState, replaceState]) seen.push(JSON.stringify(sp.mock.calls.map((c) => c.map(String))));
      const all = seen.join("\n");
      for (const secret of [TICKET, LIB_URL, "ezproxy.lib.example.edu", "ao.through.zq7"]) expect(all.includes(secret), secret).toBe(false);
      // The two calls to the shell that carry them, and no other (the take and the close carry nothing).
      expect(fake.shell!.openLibraryWindow.mock.calls).toEqual([[TICKET, LIB_URL]]);
      expect(fake.shell!.libraryWindowTakePdf.mock.calls).toEqual([[]]);
      expect(fake.shell!.closeLibraryWindow.mock.calls).toEqual([[]]);
      expect(fake.shell!.openInBrowser).not.toHaveBeenCalled();
      // No request after the start carries them.
      expect(JSON.stringify(calls.filter((c) => !c.path.endsWith("/library/start")))).not.toMatch(/0123456789abcdef0123456789abcdef|ezproxy/u);
    } finally {
      for (const sp of [...spies, pushState, replaceState]) sp.mockRestore();
    }
  });

  it("R340 a: nothing starts by itself — not on opening, focus, hover, time passing, the shell's events or the service's events", async () => {
    const a = entry({ typed: "can start", ...startable() });
    const w = entry({ typed: "waits", ...waiting() });
    serve([a, w]);
    fake.shell!.openLibraryWindow.mockResolvedValue(true);
    fake.shell!.libraryWindowTakePdf.mockResolvedValue(true);
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(events.open()).toBe(true));
    // Focus and hover on every control of the two rows.
    for (const b of [...row("can start").querySelectorAll("button"), ...row("waits").querySelectorAll("button")]) {
      act(() => (b as HTMLElement).focus());
      await user.hover(b);
    }
    for (const s of ["opened", "fetching", "not-a-pdf", "failed"] as const) await say({ ticket: TICKET, state: s });
    await say({ ticket: null, state: "failed", reason: "no-ticket" });
    events.push(
      { type: "find.progress", data: { projectId: PID, entryId: a.id, state: "no-open-copy" } },
      { type: "find.progress", data: { projectId: PID, entryId: w.id, state: "waiting-sign-in" } },
    );
    await new Promise((r) => setTimeout(r, 600));
    expect(posts("/library/start")).toHaveLength(0);
    expect(posts("/library/cancel")).toHaveLength(0);
    expect(fake.shell!.openLibraryWindow).not.toHaveBeenCalled();
    expect(fake.shell!.libraryWindowTakePdf).not.toHaveBeenCalled();
    expect(fake.shell!.closeLibraryWindow).not.toHaveBeenCalled();
    expect(fake.shell!.openInBrowser).not.toHaveBeenCalled();
  });

  describe("the waiting row and the shell's events (R340 b)", () => {
    /** A page that pressed "Get through my library" itself: it holds the ticket. */
    async function pressed(typed: string) {
      const e = entry({ typed, ...startable() });
      serve([e], {
        start: () => {
          becomes(later(e, { state: "waiting-sign-in", library: undefined }));
          return HttpResponse.json({ url: LIB_URL, ticket: TICKET });
        },
        cancel: () => {
          if (current[0]!.state !== "waiting-sign-in") return refusal(409, "CONFLICT", FIND_ROUTE_TEXT.entryState, "entry-state");
          becomes(later(e, {}, "2026-11-13T12:00:00.000Z"));
          return HttpResponse.json(current[0]);
        },
      });
      fake.shell!.openLibraryWindow.mockResolvedValue(true);
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      await user.click(btn(typed, "Get through my library"));
      await waitFor(() => expect(row(typed).querySelector(".ao-find__state")?.textContent).toBe("Waiting for you in the sign-in window"));
      return { e, user };
    }

    const SENTENCES: Array<[LibraryWindowEvent, string]> = [
      [{ ticket: TICKET, state: "fetching" }, "Fetching the PDF…"],
      [{ ticket: TICKET, state: "not-a-pdf" }, "That page is not a PDF. Open the PDF in the sign-in window and the app will fetch it for you to check."],
      [{ ticket: TICKET, state: "failed", reason: "pause" }, "The sign-in window rests for a few seconds between files. Try again shortly."],
      [{ ticket: TICKET, state: "failed", reason: "busy" }, "The PDF is already being fetched."],
      [{ ticket: TICKET, state: "failed" }, "The PDF could not be fetched. Try again in the sign-in window."],
      [{ ticket: TICKET, state: "failed", reason: "not-https" }, "The PDF could not be fetched. Try again in the sign-in window."],
      [{ ticket: TICKET, state: "fetching" }, "Fetching the PDF…"],
      [{ ticket: TICKET, state: "failed", reason: "sign-in-address" }, "The PDF could not be fetched. Try again in the sign-in window."],
    ];
    it("each thing the shell reports is shown on the row and said once, exactly as R340 b gives it; the phrase stays", async () => {
      await pressed("events");
      const h = heard();
      for (const [ev, sentence] of SENTENCES) {
        await say(ev);
        await waitFor(() => expect(note("events")).toBe(sentence));
        expect(row("events").querySelector(".ao-find__state")?.textContent).toBe("Waiting for you in the sign-in window");
      }
      await new Promise((r) => setTimeout(r, ACT_SAID_MS + 200));
      // Each change of what the row says is said once (two failures in a row with the same words are one sentence).
      expect(h.said.filter((s) => s === "“events”: Fetching the PDF…")).toHaveLength(2);
      expect(h.said.filter((s) => s.includes("rests for a few seconds"))).toHaveLength(1);
      expect(h.said.filter((s) => s === "“events”: The PDF is already being fetched.")).toHaveLength(1);
      expect(h.said.filter((s) => s === "“events”: The PDF could not be fetched. Try again in the sign-in window.")).toHaveLength(2);
      // No sentence says the app adds a file by itself (R301).
      for (const s of h.said) expect(s).not.toMatch(/\badd(s|ed)?\b/iu);
      h.stop();
      expect(posts("/library/cancel")).toHaveLength(0);
    });

    it("not-a-pdf says Open the PDF in the sign-in window and the app will fetch it for you to check", async () => {
      await pressed("an html page");
      await say({ ticket: TICKET, state: "not-a-pdf" });
      await waitFor(() => expect(note("an html page")).toBe("That page is not a PDF. Open the PDF in the sign-in window and the app will fetch it for you to check."));
      await waitFor(() => expect(live().textContent).toBe("“an html page”: That page is not a PDF. Open the PDF in the sign-in window and the app will fetch it for you to check."));
    });

    it("an event for another ticket changes nothing", async () => {
      await pressed("mine");
      await say({ ticket: OTHER_TICKET, state: "not-a-pdf" });
      await say({ ticket: OTHER_TICKET, state: "closed" });
      await say({ ticket: null, state: "closed" });
      await new Promise((r) => setTimeout(r, 200));
      expect(note("mine")).toBeUndefined();
      expect(posts("/library/cancel")).toHaveLength(0);
      expect(row("mine").querySelector(".ao-find__state")?.textContent).toBe("Waiting for you in the sign-in window");
    });

    it("handed-over: said, then the row follows the service — Needs your check with Check the file; a later close cancels nothing", async () => {
      const { e } = await pressed("handed");
      const h = heard();
      await say({ ticket: TICKET, state: "handed-over" });
      await waitFor(() => expect(note("handed")).toBe("The file was fetched and is being checked."));
      becomes(later(current[0]!, { state: "needs-check", reason: { code: "file-looks-right" } }, "2026-11-13T12:00:00.000Z"));
      events.push({ type: "find.progress", data: { projectId: PID, entryId: e.id, state: "needs-check" } });
      await waitFor(() => expect(row("handed").querySelector(".ao-find__state")?.textContent).toBe("Needs your check"));
      expect(within(row("handed")).getByRole("link", { name: `Check the file: ${T("handed")}` })).toBeTruthy();
      expect(note("handed")).toBeUndefined();
      await say({ ticket: null, state: "closed" });
      await new Promise((r) => setTimeout(r, ACT_SAID_MS + 200));
      expect(posts("/library/cancel")).toHaveLength(0);
      expect(h.said.filter((s) => s.includes("The file was fetched and is being checked."))).toHaveLength(1);
      expect(h.said.filter((s) => s.includes("Needs your check"))).toHaveLength(1);
      expect(h.said.join(" ")).not.toContain("The sign-in window was closed.");
      h.stop();
    });

    it("handed-over, and the file was not kept: back at rest with the service's sentence for it, and Get through my library again", async () => {
      const { e } = await pressed("not kept");
      await say({ ticket: TICKET, state: "handed-over" });
      becomes(later(current[0]!, { state: "no-open-copy", library: { canStart: true, lastFile: "too-large" } }, "2026-11-13T12:00:00.000Z"));
      events.push({ type: "find.progress", data: { projectId: PID, entryId: e.id, state: "no-open-copy" } });
      await waitFor(() => expect(row("not kept").querySelector(".ao-find__state")?.textContent).toBe("No open copy"));
      expect(libLine("not kept")).toBe(FIND_LIBRARY_FILE_TEXT["too-large"]);
      expect(btn("not kept", "Get through my library")).toBeTruthy();
      expect(note("not kept")).toBeUndefined();
    });

    it("handed-over, and the record had a file meanwhile: In your library", async () => {
      const { e } = await pressed("had a file");
      await say({ ticket: TICKET, state: "handed-over" });
      becomes(later(current[0]!, { state: "in-library" }, "2026-11-13T12:00:00.000Z"));
      events.push({ type: "find.progress", data: { projectId: PID, entryId: e.id, state: "in-library" } });
      await waitFor(() => expect(row("had a file").querySelector(".ao-find__state")?.textContent).toBe("In your library"));
    });

    it("the window closed while the entry still waits: ONE cancel at the service, the entry returns, and the row says so once", async () => {
      await pressed("closed");
      const h = heard();
      await say({ ticket: TICKET, state: "closed" });
      await waitFor(() => expect(row("closed").querySelector(".ao-find__state")?.textContent).toBe("No open copy"));
      expect(posts("/library/cancel")).toHaveLength(1);
      expect(note("closed")).toBe("The sign-in window was closed.");
      expect(within(row("closed")).queryByRole("alert")).toBeNull();
      await new Promise((r) => setTimeout(r, ACT_SAID_MS + 200));
      expect(h.said.filter((s) => s.includes("The sign-in window was closed."))).toHaveLength(1);
      expect(fake.shell!.closeLibraryWindow).not.toHaveBeenCalled();
      h.stop();
    });

    it("the window closed when the entry no longer waits (409): not an error", async () => {
      const { e } = await pressed("being checked");
      // The service is taking the file: its cancel answers 409.
      becomes(later(current[0]!, { state: "needs-check", reason: { code: "file-looks-right" } }, "2026-11-13T12:00:00.000Z"));
      await say({ ticket: TICKET, state: "closed" });
      await waitFor(() => expect(posts("/library/cancel")).toHaveLength(1));
      events.push({ type: "find.progress", data: { projectId: PID, entryId: e.id, state: "needs-check" } });
      await waitFor(() => expect(row("being checked").querySelector(".ao-find__state")?.textContent).toBe("Needs your check"));
      expect(within(row("being checked")).queryByRole("alert")).toBeNull();
    });

    it("Cancel: ONE cancel at the service; when it has answered, the window is closed; the row follows and is said", async () => {
      const { e, user } = await pressed("cancel me");
      let answered = false;
      let closedAfterAnswer: boolean | undefined;
      fake.shell!.closeLibraryWindow.mockImplementation(async () => {
        closedAfterAnswer = answered;
      });
      server.use(
        http.post(url(`/projects/${PID}/find/${e.id}/library/cancel`), () => {
          becomes(later(e, {}, "2026-11-13T12:00:00.000Z"));
          answered = true;
          return HttpResponse.json(current[0]);
        }),
      );
      const h = heard();
      await user.dblClick(btn("cancel me", "Cancel"));
      await waitFor(() => expect(row("cancel me").querySelector(".ao-find__state")?.textContent).toBe("No open copy"));
      await waitFor(() => expect(fake.shell!.closeLibraryWindow).toHaveBeenCalledTimes(1));
      expect(closedAfterAnswer).toBe(true);
      expect(posts("/library/cancel")).toEqual([{ method: "POST", path: `/projects/${PID}/find/${e.id}/library/cancel`, body: undefined }]);
      await waitFor(() => expect(h.said).toContain("“cancel me”: No open copy."));
      // The window's own close that follows changes nothing more.
      await say({ ticket: TICKET, state: "closed" });
      await new Promise((r) => setTimeout(r, 200));
      expect(posts("/library/cancel")).toHaveLength(1);
      expect(note("cancel me")).toBeUndefined();
      h.stop();
    });

    it("Cancel refused (the entry no longer waits): the service's sentence on the row; the window is closed", async () => {
      const { e, user } = await pressed("too late");
      becomes(later(current[0]!, { state: "needs-check", reason: { code: "file-looks-right" } }, "2026-11-13T12:00:00.000Z"));
      await user.click(btn("too late", "Cancel"));
      await waitFor(() => expect(within(row("too late")).getByRole("alert").textContent).toBe(FIND_ROUTE_TEXT.entryState));
      await waitFor(() => expect(fake.shell!.closeLibraryWindow).toHaveBeenCalledTimes(1));
      events.push({ type: "find.progress", data: { projectId: PID, entryId: e.id, state: "needs-check" } });
      await waitFor(() => expect(row("too late").querySelector(".ao-find__state")?.textContent).toBe("Needs your check"));
    });

    it("Add the PDF showing in the sign-in window: the shell's take, once per press, and no request to the service", async () => {
      const { user } = await pressed("take it");
      let release!: (v: boolean) => void;
      fake.shell!.libraryWindowTakePdf.mockReturnValue(new Promise<boolean>((r) => (release = r)));
      const before = calls.length;
      await user.dblClick(btn("take it", "Add the PDF showing in the sign-in window"));
      expect(fake.shell!.libraryWindowTakePdf).toHaveBeenCalledTimes(1);
      expect(fake.shell!.libraryWindowTakePdf).toHaveBeenCalledWith();
      release(true);
      await say({ ticket: TICKET, state: "fetching" });
      await waitFor(() => expect(note("take it")).toBe("Fetching the PDF…"));
      expect(calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
    });
  });

  it("a page loaded afresh holds no ticket: an event goes to the one waiting row (and closing cancels it)", async () => {
    const w = entry({ typed: "from before", ...waiting() });
    serve([w], {
      cancel: () => {
        becomes(later(w, { state: "no-open-copy", library: { canStart: true } }, "2026-11-13T12:00:00.000Z"));
        return HttpResponse.json(current[0]);
      },
    });
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await say({ ticket: OTHER_TICKET, state: "fetching" });
    await waitFor(() => expect(note("from before")).toBe("Fetching the PDF…"));
    await say({ ticket: OTHER_TICKET, state: "closed" });
    await waitFor(() => expect(row("from before").querySelector(".ao-find__state")?.textContent).toBe("No open copy"));
    expect(posts("/library/cancel")).toHaveLength(1);
  });

  it("a page loaded afresh with two waiting rows (a later state of the service): an event is nobody's", async () => {
    serve([entry({ typed: "one", ...waiting() }), entry({ typed: "two", ...waiting() })]);
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    await say({ ticket: TICKET, state: "closed" });
    await new Promise((r) => setTimeout(r, 200));
    expect(posts("/library/cancel")).toHaveLength(0);
    expect(note("one")).toBeUndefined();
  });

  it("outside the desktop app: the controls are shown unavailable with Only in the desktop app, reachable by keyboard, and a press makes no request", async () => {
    fake.shell = undefined;
    serve([entry({ typed: "in a browser", ...startable() }), entry({ typed: "waiting in a browser", ...waiting() })]);
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const start = btn("in a browser", "Get through my library");
    const take = btn("waiting in a browser", "Add the PDF showing in the sign-in window");
    for (const b of [start, take]) {
      expect(b.getAttribute("aria-disabled")).toBe("true");
      expect((b as HTMLButtonElement).disabled).toBe(false);
      const why = b.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
      expect(why).toContain("Only in the desktop app");
      act(() => b.focus());
      expect(document.activeElement).toBe(b);
    }
    expect(row("in a browser").textContent).toContain("Only in the desktop app");
    const before = calls.length;
    await user.click(start);
    await user.keyboard("{Enter}");
    await user.click(take);
    await new Promise((r) => setTimeout(r, 200));
    expect(calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
    // Cancel is the service's own act: it works wherever the row is.
    expect(btn("waiting in a browser", "Cancel").getAttribute("aria-disabled")).toBeNull();
  });

  describe("round 2 (R342)", () => {
    const LEFTOVER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SECOND = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const NOT_OPENED = "The sign-in window could not be opened. Nothing was changed.";
    const stateOf = (typed: string) => row(typed).querySelector(".ao-find__state")?.textContent;
    const now = (e: FindEntryView) => current.find((x) => x.id === e.id)!;
    const quiet = () => new Promise((r) => setTimeout(r, 300));
    const progress = (e: FindEntryView, state: string) => events.push({ type: "find.progress", data: { projectId: PID, entryId: e.id, state } });
    /** The service as F15 holds it: a start makes the entry wait; a cancel puts a waiting entry back, else 409 entry-state. */
    function serveOne(typed: string, o: Partial<FindEntryView> = startable(), more: FindEntryView[] = []) {
      const e = entry({ typed, ...o });
      let starts = 0;
      serve([...more, e], {
        cancel: (id) => {
          const v = current.find((x) => x.id === id)!;
          if (v.state !== "waiting-sign-in") return refusal(409, "CONFLICT", FIND_ROUTE_TEXT.entryState, "entry-state");
          becomes(later(v, { state: "no-open-copy", library: { canStart: true } }, "2026-11-13T12:00:00.000Z"));
          return HttpResponse.json(current.find((x) => x.id === id));
        },
      });
      server.use(
        // Each start a ticket of its own (the first TICKET, then SECOND).
        http.post(url("/projects/:id/find/:eid/library/start"), ({ params }) => {
          const v = current.find((x) => x.id === params.eid)!;
          becomes(later(v, { state: "waiting-sign-in", library: undefined }));
          return HttpResponse.json({ url: LIB_URL, ticket: starts++ === 0 ? TICKET : SECOND });
        }),
        http.delete(url(`/projects/${PID}/find/:eid`), ({ params }) => {
          current = current.filter((x) => x.id !== params.eid);
          return HttpResponse.json({ removed: true });
        }),
      );
      return e;
    }
    /** A page that pressed "Get through my library" itself, the shell opening the window: the row waits. */
    async function started(typed: string, more: FindEntryView[] = []) {
      const e = serveOne(typed, startable(), more);
      fake.shell!.openLibraryWindow.mockResolvedValue(true);
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rows()).toHaveLength(1 + more.length));
      await user.click(btn(typed, "Get through my library"));
      await waitFor(() => expect(stateOf(typed)).toBe("Waiting for you in the sign-in window"));
      return { e, user };
    }

    // ---- R342 a (I1, M2): the window never outlives the wait it was opened for ----

    it("R342 a (probe A): removing the waiting row whose window this page opened closes the window, once; that window's late events change nothing", async () => {
      const { user } = await started("remove me", [entry({ typed: "stays", ...noc() })]);
      const h = heard();
      await user.click(btn("remove me", "Remove from the queue"));
      await waitFor(() => expect(rows()).toHaveLength(1));
      await waitFor(() => expect(fake.shell!.closeLibraryWindow).toHaveBeenCalledTimes(1));
      for (const s of ["fetching", "handed-over", "closed"] as const) await say({ ticket: TICKET, state: s });
      await quiet();
      expect(fake.shell!.closeLibraryWindow).toHaveBeenCalledTimes(1);
      expect(posts("/library/cancel")).toHaveLength(0);
      expect(h.said.join(" ")).not.toMatch(/Fetching the PDF|The file was fetched|The sign-in window was closed/u);
      h.stop();
    });

    it("R342 a (probe B): the service returns the row by itself (as at the ticket's end): the window is closed, once; its late events change nothing", async () => {
      const { e } = await started("returned");
      becomes(later(now(e), { state: "no-open-copy", library: { canStart: true } }, "2026-11-13T12:00:00.000Z"));
      progress(e, "no-open-copy");
      await waitFor(() => expect(stateOf("returned")).toBe("No open copy"));
      await waitFor(() => expect(fake.shell!.closeLibraryWindow).toHaveBeenCalledTimes(1));
      const h = heard();
      for (const s of ["fetching", "not-a-pdf", "handed-over", "closed"] as const) await say({ ticket: TICKET, state: s });
      await quiet();
      expect(fake.shell!.closeLibraryWindow).toHaveBeenCalledTimes(1);
      expect(posts("/library/cancel")).toHaveLength(0);
      expect(h.said).toEqual([]);
      expect(note("returned")).toBeUndefined();
      h.stop();
    });

    it("R342 a (probe G): an open the page gave up on that the shell then carries out: the window is closed, once; the start is cancelled and the row says so", async () => {
      serveOne("late shell");
      let answer!: (v: boolean) => void;
      fake.shell!.openLibraryWindow.mockReturnValue(new Promise<boolean>((r) => (answer = r)));
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      const b = btn("late shell", "Get through my library");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        fireEvent.click(b);
        await vi.advanceTimersByTimeAsync(50);
        await vi.waitFor(() => expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(LIBRARY_SHELL_TIMEOUT_MS + 500);
      } finally {
        vi.useRealTimers();
      }
      await waitFor(() => expect(posts("/library/cancel")).toHaveLength(1));
      await waitFor(() => expect(note("late shell")).toBe(NOT_OPENED));
      // The shell opens the window after all: the page closes it.
      act(() => answer(true));
      await waitFor(() => expect(fake.shell!.closeLibraryWindow).toHaveBeenCalledTimes(1));
      // Its closing, reported with the ticket, is no row's.
      await say({ ticket: TICKET, state: "closed" });
      await say({ ticket: TICKET, state: "fetching" });
      await quiet();
      expect(fake.shell!.closeLibraryWindow).toHaveBeenCalledTimes(1);
      expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1);
      expect(posts("/library/cancel")).toHaveLength(1);
      expect(note("late shell")).toBe(NOT_OPENED);
    });

    it("R342 a: no close when the row leaves the wait by the hand-over", async () => {
      const { e } = await started("handed on");
      await say({ ticket: TICKET, state: "handed-over" });
      becomes(later(now(e), { state: "needs-check", reason: { code: "file-looks-right" } }, "2026-11-13T12:00:00.000Z"));
      progress(e, "needs-check");
      await waitFor(() => expect(stateOf("handed on")).toBe("Needs your check"));
      await say({ ticket: null, state: "closed" });
      await quiet();
      expect(fake.shell!.closeLibraryWindow).not.toHaveBeenCalled();
      expect(posts("/library/cancel")).toHaveLength(0);
    });

    it("R342 a: no close for a row whose window this page did not open (returned by the service, or removed)", async () => {
      const w = entry({ typed: "theirs", ...waiting() });
      const x = entry({ typed: "theirs too", ...waiting() });
      serveOne("unrelated", noc(), [w, x]);
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rows()).toHaveLength(3));
      becomes(later(w, { state: "no-open-copy", library: { canStart: true } }, "2026-11-13T12:00:00.000Z"));
      progress(w, "no-open-copy");
      await waitFor(() => expect(stateOf("theirs")).toBe("No open copy"));
      await user.click(btn("theirs too", "Remove from the queue"));
      await waitFor(() => expect(rows()).toHaveLength(2));
      await quiet();
      expect(fake.shell!.closeLibraryWindow).not.toHaveBeenCalled();
      expect(posts("/library/cancel")).toHaveLength(0);
    });

    // ---- R342 b: a window left over from before never blocks a start ----

    it("R342 b: a leftover window (the settings screen's Test) is closed, the shell asked once more with the same ticket and address; the row waits; ONE start", async () => {
      serveOne("leftover");
      // As the shell: ONE ticket at a time; an open while one is open is refused; the close reports the ticket it ended.
      let open: string | null = LEFTOVER;
      const shell = fake.shell!;
      shell.openLibraryWindow.mockImplementation(async (t) => {
        if (open !== null) return false;
        open = t;
        return true;
      });
      shell.closeLibraryWindow.mockImplementation(async () => {
        const t = open;
        open = null;
        queueMicrotask(() => shell.libraryWindow({ ticket: t, state: "closed" }));
      });
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      const h = heard();
      await user.click(btn("leftover", "Get through my library"));
      await waitFor(() => expect(stateOf("leftover")).toBe("Waiting for you in the sign-in window"));
      expect(posts("/library/start")).toHaveLength(1);
      expect(shell.openLibraryWindow.mock.calls).toEqual([
        [TICKET, LIB_URL],
        [TICKET, LIB_URL],
      ]);
      expect(shell.closeLibraryWindow).toHaveBeenCalledTimes(1);
      const [first, second] = shell.openLibraryWindow.mock.invocationCallOrder;
      expect(shell.closeLibraryWindow.mock.invocationCallOrder[0]).toBeGreaterThan(first!);
      expect(shell.closeLibraryWindow.mock.invocationCallOrder[0]).toBeLessThan(second!);
      expect(open).toBe(TICKET);
      await quiet();
      expect(posts("/library/cancel")).toHaveLength(0);
      expect(h.said.join(" ")).not.toMatch(/could not be opened|was closed/u);
      h.stop();
    });

    it("R342 b: the shell refuses twice: ONE cancel at the service, and the row says the window could not be opened", async () => {
      serveOne("refused twice");
      fake.shell!.openLibraryWindow.mockResolvedValue(false);
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      await user.click(btn("refused twice", "Get through my library"));
      await waitFor(() => expect(note("refused twice")).toBe(NOT_OPENED));
      expect(stateOf("refused twice")).toBe("No open copy");
      expect(posts("/library/cancel")).toHaveLength(1);
      expect(posts("/library/start")).toHaveLength(1);
      expect(fake.shell!.openLibraryWindow.mock.calls).toEqual([
        [TICKET, LIB_URL],
        [TICKET, LIB_URL],
      ]);
      expect(fake.shell!.closeLibraryWindow).toHaveBeenCalledTimes(1);
    });

    it("R342 b: no closed within 5 seconds: the shell is not asked again; ONE cancel, and the row says so; the control busy meanwhile", async () => {
      serveOne("no close");
      fake.shell!.openLibraryWindow.mockResolvedValue(false);
      fake.shell!.closeLibraryWindow.mockImplementation(async () => {});
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      const b = btn("no close", "Get through my library");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        fireEvent.click(b);
        await vi.advanceTimersByTimeAsync(50);
        await vi.waitFor(() => expect(fake.shell!.closeLibraryWindow).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(LIBRARY_CLOSE_WAIT_MS - 500);
        expect(posts("/library/cancel")).toHaveLength(0);
        expect(row("no close").querySelector('button[data-act="library"]')?.getAttribute("aria-busy")).toBe("true");
        await vi.advanceTimersByTimeAsync(1_000);
      } finally {
        vi.useRealTimers();
      }
      await waitFor(() => expect(posts("/library/cancel")).toHaveLength(1));
      await waitFor(() => expect(note("no close")).toBe(NOT_OPENED));
      expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1);
      expect(LIBRARY_CLOSE_WAIT_MS).toBe(5_000);
      // A close reported after the wait changes nothing.
      await say({ ticket: null, state: "closed" });
      await quiet();
      expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1);
      expect(posts("/library/cancel")).toHaveLength(1);
    });

    // ---- R342 c (M1): the focus after a start ----

    it("R342 c: Enter held or pressed twice on Get through my library starts once and takes nothing; the focus is on the row's own words", async () => {
      serveOne("by keyboard");
      fake.shell!.openLibraryWindow.mockResolvedValue(true);
      fake.shell!.libraryWindowTakePdf.mockResolvedValue(true);
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      act(() => btn("by keyboard", "Get through my library").focus());
      await user.keyboard("{Enter}{Enter}");
      await waitFor(() => expect(stateOf("by keyboard")).toBe("Waiting for you in the sign-in window"));
      const words = row("by keyboard").querySelector<HTMLElement>(".ao-find__state")!;
      await waitFor(() => expect(document.activeElement).toBe(words));
      expect(words.getAttribute("tabindex")).toBe("-1");
      // The key still held: it repeats on what has the focus.
      await user.keyboard("{Enter}{Enter}");
      await quiet();
      expect(fake.shell!.libraryWindowTakePdf).not.toHaveBeenCalled();
      expect(posts("/library/cancel")).toHaveLength(0);
      expect(posts("/library/start")).toHaveLength(1);
      expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(words);
    });

    // ---- R342 d (M3): which events count for "the one row that waits" ----

    it("R342 d (probe F): after this page ended its own ticket, another window's events are no row's — not the one waiting row's; the later closes change nothing", async () => {
      const w = entry({ typed: "from before", ...waiting() });
      const { user } = await started("mine now", [w]);
      await user.click(btn("mine now", "Cancel"));
      await waitFor(() => expect(stateOf("mine now")).toBe("No open copy"));
      expect(posts("/library/cancel")).toHaveLength(1);
      const h = heard();
      await say({ ticket: OTHER_TICKET, state: "handed-over" });
      await say({ ticket: OTHER_TICKET, state: "closed" });
      await say({ ticket: TICKET, state: "closed" });
      await say({ ticket: null, state: "failed", reason: "no-ticket" });
      await quiet();
      expect(note("from before")).toBeUndefined();
      expect(note("mine now")).toBeUndefined();
      expect(h.said).toEqual([]);
      expect(posts("/library/cancel")).toHaveLength(1);
      expect(stateOf("from before")).toBe("Waiting for you in the sign-in window");
      h.stop();
    });

    it("R342 d: an event carrying the ticket this page ended changes nothing, even with one row waiting", async () => {
      const w = entry({ typed: "still waits", ...waiting() });
      const { e } = await started("ended here", [w]);
      becomes(later(now(e), { state: "no-open-copy", library: { canStart: true } }, "2026-11-13T12:00:00.000Z"));
      progress(e, "no-open-copy");
      await waitFor(() => expect(stateOf("ended here")).toBe("No open copy"));
      await waitFor(() => expect(fake.shell!.closeLibraryWindow).toHaveBeenCalledTimes(1));
      const h = heard();
      await say({ ticket: TICKET, state: "handed-over" });
      await say({ ticket: TICKET, state: "closed" });
      await quiet();
      expect(h.said).toEqual([]);
      expect(note("still waits")).toBeUndefined();
      expect(posts("/library/cancel")).toHaveLength(0);
      h.stop();
    });

    // ---- R342 e (M4) ----

    it("R342 e: the shell says there is no ticket: The sign-in window is not open for this work. Cancel, then use “Get through my library” again.", async () => {
      serve([entry({ typed: "no window", ...waiting() })]);
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      await say({ ticket: null, state: "failed", reason: "no-ticket" });
      const SAID = "The sign-in window is not open for this work. Cancel, then use “Get through my library” again.";
      await waitFor(() => expect(note("no window")).toBe(SAID));
      await waitFor(() => expect(live().textContent).toBe(`“no window”: ${SAID}`));
    });

    // ---- R342 f (M5) ----

    it("R342 f (probe D): the window closed before the queue's read shows the row waiting: the start is still cancelled at the service, and the row says so", async () => {
      serveOne("closed at once");
      const shell = fake.shell!;
      shell.openLibraryWindow.mockImplementation(async () => {
        queueMicrotask(() => shell.libraryWindow({ ticket: TICKET, state: "closed" }));
        return true;
      });
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      await user.click(btn("closed at once", "Get through my library"));
      await waitFor(() => expect(posts("/library/cancel")).toHaveLength(1));
      await waitFor(() => expect(stateOf("closed at once")).toBe("No open copy"));
      expect(note("closed at once")).toBe("The sign-in window was closed.");
      await quiet();
      expect(posts("/library/cancel")).toHaveLength(1);
      expect(shell.closeLibraryWindow).not.toHaveBeenCalled();
    });

    // ---- R342 i (M9) ----

    it("R342 i: outside the desktop app a press on an unavailable library control says Only in the desktop app, once per press, and makes no request", async () => {
      fake.shell = undefined;
      serve([entry({ typed: "in a browser", ...startable() }), entry({ typed: "waiting in a browser", ...waiting() })]);
      const user = userEvent.setup();
      show();
      await waitFor(() => expect(rows()).toHaveLength(2));
      const h = heard();
      const before = calls.length;
      const only = () => h.said.filter((s) => s === "Only in the desktop app").length;
      await user.click(btn("in a browser", "Get through my library"));
      await waitFor(() => expect(only()).toBe(1));
      await user.click(btn("waiting in a browser", "Add the PDF showing in the sign-in window"));
      await waitFor(() => expect(only()).toBe(2));
      await new Promise((r) => setTimeout(r, ACT_SAID_MS + 200));
      expect(only()).toBe(2);
      expect(h.said).toHaveLength(2);
      expect(calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
      h.stop();
    });

    for (const [why, give, sentence] of [
      ["read-only", () => refusal(409, "READ_ONLY", FIND_ROUTE_TEXT.readOnly, "read-only"), FIND_ROUTE_TEXT.readOnly],
      ["stopped", () => refusal(409, "CONFLICT", FIND_ROUTE_TEXT.projectStopped, "stopped"), FIND_ROUTE_TEXT.projectStopped],
    ] as const) {
      it(`R342 i: the cancel after a closed window refused with 409 ${why}: the service's sentence on the row (only entry-state is no error)`, async () => {
        const { e } = await started(`refused ${why}`);
        server.use(http.post(url(`/projects/${PID}/find/${e.id}/library/cancel`), () => give()));
        await say({ ticket: TICKET, state: "closed" });
        await waitFor(() => expect(within(row(`refused ${why}`)).getByRole("alert").textContent).toBe(sentence));
        expect(posts("/library/cancel")).toHaveLength(1);
      });
    }

    // ---- R342 j (M6): the guards no test held ----

    it("R342 j: after the hand-over a close while the row is still shown waiting cancels nothing (the guard: not handed over)", async () => {
      await started("handed, still shown waiting");
      await say({ ticket: TICKET, state: "handed-over" });
      await waitFor(() => expect(note("handed, still shown waiting")).toBe("The file was fetched and is being checked."));
      await say({ ticket: null, state: "closed" });
      await quiet();
      expect(stateOf("handed, still shown waiting")).toBe("Waiting for you in the sign-in window");
      expect(posts("/library/cancel")).toHaveLength(0);
      expect(note("handed, still shown waiting")).toBe("The file was fetched and is being checked.");
    });

    it("R342 j: the ticket is held only while its row waits — after the hand-over and the row's change, a later event with it changes nothing", async () => {
      const { e } = await started("forgotten");
      await say({ ticket: TICKET, state: "handed-over" });
      becomes(later(now(e), { state: "needs-check", reason: { code: "file-looks-right" } }, "2026-11-13T12:00:00.000Z"));
      progress(e, "needs-check");
      await waitFor(() => expect(stateOf("forgotten")).toBe("Needs your check"));
      await quiet();
      const h = heard();
      await say({ ticket: TICKET, state: "fetching" });
      await say({ ticket: TICKET, state: "not-a-pdf" });
      await quiet();
      expect(h.said).toEqual([]);
      h.stop();
    });

    it("R342 j: the ticket is held only while its row waits — after Cancel, and after a closed window, a later event with it changes nothing", async () => {
      const a = entry({ typed: "closed one", ...startable() });
      const { user } = await started("cancelled one", [a]);
      await user.click(btn("cancelled one", "Cancel"));
      await waitFor(() => expect(stateOf("cancelled one")).toBe("No open copy"));
      await user.click(btn("closed one", "Get through my library"));
      await waitFor(() => expect(stateOf("closed one")).toBe("Waiting for you in the sign-in window"));
      await say({ ticket: SECOND, state: "closed" });
      await waitFor(() => expect(stateOf("closed one")).toBe("No open copy"));
      await quiet();
      const h = heard();
      for (const t of [TICKET, SECOND]) {
        await say({ ticket: t, state: "fetching" });
        await say({ ticket: t, state: "closed" });
      }
      await quiet();
      expect(h.said).toEqual([]);
      expect(posts("/library/cancel")).toHaveLength(2);
      h.stop();
    });

    it("R342 j: the control stays busy until the queue is read again — a second press before that read sends no second start", async () => {
      serveOne("one read");
      let gate: Promise<void> | undefined;
      server.use(
        http.get(url(`/projects/${PID}/find`), async () => {
          if (gate) await gate;
          return HttpResponse.json(queue(current));
        }),
      );
      fake.shell!.openLibraryWindow.mockResolvedValue(true);
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      const g = held<void>();
      gate = g.p;
      fireEvent.click(btn("one read", "Get through my library"));
      await waitFor(() => expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 100));
      // The read after the start has not answered: the row is still shown at rest, its control busy.
      expect(stateOf("one read")).toBe("No open copy");
      fireEvent.click(row("one read").querySelector<HTMLElement>('button[data-act="library"]')!);
      await new Promise((r) => setTimeout(r, 100));
      expect(posts("/library/start")).toHaveLength(1);
      gate = undefined;
      g.release();
      await waitFor(() => expect(stateOf("one read")).toBe("Waiting for you in the sign-in window"));
      expect(posts("/library/start")).toHaveLength(1);
    });

    it("R342 j: two presses in the same moment (before the row shows itself busy) send ONE start", async () => {
      serveOne("twice at once");
      fake.shell!.openLibraryWindow.mockResolvedValue(true);
      show();
      await waitFor(() => expect(rows()).toHaveLength(1));
      const b = btn("twice at once", "Get through my library");
      act(() => {
        b.click();
        b.click();
      });
      await waitFor(() => expect(stateOf("twice at once")).toBe("Waiting for you in the sign-in window"));
      expect(posts("/library/start")).toHaveLength(1);
      expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1);
    });
  });
});
