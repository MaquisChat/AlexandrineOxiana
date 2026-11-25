/**
 * The "Search sources" screen (Find and acquire Task F13; R290, R297, R298, R302) against a mocked service shaped exactly
 * like F12's handlers (apps/library-service/src/routes/search-settings.ts) and shared module (@ao/shared
 * api/search-settings.ts): what is listed, the draft and its save, the order of answers, moving a row by keyboard, the
 * e-mails, the two keys (in no request but their own PUT, and nowhere in the page afterwards), "Test", and the rules'
 * note when the screen is opened for a project.
 */
import {
  SEARCH_SETTINGS_TEXT,
  SEARCH_TEST_TEXT,
  searchEmailRefusal,
  type SearchSourceTestResponse,
  type SearchSourcesResponse,
} from "@ao/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { PATHS } from "../navigation";
import { BASE, CURRENT_RW, LIBRARIES, TOKEN, asksInTurn, hang, libraryHandlers, server, testClient, url, useMockService } from "../test/service";
import { DEFAULT_APPEARANCE } from "../theme/appearance";
import { FindAcquire } from "./FindAcquire";
import { SEARCH_SOURCES_TEXT, SearchSources, searchSourcesHref } from "./SearchSources";

useMockService();

const P1 = "0190b000-0000-7000-8000-0000000000a1";
const PROJECT_NAME = "Field notes";
const ELICIT_KEY = "ELICIT-recognisable-KEY-0123456789";
const OPENALEX_KEY = "OPENALEX-recognisable-KEY-9876543210";

const DEFAULT: SearchSourcesResponse = {
  record: [
    { id: "crossref", on: true },
    { id: "openalex", on: true },
    { id: "elicit", on: false },
  ],
  copies: [
    { id: "openalex", on: true },
    { id: "unpaywall", on: false },
    { id: "arxiv", on: true },
    { id: "europepmc", on: true },
    { id: "semanticscholar", on: true },
    { id: "doab", on: true },
    { id: "internetarchive", on: true },
  ],
};

interface Sent {
  method: string;
  url: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: string;
}

interface Svc {
  sent: Sent[];
  settings: SearchSourcesResponse;
  /** Rules of P1 when the GET names it: the ids of record rows not allowed. */
  forbidden: string[];
  onGet?: (req: Sent) => Promise<Response | undefined>;
  onPut?: (body: any) => Promise<Response | undefined>;
  onTest?: (group: string, id: string) => Promise<Response>;
  keys: { elicit: boolean; openalex: boolean };
  count(method: string, path: string): number;
}

async function record(svc: Svc, request: Request): Promise<Sent> {
  const u = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => (headers[k] = v));
  const s: Sent = { method: request.method, url: request.url, path: u.pathname, search: u.search, headers, body: await request.clone().text() };
  svc.sent.push(s);
  return s;
}

function useSvc(init: Partial<Pick<Svc, "settings" | "forbidden">> = {}): Svc {
  const svc: Svc = {
    sent: [],
    settings: structuredClone(init.settings ?? DEFAULT),
    forbidden: init.forbidden ?? [],
    keys: { elicit: false, openalex: false },
    count: (m, p) => svc.sent.filter((s) => s.method === m && s.path === p).length,
  };
  const withRules = (s: SearchSourcesResponse): SearchSourcesResponse => ({
    ...s,
    record: s.record.map((r) => ({ ...r, allowedByRules: !svc.forbidden.includes(r.id) })),
    copies: s.copies.map((r) => ({ ...r, allowedByRules: true })),
  });
  server.use(
    http.get(url("/settings/search-sources"), async ({ request }) => {
      const req = await record(svc, request);
      const custom = await svc.onGet?.(req);
      if (custom) return custom;
      const project = new URL(request.url).searchParams.get("project");
      if (project === null) return HttpResponse.json(svc.settings);
      if (project !== P1) return HttpResponse.json({ error: { code: "NOT_FOUND", message: SEARCH_SETTINGS_TEXT.projectNotFound } }, { status: 404 });
      return HttpResponse.json(withRules(svc.settings));
    }),
    http.put(url("/settings/search-sources"), async ({ request }) => {
      const req = await record(svc, request);
      const body = JSON.parse(req.body);
      const custom = await svc.onPut?.(body);
      if (custom) return custom;
      if (svc.settings.problem?.code === "newer") return HttpResponse.json({ error: { code: "CONFLICT", message: SEARCH_SETTINGS_TEXT.newer } }, { status: 409 });
      if (!body.unpaywallEmail && body.copies.some((c: { id: string; on: boolean }) => c.id === "unpaywall" && c.on))
        return HttpResponse.json({ error: { code: "VALIDATION", message: SEARCH_SETTINGS_TEXT.unpaywallNeedsEmail } }, { status: 400 });
      const elicit = body.record.find((r: { id: string }) => r.id === "elicit");
      svc.settings = {
        record: [...body.record.filter((r: { id: string }) => r.id !== "elicit"), elicit],
        copies: body.copies,
        ...(body.crossrefEmail ? { crossrefEmail: body.crossrefEmail } : {}),
        ...(body.unpaywallEmail ? { unpaywallEmail: body.unpaywallEmail } : {}),
      };
      return HttpResponse.json(svc.settings);
    }),
    http.post(url("/settings/search-sources/:group/:id/test"), async ({ request, params }) => {
      await record(svc, request);
      if (svc.onTest) return svc.onTest(String(params.group), String(params.id));
      return HttpResponse.json({ ok: true, sentence: SEARCH_TEST_TEXT.answered } satisfies SearchSourceTestResponse);
    }),
    ...(["elicit", "openalex"] as const).flatMap((k) => [
      http.get(url(`/secrets/${k}-api-key`), async ({ request }) => {
        await record(svc, request);
        return HttpResponse.json({ stored: svc.keys[k] });
      }),
      http.put(url(`/secrets/${k}-api-key`), async ({ request }) => {
        await record(svc, request);
        svc.keys[k] = true;
        return HttpResponse.json({ stored: true });
      }),
      http.delete(url(`/secrets/${k}-api-key`), async ({ request }) => {
        await record(svc, request);
        const removed = svc.keys[k];
        svc.keys[k] = false;
        return HttpResponse.json({ removed });
      }),
    ]),
    http.get(url("/projects"), async ({ request }) => {
      await record(svc, request);
      return HttpResponse.json({ projects: [{ id: P1, name: PROJECT_NAME, folder: PROJECT_NAME, encrypted: false, unlocked: true }] });
    }),
  );
  return svc;
}

function held() {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { p, release };
}

const record_ = () => screen.getByRole("region", { name: "Finding the work and its record" });
const copies = () => screen.getByRole("region", { name: "Finding a free copy" });
const liveText = () => screen.getByTestId("search-live").textContent ?? "";
const box = (group: HTMLElement, name: string) => within(group).getByRole("checkbox", { name }) as HTMLInputElement;

async function show(svc: Svc, search = "") {
  const view = render(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search }} />);
  await screen.findByRole("checkbox", { name: "Crossref" });
  await waitFor(() => expect(svc.count("GET", "/secrets/elicit-api-key")).toBe(1));
  return view;
}

let consoleCalls: unknown[][] = [];
beforeEach(() => {
  consoleCalls = [];
  for (const k of ["log", "info", "warn", "error", "debug", "trace"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void consoleCalls.push(a));
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Search sources: what is listed", () => {
  it("only Crossref, OpenAlex and Elicit are listed as record sources; the seven copy services as free-copy sources; each row says what it sends and whether it needs an account", async () => {
    const svc = useSvc();
    await show(svc);
    expect(screen.getByRole("heading", { level: 1, name: "Search sources" })).toBeTruthy();
    const rec = record_();
    expect((within(rec).getAllByRole("checkbox") as HTMLInputElement[]).map((b) => b.closest("li")?.dataset.source)).toEqual(["crossref", "openalex", "elicit"]);
    expect(rec.textContent).not.toMatch(/Open Library|Library of Congress/);
    expect(document.body.textContent).not.toMatch(/Open Library|Library of Congress/);
    expect(box(rec, "Crossref").checked).toBe(true);
    expect(box(rec, "Elicit").checked).toBe(false);
    const cop = copies();
    expect((within(cop).getAllByRole("checkbox") as HTMLInputElement[]).map((b) => b.closest("li")?.dataset.source)).toEqual(DEFAULT.copies.map((c) => c.id));
    const row = (g: HTMLElement, id: string) => g.querySelector<HTMLElement>(`li[data-source="${id}"]`)!;
    expect(row(rec, "crossref").textContent).toContain("Sends: the words you type");
    expect(row(rec, "crossref").textContent).toContain("Needs an account: no");
    expect(row(rec, "elicit").textContent).toContain("Needs an account: yes");
    expect(row(cop, "unpaywall").textContent).toContain("Sends: the work's DOI or title");
    expect(row(cop, "arxiv").textContent).toContain("Needs an account: no");
    // What a row says is tied to its box.
    const described = (b: HTMLInputElement) => (b.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(described(box(rec, "Crossref"))).toContain("Sends: the words you type");
  });

  it("Elicit has no move buttons and says it is asked last; Crossref and OpenAlex can be moved; the copy services have none (their order changes nothing)", async () => {
    const svc = useSvc();
    await show(svc);
    const rec = record_();
    const elicit = rec.querySelector<HTMLElement>('li[data-source="elicit"]')!;
    expect(within(elicit).queryByRole("button", { name: /Move/ })).toBeNull();
    expect(elicit.textContent).toContain("Elicit is always asked last.");
    // The first movable row has no "Move up", the last no "Move down".
    expect(within(rec).queryByRole("button", { name: "Move Crossref up" })).toBeNull();
    expect(within(rec).getByRole("button", { name: "Move Crossref down" })).toBeTruthy();
    expect(within(rec).getByRole("button", { name: "Move OpenAlex up" })).toBeTruthy();
    expect(within(rec).queryByRole("button", { name: "Move OpenAlex down" })).toBeNull();
    expect(rec.textContent).toContain("When two services give the same work, the one higher in this list is believed first.");
    expect(within(copies()).queryAllByRole("button", { name: /^Move/ })).toHaveLength(0);
  });
});

describe("Search sources: moving a row", () => {
  it("Move up by keyboard keeps focus on the moved row's button and says the new position once; Save sends the new order", async () => {
    const svc = useSvc();
    await show(svc);
    const user = userEvent.setup();
    const up = within(record_()).getByRole("button", { name: "Move OpenAlex up" });
    up.focus();
    await user.keyboard("{Enter}");
    // OpenAlex is first now: its "Move up" is gone, so focus is on its "Move down" — never on the page.
    await waitFor(() => expect(document.activeElement).toBe(within(record_()).getByRole("button", { name: "Move OpenAlex down" })));
    expect(liveText()).toBe("OpenAlex moved to position 1 of 2.");
    expect((within(record_()).getAllByRole("checkbox") as HTMLInputElement[]).map((b) => b.closest("li")?.dataset.source)).toEqual(["openalex", "crossref", "elicit"]);
    // Moving Crossref down by keyboard: Crossref is now second, its "Move down" gone, focus on its "Move up".
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(within(record_()).getByRole("button", { name: "Move OpenAlex up" })));
    expect(liveText()).toBe("OpenAlex moved to position 2 of 2.");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(liveText()).toBe("OpenAlex moved to position 1 of 2."));
    expect(svc.count("PUT", "/settings/search-sources")).toBe(0);
    const save = screen.getByRole("button", { name: "Save" });
    await user.click(save);
    await waitFor(() => expect(svc.count("PUT", "/settings/search-sources")).toBe(1));
    expect(JSON.parse(svc.sent.find((s) => s.method === "PUT" && s.path === "/settings/search-sources")!.body).record.map((r: { id: string }) => r.id)).toEqual(["openalex", "crossref", "elicit"]);
  });

  it("a row that stays where it is keeps focus on its button when moved (middle of three is not possible here: two movable rows); the change is said once per move", async () => {
    const svc = useSvc();
    await show(svc);
    const user = userEvent.setup();
    within(record_()).getByRole("button", { name: "Move Crossref down" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(within(record_()).getByRole("button", { name: "Move Crossref up" })));
    expect(liveText()).toBe("Crossref moved to position 2 of 2.");
    expect(screen.getByTestId("search-live").querySelectorAll("span")).toHaveLength(1);
  });
});

describe("Search sources: draft and save", () => {
  it("after Save the polite region says Saved., focus stays on Save, and the PUT is the whole request once", async () => {
    const svc = useSvc();
    await show(svc);
    const user = userEvent.setup();
    await user.click(box(record_(), "Elicit"));
    await user.type(screen.getByLabelText("Your e-mail address (optional; Crossref answers faster)"), "test-only@example.invalid");
    const save = screen.getByRole("button", { name: "Save" });
    await user.dblClick(save);
    await waitFor(() => expect(liveText()).toBe("Saved."));
    expect(document.activeElement).toBe(save);
    expect(svc.count("PUT", "/settings/search-sources")).toBe(1);
    const put = svc.sent.find((s) => s.method === "PUT" && s.path === "/settings/search-sources")!;
    expect(JSON.parse(put.body)).toEqual({
      record: [
        { id: "crossref", on: true },
        { id: "openalex", on: true },
        { id: "elicit", on: true },
      ],
      copies: DEFAULT.copies.map((c) => ({ id: c.id, on: c.on })),
      crossrefEmail: "test-only@example.invalid",
      unpaywallEmail: null,
    });
    expect(box(record_(), "Elicit").checked).toBe(true);
  });

  it("while a save is out the form is inert; a save with no answer in 60 seconds is given up with the draft kept and a sentence", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    const svc = useSvc();
    await show(svc);
    const gate = held();
    svc.onPut = async () => {
      await gate.p;
      return HttpResponse.json(svc.settings);
    };
    await act(async () => {
      fireEvent.click(box(record_(), "Elicit"));
    });
    await act(async () => screen.getByRole("button", { name: "Save" }).click());
    await waitFor(() => expect(svc.count("PUT", "/settings/search-sources")).toBe(1));
    expect(box(record_(), "Elicit").disabled).toBe(true);
    expect(box(record_(), "Crossref").disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(screen.queryByTestId("search-save-error")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(screen.getByTestId("search-save-error").textContent).toBe(SEARCH_SOURCES_TEXT.saveTimedOut));
    // Said once: the alert holds the sentence; the polite status region does not.
    expect(screen.getByTestId("search-save-error").getAttribute("role")).toBe("alert");
    expect(liveText()).not.toContain(SEARCH_SOURCES_TEXT.saveTimedOut);
    expect(screen.getAllByText(SEARCH_SOURCES_TEXT.saveTimedOut)).toHaveLength(1);
    expect(box(record_(), "Elicit").disabled).toBe(false);
    expect(box(record_(), "Elicit").checked).toBe(true);
    await act(async () => {
      gate.release();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(liveText()).not.toBe("Saved.");
    expect(box(record_(), "Elicit").checked).toBe(true);
  });

  it("a draft survives a read arriving meanwhile", async () => {
    const svc = useSvc();
    await show(svc);
    const user = userEvent.setup();
    await user.click(box(record_(), "Elicit"));
    // A read follows a key's change; its answer (Elicit off) does not take the unsaved tick away.
    const reads = svc.count("GET", "/settings/search-sources");
    await user.type(screen.getByLabelText("OpenAlex API key"), OPENALEX_KEY);
    await user.click(screen.getByRole("button", { name: "Store the OpenAlex key" }));
    await waitFor(() => expect(svc.count("GET", "/settings/search-sources")).toBe(reads + 1));
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(box(record_(), "Elicit").checked).toBe(true);
  });

  it("of two reads the later-started wins: an earlier read's late answer is dropped", async () => {
    const svc = useSvc();
    const view = await show(svc);
    const reads = svc.count("GET", "/settings/search-sources");
    // Two reads: the first (for the project) held; the second (no project) answers first; the first's late answer is dropped.
    const gate = held();
    let first = true;
    svc.onGet = async (req) => {
      if (req.search.includes("project") && first) {
        first = false;
        await gate.p;
        return HttpResponse.json({ ...svc.settings, record: svc.settings.record.map((r) => ({ ...r, allowedByRules: false })), crossrefEmail: "late@example.invalid" });
      }
      return undefined;
    };
    view.rerender(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search: `?project=${P1}` }} />);
    await waitFor(() => expect(svc.sent.some((s) => s.search.includes("project"))).toBe(true));
    view.rerender(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search: "" }} />);
    await waitFor(() => expect(svc.count("GET", "/settings/search-sources")).toBe(reads + 2));
    await act(async () => {
      gate.release();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect((screen.getByLabelText("Your e-mail address (optional; Crossref answers faster)") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toMatch(/Not allowed by the rules/);
  });

  it("a refused field gets the service's sentence and the focus", async () => {
    const svc = useSvc();
    await show(svc);
    svc.onPut = async () => HttpResponse.json({ error: { code: "VALIDATION", message: searchEmailRefusal("crossrefEmail") } }, { status: 400 });
    const user = userEvent.setup();
    const field = screen.getByLabelText("Your e-mail address (optional; Crossref answers faster)") as HTMLInputElement;
    await user.type(field, "not an address");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.activeElement).toBe(field));
    const ids = (field.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain(searchEmailRefusal("crossrefEmail"));
    expect(field.value).toBe("not an address");
    expect(liveText()).not.toBe("Saved.");
  });

  it("Discard changes puts back what the service holds", async () => {
    const svc = useSvc();
    await show(svc);
    const user = userEvent.setup();
    await user.click(box(record_(), "Crossref"));
    expect(box(record_(), "Crossref").checked).toBe(false);
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(box(record_(), "Crossref").checked).toBe(true);
    expect(svc.count("PUT", "/settings/search-sources")).toBe(0);
  });
});

describe("Search sources: e-mails", () => {
  it("Unpaywall cannot be ticked without its e-mail: the box is disabled with the reason tied to it; with an e-mail it can, and Save sends both", async () => {
    const svc = useSvc();
    await show(svc);
    const user = userEvent.setup();
    const unpaywall = () => box(copies(), "Unpaywall");
    expect(unpaywall().disabled).toBe(true);
    const reason = (unpaywall().getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "");
    expect(reason).toContain(SEARCH_SOURCES_TEXT.unpaywallNeedsEmail);
    const email = screen.getByLabelText("Your e-mail address (Unpaywall requires one with every request)");
    expect(email.closest("li")?.textContent).toContain("Sent only to Unpaywall.");
    expect(screen.getByLabelText("Your e-mail address (optional; Crossref answers faster)").closest("li")?.textContent).toContain("Sent only to Crossref.");
    await user.type(email, "test-only@example.invalid");
    expect(unpaywall().disabled).toBe(false);
    await user.click(unpaywall());
    expect(unpaywall().checked).toBe(true);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(liveText()).toBe("Saved."));
    const body = JSON.parse(svc.sent.find((s) => s.method === "PUT" && s.path === "/settings/search-sources")!.body);
    expect(body.unpaywallEmail).toBe("test-only@example.invalid");
    expect(body.copies.find((c: { id: string }) => c.id === "unpaywall")).toEqual({ id: "unpaywall", on: true });
  });

  it("Unpaywall on with its e-mail removed: the service's refusal is shown at the e-mail field, with the focus", async () => {
    const svc = useSvc({ settings: { ...DEFAULT, copies: DEFAULT.copies.map((c) => (c.id === "unpaywall" ? { ...c, on: true } : c)), unpaywallEmail: "test-only@example.invalid" } });
    await show(svc);
    const user = userEvent.setup();
    const email = screen.getByLabelText("Your e-mail address (Unpaywall requires one with every request)") as HTMLInputElement;
    expect(email.value).toBe("test-only@example.invalid");
    await user.clear(email);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.activeElement).toBe(email));
    const ids = (email.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain(SEARCH_SETTINGS_TEXT.unpaywallNeedsEmail);
  });
});

describe("Search sources: the settings file", () => {
  it("a newer settings file shows the service's sentence and no control that would be refused; keys and Test stay", async () => {
    const svc = useSvc({ settings: { ...DEFAULT, problem: { code: "newer", text: SEARCH_SETTINGS_TEXT.newer } } });
    render(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search: "" }} />);
    expect((await screen.findByTestId("search-problem")).textContent).toBe(SEARCH_SETTINGS_TEXT.newer);
    await waitFor(() => expect(svc.count("GET", "/secrets/elicit-api-key")).toBe(1));
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^Move/ })).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(within(record_()).getByRole("button", { name: "Test Crossref (finding the record)" })).toBeTruthy();
    expect(screen.getByLabelText("Elicit API key, from your Elicit account; a Pro plan or higher")).toBeTruthy();
    // What is stored is still said, in words.
    expect(record_().querySelector('li[data-source="crossref"]')!.textContent).toContain("Switched on");
    expect(record_().querySelector('li[data-source="elicit"]')!.textContent).toContain("Switched off");
  });

  it("an unreadable settings file shows the service's sentence and the defaults, and a save is allowed", async () => {
    const svc = useSvc({ settings: { ...DEFAULT, problem: { code: "unreadable", text: SEARCH_SETTINGS_TEXT.unreadable } } });
    await show(svc);
    expect(screen.getByTestId("search-problem").textContent).toBe(SEARCH_SETTINGS_TEXT.unreadable);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(liveText()).toBe("Saved."));
    expect(screen.queryByTestId("search-problem")).toBeNull();
  });
});

describe("Search sources: keys", () => {
  it("each key is in no request but its own PUT and nowhere in the page, storage or console afterwards (both fields)", async () => {
    const svc = useSvc();
    await show(svc);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Elicit API key, from your Elicit account; a Pro plan or higher"), ELICIT_KEY);
    await user.click(screen.getByRole("button", { name: "Store the Elicit key" }));
    await screen.findByText("An Elicit key is saved on this computer.");
    await user.type(screen.getByLabelText("OpenAlex API key"), OPENALEX_KEY);
    await user.click(screen.getByRole("button", { name: "Store the OpenAlex key" }));
    await screen.findByText("An OpenAlex key is saved on this computer.");
    // More requests after: a save, a test, a key removal.
    await user.click(box(record_(), "Elicit"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(liveText()).toBe("Saved."));
    await user.click(within(record_()).getByRole("button", { name: "Test Elicit (finding the record)" }));
    await waitFor(() => expect(svc.count("POST", "/settings/search-sources/record/elicit/test")).toBe(1));
    await user.click(screen.getByRole("button", { name: "Remove the OpenAlex key" }));
    await screen.findByText("No OpenAlex key is saved on this computer.");

    const own = (k: string) => (s: Sent) => s.method === "PUT" && s.path === `/secrets/${k}-api-key`;
    expect(svc.sent.filter(own("elicit")).map((s) => JSON.parse(s.body))).toEqual([{ apiKey: ELICIT_KEY }]);
    expect(svc.sent.filter(own("openalex")).map((s) => JSON.parse(s.body))).toEqual([{ apiKey: OPENALEX_KEY }]);
    for (const [key, isOwn] of [
      [ELICIT_KEY, own("elicit")],
      [OPENALEX_KEY, own("openalex")],
    ] as const) {
      for (const s of svc.sent) {
        expect(s.url).not.toContain(key);
        expect(JSON.stringify(s.headers)).not.toContain(key);
        if (!isOwn(s)) expect(s.body).not.toContain(key);
      }
      expect(document.documentElement.outerHTML).not.toContain(key);
      for (const el of document.querySelectorAll<HTMLElement>("*")) {
        for (const a of el.getAttributeNames()) expect(el.getAttribute(a) ?? "").not.toContain(key);
        if (el instanceof HTMLInputElement) expect(el.value).not.toContain(key);
      }
      expect(JSON.stringify(consoleCalls)).not.toContain(key);
      expect(JSON.stringify({ ...localStorage })).not.toContain(key);
      expect(JSON.stringify({ ...sessionStorage })).not.toContain(key);
    }
  });

  it("Elicit may be ticked without a key; the service's note on Elicit's row is shown through UserText and tied to its box", async () => {
    const svc = useSvc({ settings: { ...DEFAULT, record: DEFAULT.record.map((r) => (r.id === "elicit" ? { ...r, note: SEARCH_SETTINGS_TEXT.elicitKeyRefused } : r)) } });
    await show(svc);
    const elicit = box(record_(), "Elicit");
    expect(elicit.disabled).toBe(false);
    const note = screen.getByText(SEARCH_SETTINGS_TEXT.elicitKeyRefused);
    expect(note.getAttribute("dir")).toBe("auto");
    const ids = (elicit.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.some((id) => document.getElementById(id)?.contains(note))).toBe(true);
  });
});

describe("Search sources: Test", () => {
  it("a Test sends no body; its sentence is the service's, said once with the source's name; ok false never reads as success; focus stays on Test", async () => {
    const svc = useSvc();
    await show(svc);
    const gate = held();
    svc.onTest = async () => {
      await gate.p;
      return HttpResponse.json({ ok: false, sentence: SEARCH_TEST_TEXT.unreachable });
    };
    const user = userEvent.setup();
    const test = within(record_()).getByRole("button", { name: "Test Crossref (finding the record)" });
    await user.dblClick(test);
    await waitFor(() => expect(svc.count("POST", "/settings/search-sources/record/crossref/test")).toBe(1));
    expect(test.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      gate.release();
      await new Promise((r) => setTimeout(r, 30));
    });
    const row = record_().querySelector<HTMLElement>('li[data-source="crossref"]')!;
    await waitFor(() => expect(row.textContent).toContain(SEARCH_TEST_TEXT.unreachable));
    expect(liveText()).toBe(`Crossref (finding the record): ${SEARCH_TEST_TEXT.unreachable}`);
    expect(document.activeElement).toBe(test);
    expect(test.getAttribute("aria-busy")).toBeNull();
    expect(row.textContent).not.toMatch(/Answered|✓|✔/);
    expect(svc.count("POST", "/settings/search-sources/record/crossref/test")).toBe(1);
    const sent = svc.sent.find((s) => s.method === "POST")!;
    expect(sent.body).toBe("");
    expect(sent.headers["content-type"]).toBeUndefined();
  });

  it("a Test of a copy service names its group; a 409 shows the service's sentence", async () => {
    const svc = useSvc();
    await show(svc);
    svc.onTest = async () => HttpResponse.json({ error: { code: "CONFLICT", message: SEARCH_SETTINGS_TEXT.testRunning } }, { status: 409 });
    const user = userEvent.setup();
    await user.click(within(copies()).getByRole("button", { name: "Test OpenAlex (free copies)" }));
    await waitFor(() => expect(svc.count("POST", "/settings/search-sources/copies/openalex/test")).toBe(1));
    const row = copies().querySelector<HTMLElement>('li[data-source="openalex"]')!;
    await waitFor(() => expect(row.textContent).toContain(SEARCH_SETTINGS_TEXT.testRunning));
  });

  it("a Test never sends anything typed on the screen", async () => {
    const svc = useSvc();
    await show(svc);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Your e-mail address (Unpaywall requires one with every request)"), "typed-only@example.invalid");
    await user.click(within(copies()).getByRole("button", { name: "Test Unpaywall (free copies)" }));
    await waitFor(() => expect(svc.count("POST", "/settings/search-sources/copies/unpaywall/test")).toBe(1));
    for (const s of svc.sent.filter((x) => x.method === "POST")) {
      expect(s.url).not.toContain("typed-only");
      expect(s.body).toBe("");
    }
  });
});

describe("Search sources: a project's rules (R302 a)", () => {
  it("opened for a project, a forbidden row names the project, links to its Governance settings, and its box stays usable", async () => {
    const svc = useSvc({ forbidden: ["elicit"] });
    await show(svc, `?project=${P1}`);
    const get = svc.sent.find((s) => s.method === "GET" && s.path === "/settings/search-sources")!;
    expect(new URL(get.url).searchParams.get("project")).toBe(P1);
    const elicitRow = record_().querySelector<HTMLElement>('li[data-source="elicit"]')!;
    await waitFor(() => expect(elicitRow.textContent).toContain(`Not allowed by the rules of “${PROJECT_NAME}”.`));
    const link = within(elicitRow).getByRole("link", { name: `Governance settings of “${PROJECT_NAME}”` });
    expect(link.getAttribute("href")).toBe(`/governance?project=${P1}`);
    const b = box(record_(), "Elicit");
    expect(b.disabled).toBe(false);
    const ids = (b.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ")).toContain(`Not allowed by the rules of “${PROJECT_NAME}”.`);
    expect(record_().querySelector('li[data-source="crossref"]')!.textContent).not.toMatch(/Not allowed/);
    const user = userEvent.setup();
    await user.click(b);
    expect(b.checked).toBe(true);
  });

  it("opened without a project, no note", async () => {
    const svc = useSvc({ forbidden: ["elicit"] });
    await show(svc);
    expect(svc.sent.find((s) => s.method === "GET" && s.path === "/settings/search-sources")!.search).toBe("");
    expect(document.body.textContent).not.toMatch(/Not allowed by the rules/);
  });

  it("a project that is not found: the service's sentence, and the settings still shown", async () => {
    const svc = useSvc();
    render(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search: "?project=0190b000-0000-7000-8000-0000000000ff" }} />);
    expect((await screen.findByTestId("search-project-error")).textContent).toBe(SEARCH_SETTINGS_TEXT.projectNotFound);
    await screen.findByRole("checkbox", { name: "Crossref" });
    expect(svc.count("GET", "/settings/search-sources")).toBe(2);
  });

  it("the screen's address carries the project", () => {
    expect(searchSourcesHref(P1)).toBe(`/settings/search-sources?project=${P1}`);
    expect(searchSourcesHref()).toBe("/settings/search-sources");
  });
});

describe("Search sources: the contract (each request exactly as F12's handler takes it)", () => {
  it("GET /settings/search-sources: no body; ?project= only when opened for one", async () => {
    const svc = useSvc();
    await show(svc, `?project=${P1}`);
    const g = svc.sent.find((s) => s.method === "GET" && s.path === "/settings/search-sources")!;
    expect(g.search).toBe(`?project=${P1}`);
    expect(g.body).toBe("");
    expect(g.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("PUT /settings/search-sources: exactly record, copies, crossrefEmail and unpaywallEmail; every source of each group once", async () => {
    const svc = useSvc({ settings: { ...DEFAULT, crossrefEmail: "test-only@example.invalid" } });
    await show(svc);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(svc.count("PUT", "/settings/search-sources")).toBe(1));
    const p = svc.sent.find((s) => s.method === "PUT")!;
    const body = JSON.parse(p.body);
    expect(Object.keys(body).sort()).toEqual(["copies", "crossrefEmail", "record", "unpaywallEmail"]);
    expect(body.record.map((r: { id: string }) => r.id).sort()).toEqual(["crossref", "elicit", "openalex"]);
    expect(body.copies.map((r: { id: string }) => r.id).sort()).toEqual([...DEFAULT.copies.map((c) => c.id)].sort());
    for (const r of [...body.record, ...body.copies]) expect(Object.keys(r).sort()).toEqual(["id", "on"]);
    expect(body.crossrefEmail).toBe("test-only@example.invalid");
    expect(body.unpaywallEmail).toBeNull();
    expect(p.headers["content-type"]).toBe("application/json");
  });

  it("POST /settings/search-sources/:group/:id/test: the group and id in the path, no body", async () => {
    const svc = useSvc();
    await show(svc);
    const user = userEvent.setup();
    await user.click(within(record_()).getByRole("button", { name: "Test OpenAlex (finding the record)" }));
    await user.click(within(copies()).getByRole("button", { name: "Test arXiv (free copies)" }));
    await waitFor(() => expect(svc.sent.filter((s) => s.method === "POST").map((s) => s.path)).toEqual(["/settings/search-sources/record/openalex/test", "/settings/search-sources/copies/arxiv/test"]));
    for (const s of svc.sent.filter((x) => x.method === "POST")) {
      expect(s.body).toBe("");
      expect(s.search).toBe("");
    }
  });

  it("GET, PUT and DELETE /secrets/elicit-api-key and /secrets/openalex-api-key: { apiKey } only in the PUT", async () => {
    const svc = useSvc();
    svc.keys.elicit = true;
    await show(svc);
    await screen.findByText("An Elicit key is saved on this computer.");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove the Elicit key" }));
    await screen.findByText("No Elicit key is saved on this computer.");
    await user.type(screen.getByLabelText("OpenAlex API key"), OPENALEX_KEY);
    await user.click(screen.getByRole("button", { name: "Store the OpenAlex key" }));
    await screen.findByText("An OpenAlex key is saved on this computer.");
    const keyReqs = svc.sent.filter((s) => s.path.startsWith("/secrets/"));
    expect(keyReqs.filter((s) => s.method === "GET").map((s) => s.path).sort()).toEqual(["/secrets/elicit-api-key", "/secrets/openalex-api-key"]);
    const del = keyReqs.find((s) => s.method === "DELETE")!;
    expect(del.path).toBe("/secrets/elicit-api-key");
    expect(del.body).toBe("");
    const put = keyReqs.find((s) => s.method === "PUT")!;
    expect(put.path).toBe("/secrets/openalex-api-key");
    expect(JSON.parse(put.body)).toEqual({ apiKey: OPENALEX_KEY });
    for (const s of keyReqs) expect(s.search).toBe("");
  });

  it("a key of the wrong shape is refused with the service's own shape sentence before anything is sent", async () => {
    const svc = useSvc();
    await show(svc);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("OpenAlex API key"), "short");
    await user.click(screen.getByRole("button", { name: "Store the OpenAlex key" }));
    expect((await screen.findByText(SEARCH_SETTINGS_TEXT.keyShape)).textContent).toBe(SEARCH_SETTINGS_TEXT.keyShape);
    expect(svc.count("PUT", "/secrets/openalex-api-key")).toBe(0);
  });
});

describe("Search sources: round 2 (R314)", () => {
  it("R314 b: while a key is typed into either field, and after a shape refusal, no attribute holds it; after storing the field is empty", async () => {
    const svc = useSvc();
    await show(svc);
    const user = userEvent.setup();
    for (const [label, key, store] of [
      ["Elicit API key, from your Elicit account; a Pro plan or higher", ELICIT_KEY, "Store the Elicit key"],
      ["OpenAlex API key", OPENALEX_KEY, "Store the OpenAlex key"],
    ] as const) {
      const field = screen.getByLabelText(label) as HTMLInputElement;
      await user.type(field, `${key} x`);
      expect(field.value).toBe(`${key} x`);
      expect(document.documentElement.outerHTML).not.toContain(key);
      await user.click(screen.getByRole("button", { name: store }));
      await screen.findByText(SEARCH_SETTINGS_TEXT.keyShape);
      expect(field.value).toBe(`${key} x`);
      expect(document.documentElement.outerHTML).not.toContain(key);
      await user.clear(field);
      await user.type(field, key);
      expect(document.documentElement.outerHTML).not.toContain(key);
      await user.click(screen.getByRole("button", { name: store }));
      await waitFor(() => expect(svc.sent.filter((s) => s.method === "PUT" && s.path.startsWith("/secrets/") && s.body.includes(key))).toHaveLength(1));
      expect(field.value).toBe("");
      expect(document.documentElement.outerHTML).not.toContain(key);
    }
  });

  it("R314 c: each Test is named by its group, and its result is announced so", async () => {
    const svc = useSvc();
    await show(svc);
    const user = userEvent.setup();
    expect(within(record_()).getByRole("button", { name: "Test OpenAlex (finding the record)" })).toBeTruthy();
    await user.click(within(copies()).getByRole("button", { name: "Test OpenAlex (free copies)" }));
    await waitFor(() => expect(liveText()).toBe(`OpenAlex (free copies): ${SEARCH_TEST_TEXT.answered}`));
    expect(svc.count("POST", "/settings/search-sources/copies/openalex/test")).toBe(1);
  });

  it("R314 d: a source the screen does not know is shown by its name alone, with no description, and sent back unchanged", async () => {
    const svc = useSvc({
      settings: { ...DEFAULT, record: [DEFAULT.record[0]!, { id: "scopus" as never, on: true }, DEFAULT.record[1]!, DEFAULT.record[2]!] },
    });
    await show(svc);
    const row = record_().querySelector<HTMLElement>('li[data-source="scopus"]')!;
    expect(row.textContent).toContain("scopus");
    expect(row.textContent).not.toMatch(/Sends:|Needs an account/);
    expect(within(row).queryByRole("checkbox")).toBeNull();
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    const user = userEvent.setup();
    await user.click(box(record_(), "Elicit"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(svc.count("PUT", "/settings/search-sources")).toBe(1));
    const body = JSON.parse(svc.sent.find((s) => s.method === "PUT")!.body);
    expect(body.record).toEqual([
      { id: "crossref", on: true },
      { id: "scopus", on: true },
      { id: "openalex", on: true },
      { id: "elicit", on: true },
    ]);
  });
});

describe("Search sources: moving past a source the screen does not know (R316 d)", () => {
  const withUnknown = (order: string[]) => ({ ...DEFAULT, record: order.map((id) => ({ id: id as never, on: true })) });
  const order = () => Array.from(record_().querySelectorAll<HTMLElement>("li[data-source]")).map((li) => li.dataset.source);

  it("an unknown source between Crossref and OpenAlex: Move OpenAlex up goes above Crossref, announced once, and the PUT sends the order after the move", async () => {
    const svc = useSvc({ settings: withUnknown(["crossref", "scopus", "openalex", "elicit"]) });
    await show(svc);
    const user = userEvent.setup();
    await user.click(within(record_()).getByRole("button", { name: "Move OpenAlex up" }));
    expect(order()).toEqual(["openalex", "crossref", "scopus", "elicit"]);
    expect(liveText()).toBe("OpenAlex moved to position 1 of 2.");
    await waitFor(() => expect(document.activeElement).toBe(within(record_()).getByRole("button", { name: "Move OpenAlex down" })));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(svc.count("PUT", "/settings/search-sources")).toBe(1));
    const body = JSON.parse(svc.sent.find((s) => s.method === "PUT")!.body);
    expect(body.record.map((r: { id: string }) => r.id)).toEqual(["openalex", "crossref", "scopus", "elicit"]);
  });

  it("an unknown source first: the first movable row has no Move up", async () => {
    const svc = useSvc({ settings: withUnknown(["scopus", "crossref", "openalex", "elicit"]) });
    await show(svc);
    expect(within(record_()).queryByRole("button", { name: "Move Crossref up" })).toBeNull();
    expect(within(record_()).getByRole("button", { name: "Move Crossref down" })).toBeTruthy();
  });
});

describe("Search sources: reachable", () => {
  it("the screen is linked from the library's settings links and from Find and acquire with the project", async () => {
    const state = { opened: true };
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ ...LIBRARIES, current: CURRENT_RW })),
      http.get(url("/settings/appearance"), () => HttpResponse.json(DEFAULT_APPEARANCE)),
      http.get(url("/settings/researcher"), () => HttpResponse.json({ name: null })),
      ...libraryHandlers(),
      http.all(url("/*"), () => HttpResponse.json({ error: { code: "NOT_FOUND", message: "Not in this test's service." } }, { status: 404 })),
    );
    void state;
    const app = render(<App service={{ baseUrl: BASE, token: TOKEN }} />);
    const lib = await screen.findByRole("link", { name: "Search sources" });
    expect(lib.getAttribute("href")).toBe(PATHS.searchSources);
    app.unmount();

    server.resetHandlers();
    server.use(
      http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: P1, name: PROJECT_NAME, folder: PROJECT_NAME, encrypted: false, unlocked: true }] })),
      http.all(url("/*"), () => HttpResponse.json({ error: { code: "NOT_FOUND", message: "Not in this test's service." } }, { status: 404 })),
    );
    render(<FindAcquire client={testClient()} loc={{ pathname: PATHS.find, search: `?project=${P1}` }} />);
    await waitFor(() => expect(screen.getByRole("link", { name: "Search sources" }).getAttribute("href")).toBe(`/settings/search-sources?project=${P1}`));
  });
});

describe("Search sources: a first read that never settles (FR-756, R584, R586)", () => {
  const NO_ANSWER = "The library service did not answer in time.";
  const UNREACHABLE = "The library service could not be reached.";
  const tryAgain = () => screen.queryByRole("button", { name: "Try again" });
  const alerts = () => screen.queryAllByRole("alert").map((a) => a.textContent);

  it("is given up at the limit: the alert and “Try again”; pressed, it reads again (with the project), the loading words meanwhile, and the settings are shown with focus kept", async () => {
    const svc = useSvc();
    const gate = hang();
    let answer = false;
    svc.onGet = async () => {
      if (!answer) await gate;
      return undefined;
    };
    render(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search: `?project=${P1}` }} firstReadMs={300} />);
    expect(screen.getByText(SEARCH_SOURCES_TEXT.loading)).toBeTruthy();
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    // Given up: not taken for a project that could not be read, and not asked again without it.
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(screen.queryByTestId("search-project-error")).toBeNull();
    expect(svc.count("GET", "/settings/search-sources")).toBe(1);
    await userEvent.setup().click(tryAgain()!);
    expect(screen.getByText(SEARCH_SOURCES_TEXT.loading)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Search sources" }));
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    answer = true;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("checkbox", { name: "Crossref" });
    await waitFor(() => expect(svc.count("GET", "/secrets/elicit-api-key")).toBe(1));
    expect(tryAgain()).toBeNull();
    expect(alerts()).toEqual([]);
    const gets = svc.sent.filter((s) => s.method === "GET" && s.path === "/settings/search-sources");
    expect(gets.map((s) => s.search)).toEqual([`?project=${P1}`, `?project=${P1}`, `?project=${P1}`]);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Search sources" }));
  });

  it("a read that FAILS says what it said before, now with “Try again”", async () => {
    const svc = useSvc();
    let fail = true;
    svc.onGet = async () => (fail ? HttpResponse.error() : undefined);
    render(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search: "" }} firstReadMs={300} />);
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
    fail = false;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("checkbox", { name: "Crossref" });
    await waitFor(() => expect(svc.count("GET", "/secrets/elicit-api-key")).toBe(1));
  });

  it("a read refused with an answer says its sentence as before, with no “Try again”", async () => {
    const svc = useSvc();
    svc.onGet = async () => HttpResponse.json({ error: { code: "INTERNAL", message: "The settings file could not be read." } }, { status: 500 });
    render(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search: "" }} firstReadMs={300} />);
    await screen.findByText("The settings file could not be read.");
    expect(tryAgain()).toBeNull();
  });
});

describe("Search sources: leaving the screen cancels its held read (FR-756, R605 M3)", () => {
  it("the request's signal is aborted when the screen is left", async () => {
    const signals: AbortSignal[] = [];
    const gate = hang();
    server.use(
      http.get(url("/settings/search-sources"), async ({ request }) => {
        signals.push(request.signal);
        await gate;
        return HttpResponse.json({});
      }),
      http.get(url("/projects"), () => HttpResponse.json({ projects: [] })),
    );
    const { unmount } = render(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search: "" }} />);
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]!.aborted).toBe(false);
    unmount();
    await waitFor(() => expect(signals[0]!.aborted).toBe(true));
  });
});

describe("Search sources: the project left (FR-756, R605 M4)", () => {
  it("a give-up of the read of the project left never shows on the project chosen", async () => {
    const P2 = "0190b000-0000-7000-8000-0000000000a2";
    const svc = useSvc();
    const gate = hang();
    svc.onGet = async () => {
      await gate;
      return undefined;
    };
    server.use(http.get(url("/projects"), () => HttpResponse.json({ projects: [] })));
    const LIMIT = 600;
    const { rerender } = render(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search: `?project=${P1}` }} firstReadMs={LIMIT} />);
    await waitFor(() => expect(svc.count("GET", "/settings/search-sources")).toBe(1));
    await new Promise((r) => setTimeout(r, LIMIT / 2));
    rerender(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search: `?project=${P2}` }} firstReadMs={LIMIT} />);
    await waitFor(() => expect(svc.count("GET", "/settings/search-sources")).toBe(2));
    // Past the first read's limit, before the second's: nothing is said of the project chosen.
    await new Promise((r) => setTimeout(r, LIMIT / 2 + 150));
    expect(screen.queryAllByRole("alert")).toEqual([]);
    expect(screen.getByText(SEARCH_SOURCES_TEXT.loading)).toBeTruthy();
    // Its own read is given up in its turn.
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
  });
});

describe("Search sources: the project left, given up before the switch (FR-756, R605 M4)", () => {
  it("its alert goes when another project is chosen: the loading words for the project chosen", async () => {
    const P2 = "0190b000-0000-7000-8000-0000000000a2";
    const svc = useSvc();
    const gate = hang();
    svc.onGet = async () => {
      await gate;
      return undefined;
    };
    server.use(http.get(url("/projects"), () => HttpResponse.json({ projects: [] })));
    const { rerender } = render(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search: `?project=${P1}` }} firstReadMs={300} />);
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    rerender(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search: `?project=${P2}` }} firstReadMs={300} />);
    await waitFor(() => expect(screen.queryAllByRole("alert")).toEqual([]));
    expect(screen.getByText(SEARCH_SOURCES_TEXT.loading)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("Search sources: a late answer after “Try again”, and an answered failure after a give-up (FR-756, R605 M11)", () => {
  const NO_ANSWER = "The library service did not answer in time.";
  const tryAgain = () => screen.queryByRole("button", { name: "Try again" });
  const alerts = () => screen.queryAllByRole("alert").map((a) => a.textContent ?? "");

  it("a late answer of the read given up, after “Try again”, changes nothing (its request was cancelled)", async () => {
    useSvc();
    server.use(http.get(url("/projects"), () => HttpResponse.json({ projects: [] })));
    const asks = asksInTurn(url("/settings/search-sources"), ["late", "hold"], () => undefined);
    server.use(asks.handler);
    render(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search: "" }} firstReadMs={300} />);
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(asks.signals[0]!.aborted).toBe(true);
    await userEvent.setup().click(tryAgain()!);
    await waitFor(() => expect(asks.count()).toBe(2));
    asks.release();
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.queryByText(SEARCH_SOURCES_TEXT.loading)).toBeTruthy();
    expect(alerts().some((a) => a.includes(NO_ANSWER))).toBe(false);
  });

  it("an answered failure after a give-up takes the give-up's sentence away (rule ii)", async () => {
    useSvc();
    server.use(http.get(url("/projects"), () => HttpResponse.json({ projects: [] })));
    const asks = asksInTurn(url("/settings/search-sources"), ["hold", "refuse"]);
    server.use(asks.handler);
    render(<SearchSources client={testClient()} loc={{ pathname: PATHS.searchSources, search: "" }} firstReadMs={300} />);
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts().some((a) => a.includes(NO_ANSWER))).toBe(true);
    await userEvent.setup().click(tryAgain()!);
    await waitFor(() => expect(asks.count()).toBe(2));
    await waitFor(() => expect(alerts().length).toBeGreaterThan(0));
    expect(tryAgain()).toBeNull();
    expect(alerts().some((a) => a.includes(NO_ANSWER))).toBe(false);
  });
});
