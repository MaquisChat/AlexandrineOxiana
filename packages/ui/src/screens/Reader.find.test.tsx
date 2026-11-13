/**
 * The reader opened from a search hit (Task R12): the words handed over are matched with R1's
 * `matchAnnotations` among this file's annotations once the list is in (after the reader has opened,
 * A4); the list is filtered to the matches, the first match is chosen, its page gone to and its entry
 * focused; "Show all" returns to the whole list; nothing matching says so plainly; an annotation id
 * (`readerHref(..., { annotationId })`) opens at that annotation, or says it is gone. The words are
 * handed on once (`onFindDone`) and then held nowhere: not in the address, not in a storage.
 *
 * The pages are a stand-in (PdfPages has its own tests), as in ReaderHandover.test.tsx.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readerApi, type AnnotationRecord } from "../api/reader";
import type { PdfHandle } from "../reader/pdfjs";
import { server, testClient, url, useMockService } from "../test/service";
import { ReaderScreen } from "./Reader";

const openPdf = vi.hoisted(() => vi.fn());
vi.mock("../reader/pdfjs", async (importOriginal) => ({ ...(await importOriginal<typeof import("../reader/pdfjs")>()), openPdf }));

interface PagesProps {
  handle: PdfHandle;
  currentPage: number;
  renderOverlay(pageIndex: number, viewport: unknown): ReactNode;
}
vi.mock("../reader/PdfPages", async (importOriginal) => {
  const { createElement } = await import("react");
  const viewport = { width: 595, height: 842, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 842], convertToViewportPoint: (x: number, y: number) => [x, 842 - y] };
  return {
    ...(await importOriginal<typeof import("../reader/PdfPages")>()),
    PdfPages: (p: PagesProps) =>
      createElement(
        "div",
        { className: "ao-reader-scroll", tabIndex: 0, role: "group", "aria-label": "Pages" },
        createElement("div", { "data-page-number": String(p.currentPage), className: "ao-reader-page" }, p.renderOverlay(p.currentPage - 1, viewport)),
      ),
  };
});

useMockService();

function rec(id: string, quote: string, o: { page?: number; body?: string; assetId?: string } = {}): AnnotationRecord {
  const { page = 1, body, assetId = "a1" } = o;
  return {
    id,
    sourceId: "s1",
    kind: "highlight",
    pdfAnchors: [{ id: `${id}-a`, assetId, page, rects: [{ x: 50, y: 697.93, w: 73.37, h: 9.25 }], sortIndex: `${String(page).padStart(5, "0")}|000000|00000`, sortIndexDerived: false }],
    otherAnchorKinds: [],
    quote,
    ...(body !== undefined ? { body } : {}),
    colorName: "yellow",
    imported: false,
    author: "me",
    createdAt: "2026-11-13T10:00:00Z",
  };
}

function fakeHandle(pageCount = 10) {
  let dead = false;
  return {
    doc: {},
    pageCount,
    pageLabels: null,
    failed: new Promise(() => {}),
    get dead() {
      return dead;
    },
    destroy: vi.fn(async () => {
      dead = true;
    }),
  } as unknown as PdfHandle;
}

function serveList(list: AnnotationRecord[]) {
  server.use(http.get(url("/projects/:id/sources/:sid/annotations"), () => HttpResponse.json({ annotations: list, count: list.length, textChars: 0 })));
}

beforeEach(() => {
  openPdf.mockReset();
  openPdf.mockImplementation(async () => fakeHandle());
  server.use(
    http.get(url("/projects/:id/sources/:sid/assets/:aid/document"), () => new HttpResponse(new Uint8Array(16), { status: 206, headers: { "content-type": "application/pdf", "content-range": "bytes 0-15/16" } }) as unknown as Response),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function reader(props: { findWords?: string; annotationId?: string; onFindDone?: () => void; assetId?: string; preloadedAnnotations?: AnnotationRecord[] } = {}) {
  return render(<ReaderScreen api={readerApi(testClient())} projectId="p1" sourceId="s1" assetId="a1" readOnly={false} {...props} />);
}

const shown = () => [...document.querySelectorAll<HTMLElement>("[data-entry]")].map((e) => e.dataset.entry);
const entry = (id: string) => document.querySelector<HTMLElement>(`[data-entry="${id}"]`)!;
const pageField = () => (screen.getByLabelText("Page") as HTMLInputElement).value;
const NONE = "None of this source's annotations contains all of these words exactly; the search may have matched another form of a word.";
const GONE = "That highlight or note is no longer there.";
const storages = () => JSON.stringify([...Object.entries(localStorage), ...Object.entries(sessionStorage)]);

describe("the reader opened from a search hit (Task R12)", () => {
  it("filters the list to the matches, goes to the first, chooses it and focuses its entry; the words are handed on once and kept nowhere", async () => {
    serveList([rec("early", "Nothing relevant", { page: 1 }), rec("m2", "a note on habitus and field", { page: 6 }), rec("m1", "Habitus, in Bourdieu", { page: 3 }), rec("late", "Capital", { page: 9 })]);
    const done = vi.fn();
    reader({ findWords: "habitus", onFindDone: done });
    await screen.findByRole("region", { name: "Annotations matching your search (2)" });
    expect(shown()).toEqual(["m1", "m2"]);
    await waitFor(() => expect(document.activeElement).toBe(entry("m1")));
    expect(pageField()).toBe("3");
    expect(document.querySelector('.ao-hl--selected[data-annotation="m1"]')).toBeTruthy();
    expect(done).toHaveBeenCalledTimes(1);
    // Nothing of the words anywhere.
    expect(screen.queryByText("habitus")).toBeNull();
    expect(window.location.href).not.toContain("habitus");
    expect(storages()).not.toContain("habitus");
    expect(screen.getByRole("button", { name: "Show all" })).toBeTruthy();
  });

  it("matches as R1 does: every word, the beginning of a word, accents and case folded", async () => {
    serveList([rec("a", "La sociologie de l'éducation", { page: 2 }), rec("b", "Sociology of education", { page: 3 }), rec("c", "Education only", { page: 4 })]);
    reader({ findWords: "EDUCATION socio" });
    await screen.findByRole("region", { name: "Annotations matching your search (2)" });
    expect(new Set(shown())).toEqual(new Set(["a", "b"]));
  });

  it.each([
    ["Chinese", "资本", "文化资本理论"],
    ["Japanese", "ハビトゥス", "ハビトゥスの概念について"],
    ["Arabic", "رأس المال", "رأس المال الثقافي"],
  ])("finds %s words in a quote, as R1's own tests do", async (_name, words, quote) => {
    serveList([rec("x", "Nothing here", { page: 1 }), rec("hit", quote, { page: 5 })]);
    reader({ findWords: words });
    await screen.findByRole("region", { name: "Annotations matching your search (1)" });
    expect(shown()).toEqual(["hit"]);
    await waitFor(() => expect(document.activeElement).toBe(entry("hit")));
    expect(pageField()).toBe("5");
  });

  it("finds words in a note's text as well as in the quote", async () => {
    serveList([rec("q", "Quoted words", { page: 1, body: "remember the hysteresis effect" }), rec("r", "Other", { page: 2 })]);
    reader({ findWords: "hysteresis" });
    await screen.findByRole("region", { name: "Annotations matching your search (1)" });
    expect(shown()).toEqual(["q"]);
  });

  it("when nothing matches exactly says so plainly and keeps the full list", async () => {
    serveList([rec("a", "alpha", { page: 1 }), rec("b", "beta", { page: 2 })]);
    reader({ findWords: "gammas" });
    await waitFor(() => expect(screen.getByText(NONE)).toBeTruthy());
    expect(screen.getByRole("heading", { level: 2, name: "Annotations (2)" })).toBeTruthy();
    expect(shown()).toEqual(["a", "b"]);
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
    expect(pageField()).toBe("1");
    expect(document.body.textContent).not.toContain("gammas");
  });

  it("an empty list with words says the same plain sentence", async () => {
    serveList([]);
    reader({ findWords: "habitus" });
    await waitFor(() => expect(screen.getByText(NONE)).toBeTruthy());
  });

  it("Show all returns to the whole list and keeps the focus on the entry it was on", async () => {
    const user = userEvent.setup();
    serveList([rec("a", "alpha", { page: 1 }), rec("m", "habitus", { page: 2 }), rec("z", "zeta", { page: 3 })]);
    reader({ findWords: "habitus" });
    await waitFor(() => expect(document.activeElement).toBe(entry("m")));
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByRole("heading", { level: 2, name: "Annotations (3)" })).toBeTruthy();
    expect(shown()).toEqual(["a", "m", "z"]);
    await waitFor(() => expect(document.activeElement).toBe(entry("m")));
  });

  it("a delete made while filtered behaves as unfiltered", async () => {
    const user = userEvent.setup();
    serveList([rec("m1", "habitus one", { page: 1 }), rec("m2", "habitus two", { page: 2 }), rec("z", "zeta", { page: 3 })]);
    server.use(http.delete(url("/projects/:id/sources/:sid/annotations/:aid"), ({ params }) => HttpResponse.json({ id: params.aid, deleted: true })));
    reader({ findWords: "habitus" });
    await screen.findByRole("region", { name: "Annotations matching your search (2)" });
    await user.click(within(entry("m1")).getByRole("button", { name: /^Delete/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("region", { name: "Annotations matching your search (1)" });
    expect(shown()).toEqual(["m2"]);
  });

  it("the words are not matched again when the list is fetched again (they were handed on once)", async () => {
    const user = userEvent.setup();
    serveList([rec("m", "habitus", { page: 2 }), rec("z", "zeta", { page: 3 })]);
    const done = vi.fn();
    reader({ findWords: "habitus", onFindDone: done });
    await screen.findByRole("region", { name: "Annotations matching your search (1)" });
    await user.click(screen.getByRole("button", { name: "Show all" }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByRole("heading", { level: 2, name: "Annotations (2)" })).toBeTruthy();
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("the reader opened at an annotation (readerHref with annotationId, Task R12)", () => {
  it("goes to it, chooses it and focuses its entry, with the full list", async () => {
    serveList([rec("a", "alpha", { page: 1 }), rec("t", "target", { page: 7 }), rec("z", "zeta", { page: 8 })]);
    reader({ annotationId: "t" });
    await waitFor(() => expect(document.activeElement).toBe(entry("t")));
    expect(pageField()).toBe("7");
    expect(shown()).toEqual(["a", "t", "z"]);
    expect(document.querySelector('.ao-hl--selected[data-annotation="t"]')).toBeTruthy();
    expect(screen.queryByText(GONE)).toBeNull();
  });

  it("an id that no longer exists opens the file with the plain sentence and the full list", async () => {
    serveList([rec("a", "alpha", { page: 1 }), rec("z", "zeta", { page: 8 })]);
    reader({ annotationId: "vanished" });
    await waitFor(() => expect(screen.getByText(GONE)).toBeTruthy());
    expect(shown()).toEqual(["a", "z"]);
    expect(pageField()).toBe("1");
    expect(screen.getByRole("heading", { level: 2, name: "Annotations (2)" })).toBeTruthy();
  });

  it("an annotation that lies on another file of the source does not claim to be gone", async () => {
    serveList([rec("a", "alpha", { page: 1 }), rec("o", "elsewhere", { assetId: "a2", page: 3 })]);
    reader({ annotationId: "o" });
    await screen.findByRole("heading", { level: 2, name: "Annotations (1)" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.queryByText(GONE)).toBeNull();
  });
});

describe("matches in every group of the list, not only on the open file (I2)", () => {
  const epub = (id: string, quote: string): AnnotationRecord => ({ ...rec(id, quote), pdfAnchors: [], otherAnchorKinds: ["epub"] });
  const unplaced = (id: string, quote: string): AnnotationRecord => ({ ...rec(id, quote), pdfAnchors: [] });

  it("the only match is not placed on a page: it is listed and counted, and no 'none matches' sentence is said", async () => {
    serveList([rec("a", "alpha", { page: 1 }), unplaced("u", "the habitus unplaced")]);
    reader({ findWords: "habitus" });
    await screen.findByRole("region", { name: "Annotations matching your search (1)" });
    expect(shown()).toEqual(["u"]);
    expect(screen.getByRole("heading", { level: 3, name: "Not placed on a page (1)" })).toBeTruthy();
    expect(screen.queryByText(NONE)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(entry("u")));
  });

  it("the only match is an EPUB annotation: listed under another file, counted, no sentence", async () => {
    serveList([rec("a", "alpha", { page: 1 }), epub("e", "habitus in epub")]);
    reader({ findWords: "habitus" });
    await screen.findByRole("region", { name: "Annotations matching your search (1)" });
    expect(shown()).toEqual(["e"]);
    expect(screen.getByRole("heading", { level: 3, name: "On another file of this source (1)" })).toBeTruthy();
    expect(screen.queryByText(NONE)).toBeNull();
  });

  it("the only match is on another PDF of the source (the route could not choose the file): listed read-only, counted, no sentence", async () => {
    serveList([rec("a", "alpha", { page: 1 }), rec("o", "habitus there", { assetId: "a2", page: 2 })]);
    reader({ findWords: "habitus" });
    await screen.findByRole("region", { name: "Annotations matching your search (1)" });
    expect(shown()).toEqual(["o"]);
    expect(screen.queryByText(NONE)).toBeNull();
    expect(pageField()).toBe("1");
  });

  it("the count covers every group, and the first match on this file is the one opened", async () => {
    serveList([rec("here", "habitus here", { page: 4 }), unplaced("u", "habitus unplaced"), epub("e", "habitus epub"), rec("no", "nothing", { page: 1 })]);
    reader({ findWords: "habitus" });
    await screen.findByRole("region", { name: "Annotations matching your search (3)" });
    expect(new Set(shown())).toEqual(new Set(["here", "u", "e"]));
    await waitFor(() => expect(document.activeElement).toBe(entry("here")));
    expect(pageField()).toBe("4");
  });
});

describe("the list handed over by the route, the researcher's focus, a failed document, a changed annotation id", () => {
  it("annotations handed over by the route are used: the screen does not ask for the list again", async () => {
    let asked = 0;
    server.use(http.get(url("/projects/:id/sources/:sid/annotations"), () => (asked++, HttpResponse.json({ annotations: [], count: 0, textChars: 0 }))));
    reader({ findWords: "habitus", preloadedAnnotations: [rec("m", "habitus", { page: 2 }), rec("z", "zeta", { page: 3 })] });
    await screen.findByRole("region", { name: "Annotations matching your search (1)" });
    await waitFor(() => expect(document.activeElement).toBe(entry("m")));
    expect(asked).toBe(0);
  });

  it("a late list does not take the focus from where the researcher put it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get(url("/projects/:id/sources/:sid/annotations"), async () => {
        await gate;
        return HttpResponse.json({ annotations: [rec("m", "habitus", { page: 2 })], count: 1, textChars: 0 });
      }),
    );
    reader({ findWords: "habitus" });
    const field = await screen.findByLabelText("Page");
    field.focus();
    release();
    await screen.findByRole("region", { name: "Annotations matching your search (1)" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.activeElement).toBe(field);
    expect(pageField()).toBe("2");
  });

  it("a document that cannot be opened lets go of the words at once", async () => {
    openPdf.mockReset();
    openPdf.mockRejectedValue(new Error("no"));
    const done = vi.fn();
    reader({ findWords: "habitus", onFindDone: done });
    await screen.findByRole("button", { name: "Open again" });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("an annotation id that changes while the reader is open is opened at", async () => {
    serveList([rec("a", "alpha", { page: 1 }), rec("t", "target", { page: 6 })]);
    const view = reader();
    await screen.findByRole("heading", { level: 2, name: "Annotations (2)" });
    view.rerender(<ReaderScreen api={readerApi(testClient())} projectId="p1" sourceId="s1" assetId="a1" readOnly={false} annotationId="t" />);
    await waitFor(() => expect(document.activeElement).toBe(entry("t")));
    expect(pageField()).toBe("6");
  });
});
