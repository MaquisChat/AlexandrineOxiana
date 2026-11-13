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
import { clearPendingFind, takePendingFind } from "../reader/readerHandoff";
import { CURRENT_RW, libraryHandlers, SOURCE_FILE, SOURCES, server, testApi, url, useMockService } from "../test/service";
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

  it("is offered only for a hit in an annotation, of a source with a readable PDF, that is not locked", async () => {
    serve({
      hits: [
        hit("s1", "Has a PDF"),
        hit("s2", "No PDF"),
        { ...base, id: "s3", title: "Found by title" },
        hit("s4", "Locked", { locked: true, title: "" }),
        hit("s5", "Destroyed PDF"),
        hit("s6", "An EPUB only"),
      ],
      files: { s2: [{ ...pdf, id: "x", mime: "image/png", kind: "image" }], s5: [{ ...pdf, status: "destroyed" }], s6: [{ ...pdf, mime: "application/epub+zip", kind: "epub" }] },
    });
    renderLibrary();
    await screen.findByRole("button", { name: "Show in the reader: Has a PDF" });
    // Give the other answers time to arrive: they change nothing.
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getAllByRole("button", { name: /^Show in the reader/ })).toHaveLength(1);
  });

  it("a source whose details cannot be read offers nothing (it is never offered on a guess)", async () => {
    serve({ hits: [hit("s1", "Ethnography at Work")] });
    server.use(http.get(url("/projects/:id/sources/:sid"), () => HttpResponse.json({ error: { code: "NOT_FOUND", message: "gone" } }, { status: 404 })));
    renderLibrary();
    await screen.findByText("Ethnography at Work");
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole("button", { name: /^Show in the reader/ })).toBeNull();
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
});
