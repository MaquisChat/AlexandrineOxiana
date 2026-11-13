/**
 * The reader's highlights across a failure and "Open again" (Task R8, A11, Ruling R209): what was
 * worked out for one document never reaches the next. Each test goes through a path where the state
 * would show if it were kept:
 *  - the old document's list answer, held back and released after the new one's, is dropped;
 *  - the old document's annotations, verdicts and page texts are not carried over;
 *  - text handed on by the old document's pages after it died gives no verdict on the new one.
 *
 * The pages are a stand-in (PdfPages is covered by its own tests): page 1 is drawn at once with the
 * overlay the screen gives, and the `onPageText` each rendering was given is kept, so the test can
 * hand text on as PdfPages would, and late.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readerApi, type AnnotationRecord } from "../api/reader";
import { PdfOpenError, type PdfHandle } from "../reader/pdfjs";
import { server, testClient, url, useMockService } from "../test/service";
import { ReaderScreen } from "./Reader";

const openPdf = vi.hoisted(() => vi.fn());
vi.mock("../reader/pdfjs", async (importOriginal) => ({ ...(await importOriginal<typeof import("../reader/pdfjs")>()), openPdf }));

interface PagesProps {
  handle: PdfHandle;
  onPageText?(pageIndex: number, text: unknown): void;
  renderOverlay(pageIndex: number, viewport: unknown): ReactNode;
}
const rendered = vi.hoisted(() => [] as PagesProps[]);
vi.mock("../reader/PdfPages", async (importOriginal) => {
  const { createElement } = await import("react");
  // An A4 page at 1 CSS pixel a point, unturned, as pdf.js's viewport places points.
  const viewport = { width: 595, height: 842, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 842], convertToViewportPoint: (x: number, y: number) => [x, 842 - y] };
  return {
    ...(await importOriginal<typeof import("../reader/PdfPages")>()),
    PdfPages: (p: PagesProps) => {
      rendered.push(p);
      return createElement("div", { className: "ao-reader-scroll", tabIndex: 0, role: "group", "aria-label": "Pages" }, createElement("div", { "data-page-number": "1", className: "ao-reader-page" }, p.renderOverlay(0, viewport)));
    },
  };
});

useMockService();

/** A page's text as pdf.js gives it: one line of 10-point Helvetica at x 50, baseline 700. */
const pageText = (str: string) => ({ items: [{ str, dir: "ltr", transform: [10, 0, 0, 10, 50, 700], width: 73.37, height: 10, fontName: "f1", hasEOL: false }], styles: { f1: { fontFamily: "sans-serif", ascent: 0.718, descent: -0.207, vertical: false } }, lang: null });
const onLine = [{ x: 50, y: 697.93, w: 73.37, h: 9.25 }];

function rec(id: string, quote: string): AnnotationRecord {
  return { id, sourceId: "s1", kind: "highlight", pdfAnchors: [{ id: `${id}-a`, assetId: "a1", page: 1, rects: onLine, sortIndex: "00000|000000|00000", sortIndexDerived: false }], otherAnchorKinds: [], quote, colorName: "yellow", imported: false, author: "me", createdAt: "2026-11-13T10:00:00Z" };
}

function fakeHandle() {
  let fail: (e: PdfOpenError) => void = () => {};
  const failed = new Promise<PdfOpenError>((r) => (fail = r));
  let dead = false;
  const handle = {
    doc: {},
    pageCount: 2,
    pageLabels: null,
    failed,
    get dead() {
      return dead;
    },
    destroy: vi.fn(async () => {
      dead = true;
    }),
  } as unknown as PdfHandle;
  return { handle, fail: (e: PdfOpenError) => ((dead = true), fail(e)) };
}

/** The annotation list route: each request waits for the test to answer it. */
function heldLists() {
  const waiting: Array<(list: AnnotationRecord[]) => void> = [];
  server.use(
    http.get(url("/projects/:id/sources/:sid/annotations"), () => new Promise<Response>((r) => waiting.push((list) => r(HttpResponse.json({ annotations: list, count: list.length, textChars: 0 }) as unknown as Response)))),
  );
  return waiting;
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
const drawn = () => [...document.querySelectorAll<HTMLElement>(".ao-hl")].map((e) => `${e.dataset.annotation}${e.classList.contains("ao-hl--changed") ? " (changed)" : ""}`);
/** The onPageText the pages of `h` were given. */
const pageTextFor = (h: PdfHandle) => rendered.filter((p) => p.handle === h).at(-1)!.onPageText!;

beforeEach(() => {
  rendered.length = 0;
  openPdf.mockReset();
  server.use(
    http.get(url("/projects/:id/sources/:sid/assets/:aid/document"), () => new HttpResponse(new Uint8Array(16), { status: 206, headers: { "content-type": "application/pdf", "content-range": "bytes 0-15/16" } }) as unknown as Response),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Opens doc 1, fails it as a file changed in mid-read, and presses "Open again" into doc 2. */
async function failAndOpenAgain(before?: (one: ReturnType<typeof fakeHandle>) => Promise<void>, api = readerApi(testClient())) {
  const one = fakeHandle();
  const two = fakeHandle();
  openPdf.mockResolvedValueOnce(one.handle).mockResolvedValueOnce(two.handle);
  const user = userEvent.setup();
  render(<ReaderScreen api={api} projectId="p1" sourceId="s1" assetId="a1" readOnly={false} />);
  await screen.findByRole("group", { name: "Pages" });
  await before?.(one);
  act(() => one.fail(new PdfOpenError("other", "The file changed while it was being read. Open it again to read it as it is now.")));
  await user.click(await screen.findByRole("button", { name: "Open again" }));
  await screen.findByRole("group", { name: "Pages" });
  await waitFor(() => expect(rendered.some((p) => p.handle === two.handle)).toBe(true));
  return { one, two };
}

describe("the reader's highlights across Open again (A11)", () => {
  it("the old document's list answer, held back and released after the new one's, is dropped: only the new document's highlights show", async () => {
    const lists = heldLists();
    // The request is aborted when its document ends (Reader.test.tsx); here the answer comes anyway,
    // as one already on its way when the abort came would: the screen must still drop it.
    const real = readerApi(testClient());
    const deaf = { ...real, listAnnotations: (p: string, s: string) => real.listAnnotations(p, s) };
    await failAndOpenAgain(async () => {
      await waitFor(() => expect(lists).toHaveLength(1));
    }, deaf);
    await waitFor(() => expect(lists).toHaveLength(2));
    act(() => lists[1]!([rec("new", "Words of the new file")]));
    await waitFor(() => expect(drawn()).toEqual(["new"]));
    act(() => lists[0]!([rec("old", "Words of the old file")]));
    await flush();
    expect(drawn()).toEqual(["new"]);
  });

  it("nothing of the old document's annotations, verdicts or page texts is carried over", async () => {
    const lists = heldLists();
    await failAndOpenAgain(async (one) => {
      await waitFor(() => expect(lists).toHaveLength(1));
      act(() => lists[0]!([rec("old", "Old words only"), rec("old-changed", "Something else entirely")]));
      await waitFor(() => expect(drawn()).toContain("old"));
      act(() => pageTextFor(one.handle)(0, pageText("Old words only")));
      await waitFor(() => expect(drawn()).toEqual(["old", "old-changed (changed)"]));
    });
    // The new document's list is not in yet: nothing of the old one is drawn.
    await waitFor(() => expect(lists).toHaveLength(2));
    await flush();
    expect(drawn()).toEqual([]);
    // Its list comes; its page has not handed on any text: no verdict, none from the old page's text.
    act(() => lists[1]!([rec("new", "New words here")]));
    await waitFor(() => expect(drawn()).toEqual(["new"]));
    await flush();
    expect(drawn()).toEqual(["new"]);
    expect(screen.queryByRole("region", { name: "Highlights to check" })).toBeNull();
  });

  it("text handed on by the old document's pages after it died gives no verdict on the new one", async () => {
    const lists = heldLists();
    const { one } = await failAndOpenAgain();
    // Both documents' list requests are out; the new document's answers.
    await waitFor(() => expect(lists).toHaveLength(2));
    act(() => lists[1]!([rec("new", "New words here")]));
    await waitFor(() => expect(drawn()).toEqual(["new"]));
    // The old pages hand on their text late (as a drawing finishing just as the handle died would).
    act(() => pageTextFor(one.handle)(0, pageText("Old words only")));
    await flush();
    expect(drawn()).toEqual(["new"]);
    expect(screen.queryByRole("region", { name: "Highlights to check" })).toBeNull();
  });
});
