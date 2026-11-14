/**
 * The "Find and acquire" screen, slice 1 (Task F6), against a mocked service shaped exactly like F5's handlers
 * (apps/library-service/src/routes/find.ts) and shared types (@ao/shared api/find.ts): the box, the queue and its
 * states in words, the acts and their answers, the order of reads and events, the switch and the selects, the
 * dialog (R145) and the one polite status region.
 */
import {
  FIND_REASON_TEXT,
  FIND_ROUTE_TEXT,
  FIND_STOPPED_TEXT,
  findLineRefusal,
  type FindEntryView,
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
import { SOURCE_FILE, server, testClient, url, useMockService } from "../test/service";
import { FindAcquire } from "./FindAcquire";

useMockService();

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
const rows = () => within(queueList()).queryAllByRole("listitem");
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

  it("N1 (A2): after Try again, a stale read arriving late does not put back the old state, and the status never says it", async () => {
    const e = entry({ typed: "Merton", state: "not-found", updatedAt: "2026-11-13T10:00:00.000Z" });
    let hold: ReturnType<typeof held<void>> | undefined;
    useService({
      queues: {
        [PID]: async () => {
          if (hold) {
            const h = hold;
            hold = undefined;
            await h.p;
            return HttpResponse.json(queue([e])); // read the queue before the retry was applied
          }
          return HttpResponse.json(queue([e]));
        },
      },
    });
    server.use(http.post(url(`/projects/${PID}/find/${e.id}/retry`), () => HttpResponse.json({ ...e, state: "looking-up", updatedAt: "2026-11-13T10:05:00.000Z" })));
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const h = heard();
    const stale = held<void>();
    hold = stale;
    const before = reads();
    await user.click(within(row("Merton")).getByRole("button", { name: "Try again: “Merton”" }));
    await waitFor(() => expect(stateOf("Merton")).toBe("Looking it up"));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
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
