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
import { LOOK_NO_TEXT_SENTENCE, NO_TEXT_SENTENCE } from "../../reader/PdfPages";
import { PdfOpenError, type PdfHandle } from "../../reader/pdfjs";
import { BASE as SERVICE, mockService, P1, server, type ServiceSetup } from "../../test/importService";
import { NO_PREVIEW } from "./FilePreview";
import { DECIDE_SETTLE_MS, FOUND_FILES_TEXT, HELD_DECISION_TIMEOUT_MS, HELD_NO_ANSWER_TEXT, LOOK_GONE, LOOK_ONLY_NOTICE, ReviewQueue } from "./ReviewQueue";

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

  it("R487 b: a page without text says so without offering a note (none can be added in a look)", async () => {
    const { user, look } = await openLook();
    await user.click(look);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByText(LOOK_NO_TEXT_SENTENCE).length).toBeGreaterThan(0));
    expect(LOOK_NO_TEXT_SENTENCE).toBe("This page has no text to select. It is probably a scanned image.");
    expect(within(dialog).queryByText(NO_TEXT_SENTENCE)).toBeNull();
    expect(dialog.textContent).not.toMatch(/add a note/u);
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

  it("the file no longer held: the look's line says so in place of its notice; a project locked meanwhile: locked, never damaged", async () => {
    // R487 a, c: "not found" at the first range: the file is not shown, the line says it can no longer be shown.
    {
      const { user, look } = await openLook();
      server.use(http.get(`${SERVICE}${HELD_DOC}`, () => HttpResponse.json({ error: { code: "NOT_FOUND", message: "x" } }, { status: 404 })));
      await user.click(look);
      const dialog = await screen.findByRole("dialog");
      await waitFor(() => expect(within(dialog).getByText(LOOK_GONE)).toBeTruthy());
      expect(within(dialog).queryByText(LOOK_ONLY_NOTICE)).toBeNull();
      expect(within(dialog).queryByRole("heading", { name: "File not found" })).toBeNull();
      expect(within(dialog).queryByRole("link")).toBeNull();
      cleanup();
    }
    {
      const { user, look } = await openLook();
      server.use(http.get(`${SERVICE}${HELD_DOC}`, () => HttpResponse.json({ error: { code: "PROJECT_LOCKED", message: "x" } }, { status: 423 })));
      await user.click(look);
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByRole("heading", { name: "Project locked" })).toBeTruthy();
      expect(within(dialog).getByText("This project is locked. Unlock it in the library to read its files.")).toBeTruthy();
      // Nothing to go to from a look: the screen behind it unlocks the project itself.
      expect(within(dialog).queryByRole("link")).toBeNull();
      cleanup();
    }
    // R487 c: one sentence true of both a file no longer waiting and a file gone from disk whose entry still waits.
    expect(LOOK_GONE).toBe("This file can no longer be shown. It is no longer waiting for your decision, or it can no longer be found on this computer.");
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

/**
 * R487 a (I1): a look and the card's own decision. (i) While the card's decision is out, "Look at the file" is busy as
 * its two deciding controls are (announced unavailable, still focusable) and a press opens nothing. (ii) A file that
 * stops waiting while it is looked at — a given-up decision the service recorded late (shown at the next read), or a
 * "not found" in mid-look — is no longer shown: the reader goes (no range is read after), the notice is replaced by the
 * sentence that it can no longer be shown, said once (focus moves to it; no live region), and on Close or Escape focus
 * goes where the queue puts it after that card's decision (the next waiting file, else the card's heading) — never to
 * the inert stand-in that took the Look control's place.
 */
describe("R487 a: a look and the card's own decision", () => {
  const OTHER = "A Second Record";
  beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => void vi.useRealTimers());
  /** R319 d: the quiet at the screen's opening, passed. */
  const passGuard = () => vi.setSystemTime(Date.now() + DECIDE_SETTLE_MS + 1);
  const named = (title: string) => `${title} (Smith, 2020)`;
  const use = (title: string) => screen.getByRole("button", { name: `Use this file for ${named(title)}` });
  const lookAt = (title: string) => screen.getByRole("button", { name: `Look at the file for ${named(title)}` });
  const heldReads = () => requests.filter((r) => r.path.endsWith("/held-file/document")).length;
  /** Not inert and not hidden from assistive technology, itself or by an ancestor. */
  const reachable = (el: Element) => el.closest("[inert], [aria-hidden='true']") === null;

  it("(i) while the card's decision is out, “Look at the file” is busy like its two deciding controls, and a press opens nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const o = setup([held(7, "pdf")]);
    o.extra!.push(
      http.post(`${SERVICE}/review/:itemId/held-file`, async () => {
        await gate;
        return HttpResponse.json({ decided: true });
      }),
    );
    const m = mockService(o);
    const user = userEvent.setup();
    render(<ReviewQueue client={m.client} projectId={P1} />);
    const look = await screen.findByRole("button", { name: `Look at the file for ${NAMED}` });
    passGuard();
    const u = use(RECORD);
    fireEvent.click(u);
    await waitFor(() => expect(u.getAttribute("aria-busy")).toBe("true"));
    // The deciding controls' own busy state: announced as unavailable, never disabled (focus stays where it is).
    expect(u.getAttribute("aria-disabled")).toBe("true");
    expect(look.getAttribute("aria-disabled")).toBe("true");
    expect((look as HTMLButtonElement).disabled).toBe(false);
    await user.click(look);
    look.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(look);
    expect(heldReads()).toBe(0);
    // The decision lands: the card is decided, its Look control replaced by the stand-in; still nothing was looked at.
    release();
    await waitFor(() => expect(within(card(RECORD)).queryByRole("button", { name: /Look at the file/u })).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(heldReads()).toBe(0);
  });

  it("(ii) a given-up decision recorded late while the file is looked at: no longer shown, said once, and Close sends focus to the next waiting file", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const items = [held(7, "pdf"), held(8, "pdf", OTHER)];
    let list = items;
    const o = setup(items);
    o.extra!.push(
      http.get(`${SERVICE}/projects/:id/review`, () => HttpResponse.json({ items: list, total: list.length, offset: 0, limit: 500 })),
      http.post(`${SERVICE}/review/:itemId/held-file`, async ({ params }) => {
        await gate;
        // Recorded by the service, late: the file no longer waits.
        list = list.filter((x) => x.id !== params.itemId);
        return HttpResponse.json({ decided: true });
      }),
    );
    const m = mockService(o);
    const user = userEvent.setup();
    render(<ReviewQueue client={m.client} projectId={P1} />);
    await screen.findByRole("button", { name: `Look at the file for ${NAMED}` });
    await screen.findByRole("button", { name: `Look at the file for ${named(OTHER)}` });
    passGuard();
    // "Use this file" with no answer in 60 seconds: given up, the card usable again (R313 e).
    const t = Date.now();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(t);
    try {
      fireEvent.click(use(RECORD));
      await vi.advanceTimersByTimeAsync(HELD_DECISION_TIMEOUT_MS + 100);
    } finally {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["Date"] });
    }
    await waitFor(() => expect(within(card(RECORD)).getByText(HELD_NO_ANSWER_TEXT)).toBeTruthy());
    const look = lookAt(RECORD);
    expect(look.getAttribute("aria-disabled")).toBeNull();
    // The look is opened FIRST.
    await user.click(look);
    const dialog = await screen.findByRole("dialog", { name: `Look at the file: ${RECORD}` });
    await within(dialog).findByRole("toolbar", { name: "Reader" });
    const handle = (await openPdf.mock.results[0]!.value) as PdfHandle;
    // Then the service's late record shows at the next read: the card no longer waits.
    release();
    await waitFor(() => expect(within(card(RECORD)).getByText(FOUND_FILES_TEXT.gone)).toBeTruthy());
    // The file is no longer shown; the notice is replaced by the sentence, said once (focus moves to it).
    const note = await within(dialog).findByText(LOOK_GONE);
    await waitFor(() => expect(document.activeElement).toBe(note));
    expect(within(dialog).getAllByText(LOOK_GONE)).toHaveLength(1);
    expect(within(dialog).queryByText(LOOK_ONLY_NOTICE)).toBeNull();
    expect(within(dialog).queryByRole("toolbar", { name: "Reader" })).toBeNull();
    expect(dialog.querySelector(".ao-reader-scroll, canvas")).toBeNull();
    expect(dialog.querySelectorAll("[role=status], [role=alert], [aria-live]")).toHaveLength(0);
    expect(handle.destroy).toHaveBeenCalled();
    const reads = heldReads();
    await new Promise((r) => setTimeout(r, 50));
    // Close: focus goes where the queue puts it after this card's decision — the next waiting file's heading.
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const next = card(OTHER).querySelector("h4")!;
    await waitFor(() => expect(document.activeElement).toBe(next));
    expect(reachable(document.activeElement!)).toBe(true);
    expect(document.activeElement).not.toBe(look);
    // No range was read once the file stopped waiting.
    expect(heldReads()).toBe(reads);
  });

  it("(ii) a “not found” in mid-look: no longer shown, said once, and Escape sends focus to the card's heading when no other file waits", async () => {
    let fail!: (e: PdfOpenError) => void;
    let transport!: { requestDataRange(begin: number, end: number): void };
    const destroy = vi.fn(async () => {});
    openPdf.mockImplementation(async (o: { transport: typeof transport }) => {
      transport = o.transport;
      const failed = new Promise<PdfOpenError>((r) => (fail = r));
      return { ...(fakeHandle() as unknown as Record<string, unknown>), failed, destroy } as unknown as PdfHandle;
    });
    const m = mockService(setup([held(7, "pdf")]));
    const user = userEvent.setup();
    render(<ReviewQueue client={m.client} projectId={P1} />);
    const look = await screen.findByRole("button", { name: `Look at the file for ${NAMED}` });
    look.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("toolbar", { name: "Reader" });
    // In mid-look the held file is no longer there: a later range is refused "not found", and the document fails so.
    server.use(http.get(`${SERVICE}${HELD_DOC}`, () => HttpResponse.json({ error: { code: "NOT_FOUND", message: "That file was not found." } }, { status: 404 })));
    const before = heldReads();
    transport.requestDataRange(2048, 4096);
    await waitFor(() => expect(heldReads()).toBe(before + 1));
    act(() => fail(new PdfOpenError("missing")));
    const note = await within(dialog).findByText(LOOK_GONE);
    await waitFor(() => expect(document.activeElement).toBe(note));
    expect(within(dialog).getAllByText(LOOK_GONE)).toHaveLength(1);
    expect(within(dialog).queryByText(LOOK_ONLY_NOTICE)).toBeNull();
    expect(within(dialog).queryByRole("toolbar", { name: "Reader" })).toBeNull();
    expect(within(dialog).queryByRole("heading", { name: "File not found" })).toBeNull();
    expect(destroy).toHaveBeenCalled();
    const reads = heldReads();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const head = card(RECORD).querySelector("h4")!;
    await waitFor(() => expect(document.activeElement).toBe(head));
    expect(reachable(document.activeElement!)).toBe(true);
    expect(heldReads()).toBe(reads);
  });
});
