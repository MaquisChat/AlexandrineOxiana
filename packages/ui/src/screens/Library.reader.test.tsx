/**
 * A search hit "Found in an annotation" in the library (Task R12): a real button "Show in the reader:
 * <title>", offered only for a hit in an annotation of a source that has a readable PDF; pressing it
 * hands the words searched for to the reader in memory and opens the reader at ids only. A locked
 * source, a source found another way and a source with no PDF offer nothing.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPendingFind, hasPendingFind, takePendingFind } from "../reader/readerHandoff";
import { CURRENT_RW, libraryHandlers, serviceError, SOURCE_FILE, SOURCES, server, testApi, url, useMockService } from "../test/service";
import { Library } from "./Library";

useMockService();

const base = SOURCES.items[0]!;
const pdf = { ...SOURCE_FILE.assets[0]! };

function serve(opts: { hits?: Array<Record<string, unknown>>; files?: Record<string, unknown[]> } = {}) {
  const asked: string[] = [];
  server.use(
    http.get(url("/projects/:id/sources"), ({ request }) => {
      asked.push(new URL(request.url).searchParams.get("text") ?? "");
      return HttpResponse.json({ total: (opts.hits ?? []).length, items: opts.hits ?? [] });
    }),
    http.get(url("/projects/:id/sources/:sid"), ({ params }) => HttpResponse.json({ ...SOURCE_FILE, source: { ...SOURCE_FILE.source, id: String(params.sid) }, assets: opts.files?.[String(params.sid)] ?? [pdf] })),
    ...libraryHandlers(),
  );
  return asked;
}

function renderLibrary(navigate = vi.fn()) {
  render(<Library api={testApi()} current={CURRENT_RW as never} navigate={navigate} />);
  return navigate;
}

beforeEach(() => clearPendingFind());
afterEach(() => {
  cleanup();
  clearPendingFind();
});

const hit = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ ...base, id, title, matchedIn: "annotation", ...extra });

describe("Library: a search hit found in an annotation (Task R12)", () => {
  it("an annotation hit offers Show in the reader, a button named for its row", async () => {
    serve({ hits: [hit("s1", "Ethnography at Work")] });
    renderLibrary();
    const button = await screen.findByRole("button", { name: "Show in the reader: Ethnography at Work" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.textContent).toBe("Show in the reader");
    // Beside the plain statement, which stays.
    expect(screen.getByText("Found in an annotation")).toBeTruthy();
  });

  it("is offered for every hit in an annotation that is not locked, and for no other row", async () => {
    serve({ hits: [hit("s1", "Has a PDF"), hit("s2", "No PDF"), { ...base, id: "s3", title: "Found by title" }, hit("s4", "Locked", { locked: true, title: "" })] });
    renderLibrary();
    await screen.findByRole("button", { name: "Show in the reader: Has a PDF" });
    expect(screen.getAllByRole("button", { name: /^Show in the reader/ }).map((b) => b.getAttribute("aria-label"))).toEqual(["Show in the reader: Has a PDF", "Show in the reader: No PDF"]);
  });

  it("makes no request per row: 100 annotation hits and a second answer ask for no source's details at all", async () => {
    const user = userEvent.setup();
    const hits = Array.from({ length: 100 }, (_, i) => hit(`s${i}`, `Hit ${i}`));
    serve({ hits });
    const gets: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (/\/projects\/[^/]+\/sources\/[^/]+$/.test(new URL(request.url).pathname)) gets.push(request.url);
    });
    renderLibrary();
    await screen.findByRole("button", { name: "Show in the reader: Hit 99" });
    await user.type(screen.getByRole("searchbox", { name: "Search sources" }), "habitus");
    await new Promise((r) => setTimeout(r, 600));
    expect(screen.getAllByRole("button", { name: /^Show in the reader/ })).toHaveLength(100);
    expect(gets).toEqual([]);
    server.events.removeAllListeners();
  });

  it("pressing it hands the words searched for over in memory and opens the reader with ids only", async () => {
    const user = userEvent.setup();
    const asked = serve({ hits: [hit("s1", "Ethnography at Work")] });
    const navigate = renderLibrary();
    await screen.findByRole("button", { name: "Show in the reader: Ethnography at Work" });
    // The search box: the text of the search the rows answer.
    await user.type(screen.getByRole("searchbox", { name: "Search sources" }), "cultural capital{Enter}");
    await waitFor(() => expect(asked).toContain("cultural capital"));
    await user.click(await screen.findByRole("button", { name: "Show in the reader: Ethnography at Work" }));
    expect(navigate).toHaveBeenCalledTimes(1);
    const to = navigate.mock.calls[0]![0] as string;
    expect(to).toBe("/reader?project=p1&source=s1");
    expect(to).not.toContain("cultural");
    expect(window.location.href).not.toContain("cultural");
    expect(JSON.stringify([...Object.entries(localStorage), ...Object.entries(sessionStorage)])).not.toContain("cultural");
    expect(takePendingFind("p1", "s1")).toBe("cultural capital");
  });

  it("the words handed over are the text of the search whose answer the rows show", async () => {
    const user = userEvent.setup();
    const asked = serve({ hits: [hit("s1", "Ethnography at Work")] });
    const navigate = renderLibrary();
    await user.type(await screen.findByRole("searchbox", { name: "Search sources" }), "habitus{Enter}");
    await waitFor(() => expect(asked).toContain("habitus"));
    await user.click(await screen.findByRole("button", { name: "Show in the reader: Ethnography at Work" }));
    expect(navigate).toHaveBeenCalled();
    expect(takePendingFind("p1", "s1")).toBe("habitus");
  });

  it("a hit's title is shown through UserText and the button's name carries it", async () => {
    serve({ hits: [hit("s1", "<b>Bold</b> & \"quoted\"")] });
    renderLibrary();
    const button = await screen.findByRole("button", { name: 'Show in the reader: <b>Bold</b> & "quoted"' });
    expect(within(button.closest("tr")!).queryByRole("strong")).toBeNull();
    expect(button.closest("tr")!.querySelector("b")).toBeNull();
  });

  describe("the words are not kept past a change of the library's state", () => {
    /** An event stream the test feeds: every connection gets each event pushed. */
    function liveEvents() {
      const open: ReadableStreamDefaultController<Uint8Array>[] = [];
      const enc = new TextEncoder();
      const send = (c: ReadableStreamDefaultController<Uint8Array>, type: string, data: unknown) => c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
      server.use(
        http.get(url("/events"), () => {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              open.push(c);
              send(c, "library.state", { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} });
            },
          });
          return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
        }),
      );
      return { push: (type: string, data: unknown) => open.forEach((c) => send(c, type, data)), connections: () => open.length };
    }

    it("a lock or a switch announced after Show in the reader was pressed drops them (the guard)", async () => {
      const user = userEvent.setup();
      serve({ hits: [hit("s1", "Ethnography at Work")] });
      const events = liveEvents();
      renderLibrary();
      await user.type(await screen.findByRole("searchbox", { name: "Search sources" }), "habitus");
      await user.click(await screen.findByRole("button", { name: "Show in the reader: Ethnography at Work" }));
      expect(hasPendingFind()).toBe(true);
      // The guard's own stream is open besides the library's, and has seen the state it opened with.
      await waitFor(() => expect(events.connections()).toBe(2));
      events.push("library.state", { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} });
      await waitFor(() => expect(hasPendingFind()).toBe(false));
    });

    it("the library closing while the words wait drops them", async () => {
      const user = userEvent.setup();
      serve({ hits: [hit("s1", "Ethnography at Work")] });
      const events = liveEvents();
      renderLibrary();
      await user.type(await screen.findByRole("searchbox", { name: "Search sources" }), "habitus");
      await user.click(await screen.findByRole("button", { name: "Show in the reader: Ethnography at Work" }));
      expect(hasPendingFind()).toBe(true);
      events.push("library.state", { open: false });
      await waitFor(() => expect(hasPendingFind()).toBe(false));
    });

    it("a project found locked on this screen drops them", async () => {
      const user = userEvent.setup();
      serve({ hits: [hit("s1", "Ethnography at Work")] });
      renderLibrary();
      await user.type(await screen.findByRole("searchbox", { name: "Search sources" }), "habitus");
      await screen.findByRole("button", { name: "Show in the reader: Ethnography at Work" });
      // The words wait (handed over from an earlier press, say); the next search finds the project locked.
      const { setPendingFind } = await import("../reader/readerHandoff");
      setPendingFind("p1", "s1", "habitus");
      server.use(http.get(url("/projects/:id/sources"), () => serviceError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.")));
      await user.type(screen.getByRole("searchbox", { name: "Search sources" }), " field");
      await waitFor(() => expect(hasPendingFind()).toBe(false));
    });
  });
});
