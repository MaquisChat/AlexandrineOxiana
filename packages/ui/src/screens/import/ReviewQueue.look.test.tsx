/**
 * R470 b (FR-490): a file Find and acquire holds for the researcher's decision can be LOOKED at before "Use this file" /
 * "Not this file". Each found PDF's card offers "Look at the file" (named for its record); it opens the app's reader on
 * the held file's own route, in a dialog, in a look-only mode: a line says the file has not been added, and there is no
 * highlight, no note, no annotation list, no source action — the only requests are ranges of the held file; nothing is
 * sent that writes, and nothing is kept in the browser's storage. Closing it (its button or Escape) returns focus to the
 * control that opened it; the key that opened it never closes it. A found EPUB says no preview can be shown, and offers
 * no look.
 *
 * pdf.js itself is covered elsewhere; here `openPdf` answers with a stand-in document of three pages.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewItem } from "../../api/import";
import type { PdfHandle } from "../../reader/pdfjs";
import { BASE as SERVICE, mockService, P1, server, type ServiceSetup } from "../../test/importService";
import { NO_PREVIEW } from "./FilePreview";
import { LOOK_GONE, LOOK_ONLY_NOTICE, ReviewQueue } from "./ReviewQueue";

const openPdf = vi.hoisted(() => vi.fn());
vi.mock("../../reader/pdfjs", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../reader/pdfjs")>()), openPdf }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

const RECORD = "Rivers and Memory in Upland Villages";
const NAMED = `${RECORD} (Smith, 2020)`;

const held = (n: number, kind: "pdf" | "epub", title = RECORD): ReviewItem =>
  ({
    id: `r${n}`,
    projectId: P1,
    sourceId: `s${n}`,
    kind: "verification",
    status: "pending",
    createdAt: "2026-11-11T10:00:00.000Z",
    fields: {},
    reasons: ["A file was found for this record, but it did not clearly match."],
    group: "found-file",
    cause: { kind: "acquired-file-mismatch", findEntryId: `e${n}` },
    title,
    heldFile: { why: "other-doi", kind, bytes: 4096 },
  }) as unknown as ReviewItem;

const source = (n: number, title: string) => ({
  source: { id: `s${n}`, type: "article-journal", title: { variants: [{ lang: "en", kind: "original", value: title }] }, creators: [{ family: "Smith", given: "Ann" }], issued: "2020", collectionIds: [], tagIds: [], provenance: {} },
  assets: [],
  fieldEvidence: [],
});

/** Every request the screen made: method and path, and the Range asked. */
let requests: Array<{ method: string; path: string; range: string | null }> = [];
const record = ({ request }: { request: Request }) => {
  requests.push({ method: request.method, path: new URL(request.url).pathname, range: request.headers.get("range") });
};

const HELD_DOC = "/projects/:id/review/:itemId/held-file/document";
function setup(items: ReviewItem[]): ServiceSetup {
  return {
    projectReview: { [P1]: items },
    sources: Object.fromEntries(items.map((i) => [i.sourceId, source(Number(i.sourceId!.slice(1)), i.title ?? RECORD)])),
    extra: [
      http.get(`${SERVICE}${HELD_DOC}`, ({ request }) => {
        const m = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.get("range") ?? "")!;
        const total = 4096;
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), total - 1);
        return new HttpResponse(new Uint8Array(end - start + 1), { status: 206, headers: { "content-type": "application/pdf", "content-range": `bytes ${start}-${end}/${total}` } });
      }),
    ],
  };
}

/** A stand-in open document of three A4 pages without text. */
function fakeHandle(): PdfHandle {
  const failed = new Promise<never>(() => {});
  const vp = (scale: number) => ({ width: 595 * scale, height: 842 * scale, scale, rotation: 0, rawDims: { pageWidth: 595, pageHeight: 842, pageX: 0, pageY: 0 }, transform: [scale, 0, 0, -scale, 0, 842 * scale], convertToViewportPoint: (x: number, y: number) => [x * scale, (842 - y) * scale] });
  const page = (n: number) => ({
    pageNumber: n,
    rotate: 0,
    getViewport: ({ scale }: { scale: number }) => vp(scale),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    getTextContent: async () => ({ items: [], styles: {}, lang: null }),
    cleanup: () => true,
  });
  return { doc: { numPages: 3, getPage: async (n: number) => page(n) }, pageCount: 3, pageLabels: null, failed, dead: false, destroy: vi.fn(async () => {}) } as unknown as PdfHandle;
}

/** Writes to the browser's storage while a test runs. */
let stored: string[] = [];

beforeEach(() => {
  requests = [];
  stored = [];
  server.events.on("request:start", record);
  openPdf.mockReset();
  openPdf.mockImplementation(async () => fakeHandle());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return { canvas: this, measureText: () => ({ width: 10 }), font: "" } as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string) {
    stored.push(k);
  });
});
afterEach(async () => {
  cleanup();
  server.events.removeAllListeners();
  vi.restoreAllMocks();
  await new Promise((r) => setTimeout(r, 10));
});

const card = (title: string) => {
  const li = screen.getAllByRole("listitem").find((x) => x.querySelector("h4")?.textContent === title);
  if (!li) throw new Error(`no card for ${title}`);
  return li;
};

async function openLook(items = [held(7, "pdf")]) {
  const m = mockService(setup(items));
  const user = userEvent.setup();
  render(<ReviewQueue client={m.client} projectId={P1} />);
  const look = await screen.findByRole("button", { name: `Look at the file for ${NAMED}` });
  return { m, user, look };
}

describe("R470 b: looking at a held file before deciding", () => {
  it("a found PDF's card offers “Look at the file”, named for its record; it opens the reader on the held file, look-only", async () => {
    const { m, user, look } = await openLook();
    await user.click(look);
    const dialog = await screen.findByRole("dialog", { name: `Look at the file: ${RECORD}` });
    // The line that says what this is.
    expect(within(dialog).getByText(LOOK_ONLY_NOTICE)).toBeTruthy();
    expect(LOOK_ONLY_NOTICE).toBe("This file has not been added to your library. Use this file, or Not this file, in the review queue.");
    // The reader opened on the held file's own route, by ranges.
    await within(dialog).findByRole("toolbar", { name: "Reader" });
    const held = requests.filter((r) => r.path === `/projects/${P1}/review/r7/held-file/document`);
    expect(held.length).toBeGreaterThan(0);
    for (const r of held) expect([r.method, r.range]).toEqual(["GET", expect.stringMatching(/^bytes=\d+-\d+$/u)]);
    // No highlight, no note, no list of annotations, no source action: the toolbar's own controls only, and Close.
    const names = within(dialog).getAllByRole("button").map((b) => b.textContent);
    expect(names.sort()).toEqual(["Close", "Fit width", "Next page", "Previous page", "Rotate view", "Zoom in", "Zoom out"].sort());
    expect(within(dialog).queryByRole("region", { name: /annotation|highlight|note/iu })).toBeNull();
    expect(within(dialog).queryByText(/read-only/iu)).toBeNull();
    // Nothing asked but ranges of the held file: no annotations, no source, nothing sent that writes, nothing stored.
    expect(requests.filter((r) => /annotations|\/assets\//u.test(r.path))).toEqual([]);
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(m.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(stored).toEqual([]);
    // Keys on the pages make nothing: S (select) and N (a page note) do nothing here.
    const area = dialog.querySelector<HTMLElement>(".ao-reader-scroll")!;
    fireEvent.keyDown(area, { key: "s" });
    fireEvent.keyDown(area, { key: "n" });
    expect(within(dialog).queryByRole("region", { name: /note/iu })).toBeNull();
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("focus goes into the dialog; Close returns it to the control that opened it", async () => {
    const { user, look } = await openLook();
    await user.click(look);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await within(dialog).findByRole("toolbar", { name: "Reader" });
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: `Look at the file for ${NAMED}` }));
    // The file still waits for the researcher's decision, its two controls as before.
    expect(screen.getByRole("button", { name: `Use this file for ${NAMED}` })).toBeTruthy();
  });

  it("Escape closes it too, focus back on the control; the key that opened it never closes it", async () => {
    const { user, look } = await openLook();
    look.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    // Focus is in the dialog (its heading, then the pages), never on Close: Enter held down (its repeats) closes nothing.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document.activeElement!, { key: "Enter", repeat: true });
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBe(dialog);
    await within(dialog).findByRole("toolbar", { name: "Reader" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: `Look at the file for ${NAMED}` }));
  });

  it("the rest of the screen cannot be reached while it is open", async () => {
    const { user, look } = await openLook();
    await user.click(look);
    await screen.findByRole("dialog");
    const main = document.querySelector("main")!;
    expect(main.closest("[inert]")).not.toBeNull();
  });

  it("the file no longer held: the reader says so in its own words; a project locked meanwhile: locked, never damaged", async () => {
    for (const [status, code, heading, sentence] of [
      [404, "NOT_FOUND", "File not found", LOOK_GONE],
      [423, "PROJECT_LOCKED", "Project locked", "This project is locked. Unlock it in the library to read its files."],
    ] as const) {
      const { user, look } = await openLook();
      server.use(http.get(`${SERVICE}${HELD_DOC}`, () => HttpResponse.json({ error: { code, message: "x" } }, { status })));
      await user.click(look);
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByRole("heading", { name: heading })).toBeTruthy();
      expect(within(dialog).getByText(sentence)).toBeTruthy();
      // Nothing to go to from a look: the screen behind it unlocks the project itself.
      expect(within(dialog).queryByRole("link")).toBeNull();
      cleanup();
    }
    expect(LOOK_GONE).toBe("This file is no longer waiting for your decision, so it cannot be shown.");
  });

  it("a found EPUB says no preview can be shown, and offers no look", async () => {
    const m = mockService(setup([held(9, "epub", "An EPUB Record")]));
    render(<ReviewQueue client={m.client} projectId={P1} />);
    await screen.findByRole("button", { name: /^Use this file for An EPUB Record/u });
    const c = card("An EPUB Record");
    expect(NO_PREVIEW).toBe("No preview of this file can be shown here.");
    expect(within(c).getByText(NO_PREVIEW)).toBeTruthy();
    expect(within(c).queryByRole("button", { name: /Look at the file/u })).toBeNull();
    await act(async () => {});
    expect(requests.filter((r) => r.path.includes("held-file"))).toEqual([]);
  });
});
