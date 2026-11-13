/**
 * The reader screen (Task R7): opening a source's PDF through the service's ranged route (the real
 * client and range transport, the service mocked with MSW, which records every request), every state
 * with its own heading and plain sentence, the password used in memory only, the toolbar and the
 * keys of the page area with focus placed deliberately, read-only, and the handle's failure (A7):
 * the document destroyed, nothing drawn left behind, "Open again".
 *
 * pdf.js itself is covered by reader/pdfjs.test.ts and end to end; here `openPdf` answers with a
 * stand-in handle (pdf.js's shapes), so each state can be reached exactly.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readerApi, type AnnotationRecord } from "../api/reader";
import { PdfOpenError, type PdfHandle } from "../reader/pdfjs";
import { server, serviceError, SOURCE_FILE, testClient, url, useMockService } from "../test/service";
import { QUESTION_RETRY_MS, QUESTION_TIMEOUT_MS, ReaderRoute } from "../routes/reader";
import { ReaderScreen } from "./Reader";

const openPdf = vi.hoisted(() => vi.fn());
vi.mock("../reader/pdfjs", async (importOriginal) => ({ ...(await importOriginal<typeof import("../reader/pdfjs")>()), openPdf }));

useMockService();

const SENTENCES = {
  locked: "This project is locked. Unlock it in the library to read its files.",
  missing: "The file of this source is not where it was recorded, so it cannot be shown.",
  damaged: "This PDF is damaged and cannot be shown. The file itself has not been changed.",
  tooLarge: "This PDF is larger than 512 MB, too large to open in the app.",
  password: "This PDF is protected by a password. Enter it to read it here.",
  wrongPassword: "That password did not open this PDF.",
  unreachable: "The library service could not be reached, so this PDF cannot be shown. Try again in a moment.",
  readOnly: "This library is open read-only: you can read and see annotations, but not change them.",
};
const DOC = "/projects/:id/sources/:sid/assets/:aid/document";
const PASSWORD = "ao-fixture-Secret-41";

/** Every request the screen made, with its headers and body. */
let requests: Array<{ url: string; headers: string; body: string }> = [];
const record = async ({ request }: { request: Request }) => {
  requests.push({ url: request.url, headers: JSON.stringify([...request.headers.entries()]), body: await request.clone().text() });
};

/** The document route: answers any range of a `total`-byte file (zeros). */
function serveDocument(total = 4096, answer?: () => Response) {
  server.use(
    http.get(url(DOC), ({ request }) => {
      if (answer) return answer();
      const m = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "")!;
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), total - 1);
      return new HttpResponse(new Uint8Array(end - start + 1), { status: 206, headers: { "content-type": "application/pdf", "content-range": `bytes ${start}-${end}/${total}` } });
    }),
  );
}

interface Fake {
  handle: PdfHandle;
  destroy: ReturnType<typeof vi.fn>;
  fail(e: PdfOpenError): void;
  holdRenders: Array<() => void>;
}

/** A text item of the stand-in pages: `str` at baseline (x, y), `size` points, `width` points long. */
const textItem = (str: string, x: number, y: number, size: number, width: number) => ({ str, dir: "ltr", transform: [size, 0, 0, size, x, y], width, height: size, fontName: "f1", hasEOL: false });

/** A viewport of an A4 page (view box 0 0 595 842) as pdf.js 6.4.299 makes it. */
function a4Viewport(scale: number, rotation: number) {
  const [A, B, C, D] = rotation === 90 ? [0, 1, 1, 0] : rotation === 180 ? [-1, 0, 0, 1] : rotation === 270 ? [0, -1, -1, 0] : [1, 0, 0, -1];
  const turned = A === 0;
  const [cx, cy] = [297.5, 421];
  const ox = (turned ? cy : cx) * scale;
  const oy = (turned ? cx : cy) * scale;
  const t = [A! * scale, B! * scale, C! * scale, D! * scale, ox - A! * scale * cx - C! * scale * cy, oy - B! * scale * cx - D! * scale * cy];
  return {
    width: (turned ? 842 : 595) * scale,
    height: (turned ? 595 : 842) * scale,
    scale,
    rotation,
    rawDims: { pageWidth: 595, pageHeight: 842, pageX: 0, pageY: 0 },
    transform: t,
    convertToViewportPoint: (x: number, y: number) => [t[0]! * x + t[2]! * y + t[4]!, t[1]! * x + t[3]! * y + t[5]!],
  };
}

/** A stand-in open document of `pages` A4 pages, without text unless `text` gives a page's items. */
function fakeHandle(pages = 12, opts: { labels?: string[] | null; hold?: boolean; text?: (n: number) => ReturnType<typeof textItem>[]; textReads?: number[] } = {}): Fake {
  let fail: (e: PdfOpenError) => void = () => {};
  const failed = new Promise<PdfOpenError>((r) => {
    fail = r;
  });
  let dead = false;
  const holdRenders: Array<() => void> = [];
  const destroy = vi.fn(async () => {
    dead = true;
  });
  const vp = a4Viewport;
  const page = (n: number) => ({
    pageNumber: n,
    rotate: 0,
    getViewport: ({ scale, rotation }: { scale: number; rotation?: number }) => vp(scale, rotation ?? 0),
    render: () => {
      let release = () => {};
      let reject: (e: Error) => void = () => {};
      const promise = new Promise<void>((res, rej) => {
        release = res;
        reject = rej;
      });
      if (opts.hold) holdRenders.push(release);
      else queueMicrotask(release);
      return { promise, cancel: () => reject(Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" })) };
    },
    getTextContent: async () => {
      opts.textReads?.push(n);
      return { items: opts.text?.(n) ?? [], styles: { f1: { fontFamily: "sans-serif", ascent: 0.718, descent: -0.207, vertical: false } }, lang: null };
    },
    cleanup: () => true,
  });
  const handle = {
    doc: { numPages: pages, getPage: async (n: number) => (dead ? Promise.reject(new PdfOpenError("other", "This document was closed.")) : page(n)) },
    pageCount: pages,
    pageLabels: opts.labels ?? null,
    failed,
    get dead() {
      return dead;
    },
    destroy,
  } as unknown as PdfHandle;
  return {
    handle,
    destroy,
    holdRenders,
    fail: (e) => {
      dead = true;
      fail(e);
    },
  };
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });

function screenFor(props: Partial<Parameters<typeof ReaderScreen>[0]> = {}) {
  return render(<ReaderScreen api={readerApi(testClient())} projectId="p1" sourceId="s1" assetId="a1" readOnly={false} {...props} />);
}

/** The annotation list route: `list`, or what `answer` answers. */
function serveAnnotations(list: AnnotationRecord[], answer?: () => Response | Promise<Response>) {
  server.use(http.get(url("/projects/:id/sources/:sid/annotations"), () => (answer ? answer() : (HttpResponse.json({ annotations: list, count: list.length, textChars: 0 }) as unknown as Response))));
}

beforeEach(() => {
  requests = [];
  serveAnnotations([]);
  server.events.on("request:start", record);
  openPdf.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return { canvas: this, measureText: () => ({ width: 10 }), font: "" } as unknown as CanvasRenderingContext2D;
  } as never);
});
afterEach(async () => {
  cleanup();
  server.events.removeAllListeners();
  vi.restoreAllMocks();
  await new Promise((r) => setTimeout(r, 10));
});

/** The heading of the state shown, which has focus, and its sentence. */
async function expectState(heading: string, sentence: string) {
  const h = await screen.findByRole("heading", { level: 2, name: heading });
  expect(screen.getByText(sentence)).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(h));
  // The screen is otherwise empty: no pages, no toolbar.
  expect(screen.queryByRole("group", { name: "Pages" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
}

describe("ReaderScreen (Task R7)", () => {
  it("each open error shows its sentence", async () => {
    // Refusals of the first range by the service.
    for (const [status, code, heading, sentence] of [
      [423, "PROJECT_LOCKED", "Project locked", SENTENCES.locked],
      [404, "NOT_FOUND", "File not found", SENTENCES.missing],
      [413, "PAYLOAD_TOO_LARGE", "PDF too large", SENTENCES.tooLarge],
    ] as const) {
      serveDocument(4096, () => serviceError(status, code, "the service's own words") as unknown as Response);
      const { unmount } = screenFor();
      await expectState(heading, sentence);
      expect(openPdf).not.toHaveBeenCalled();
      unmount();
    }
    // The service out of reach.
    serveDocument(4096, () => HttpResponse.error() as unknown as Response);
    let r = screenFor();
    await expectState("Library service not reachable", SENTENCES.unreachable);
    r.unmount();
    // A file whose length is over the limit is refused before pdf.js is given it.
    serveDocument(536870913);
    r = screenFor();
    await expectState("PDF too large", SENTENCES.tooLarge);
    expect(openPdf).not.toHaveBeenCalled();
    r.unmount();
    // pdf.js's answers.
    serveDocument();
    for (const [kind, heading, sentence] of [
      ["damaged", "Damaged PDF", SENTENCES.damaged],
      ["password-needed", "Password needed", SENTENCES.password],
      ["missing", "File not found", SENTENCES.missing],
      ["locked", "Project locked", SENTENCES.locked],
      ["other", "PDF not shown", "This PDF could not be opened."],
    ] as const) {
      openPdf.mockRejectedValueOnce(new PdfOpenError(kind));
      const { unmount } = screenFor();
      await expectState(heading, sentence);
      unmount();
    }
  });

  it("a missing file says so with the source's availability", async () => {
    serveDocument(4096, () => serviceError(404, "NOT_FOUND", "The file of this source is not where it was recorded.") as unknown as Response);
    screenFor({ availability: { status: "unavailable-on-platform", firstNoticedAt: "2026-11-10T12:00:00Z" } });
    await expectState("File not found", SENTENCES.missing);
    expect(screen.getByText(/^No longer available at its source/)).toBeTruthy();
  });

  it("the password is never sent to the service", async () => {
    serveDocument();
    const good = fakeHandle(3);
    openPdf.mockImplementation(async (o: { password?: string }) => {
      if (o.password === undefined) throw new PdfOpenError("password-needed");
      if (o.password !== PASSWORD) throw new PdfOpenError("password-wrong");
      return good.handle;
    });
    const user = userEvent.setup();
    screenFor();
    await expectState("Password needed", SENTENCES.password);
    const field = screen.getByLabelText("Password") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("off");

    // A wrong one: said so, the field emptied, focus back on the heading.
    await user.type(field, "not-it");
    await user.click(screen.getByRole("button", { name: "Open" }));
    await expectState("Password needed", SENTENCES.wrongPassword);
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");

    // The right one, by Enter.
    await user.type(screen.getByLabelText("Password"), `${PASSWORD}{Enter}`);
    await screen.findByRole("region", { name: "Page 1 of 3" });
    expect(openPdf).toHaveBeenLastCalledWith(expect.objectContaining({ password: PASSWORD }));
    expect(screen.queryByLabelText("Password")).toBeNull();
    // Focus moved into the pages.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("group", { name: "Pages" })));

    // Nothing of either password reached the service: not in an address, a header or a body.
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      for (const secret of [PASSWORD, "not-it"]) {
        expect(r.url).not.toContain(secret);
        expect(r.headers).not.toContain(secret);
        expect(r.body).not.toContain(secret);
      }
    }
    // Nor is it in the page.
    expect(document.body.innerHTML).not.toContain(PASSWORD);
  });

  it("one press of Open sends one opening", async () => {
    serveDocument();
    let release: (h: PdfHandle) => void = () => {};
    openPdf.mockRejectedValueOnce(new PdfOpenError("password-needed")).mockImplementationOnce(() => new Promise<PdfHandle>((r) => (release = r)));
    const user = userEvent.setup();
    screenFor();
    await screen.findByLabelText("Password");
    await user.type(screen.getByLabelText("Password"), "x");
    const open = screen.getByRole("button", { name: "Open" });
    await user.dblClick(open);
    expect(openPdf).toHaveBeenCalledTimes(2);
    expect(requests.filter((r) => r.url.includes("/document"))).toHaveLength(2);
    release(fakeHandle(1).handle);
    await screen.findByRole("region", { name: "Page 1 of 1" });
  });

  it("a 423 during reading destroys the document", async () => {
    serveDocument();
    const f = fakeHandle(10, { hold: true });
    openPdf.mockResolvedValueOnce(f.handle);
    const { container } = screenFor();
    await screen.findByRole("region", { name: "Page 1 of 10" });
    await flush();
    expect(container.querySelectorAll("canvas").length).toBeGreaterThan(0);

    // A later range refused with 423 while a page is being drawn.
    act(() => f.fail(new PdfOpenError("locked")));
    await expectState("Project locked", SENTENCES.locked);
    expect(f.destroy).toHaveBeenCalled();
    // No drawn page and no text left behind; the drawing let go late brings nothing back.
    expect(container.querySelectorAll("canvas, .ao-reader-text-layer, [data-page-number]").length).toBe(0);
    for (const r of f.holdRenders) r();
    await flush();
    expect(container.querySelectorAll("canvas").length).toBe(0);
    // No making control anywhere while the document is not open again.
    expect(screen.queryAllByRole("button", { name: /highlight|note/i })).toEqual([]);

    // Locked: the way is to the library (A9), not "Open again".
    expect(screen.getByRole("link", { name: "Go to the library" }).getAttribute("href")).toBe("/?project=p1");
    expect(screen.queryByRole("button", { name: "Open again" })).toBeNull();
  });

  it("after a failure in mid-read, Open again opens the file from the start with a new transport and handle", async () => {
    serveDocument();
    const f = fakeHandle(10);
    openPdf.mockResolvedValueOnce(f.handle);
    screenFor();
    await screen.findByRole("region", { name: "Page 1 of 10" });
    act(() => f.fail(new PdfOpenError("other", "The file changed while it was being read. Open it again to read it as it is now.")));
    await expectState("PDF not shown", "The file changed while it was being read. Open it again to read it as it is now.");
    expect(f.destroy).toHaveBeenCalled();
    const before = requests.filter((r) => r.url.includes("/document")).length;
    const again = fakeHandle(10);
    openPdf.mockResolvedValueOnce(again.handle);
    await userEvent.setup().click(screen.getByRole("button", { name: "Open again" }));
    await screen.findByRole("region", { name: "Page 1 of 10" });
    expect(requests.filter((r) => r.url.includes("/document")).length).toBe(before + 1);
    expect(openPdf).toHaveBeenCalledTimes(2);
    expect(openPdf.mock.calls[1]![0].transport).not.toBe(openPdf.mock.calls[0]![0].transport);
  });

  it("a range that cannot reach the service while reading says the service is out of reach", async () => {
    let up = true;
    server.use(
      http.get(url(DOC), ({ request }) => {
        if (!up) return HttpResponse.error();
        const m = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "")!;
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), 4095);
        return new HttpResponse(new Uint8Array(end - start + 1), { status: 206, headers: { "content-type": "application/pdf", "content-range": `bytes ${start}-${end}/4096` } });
      }),
    );
    const f = fakeHandle(4);
    openPdf.mockImplementationOnce(async (o: { transport: { requestDataRange(b: number, e: number): void } }) => {
      // pdf.js asks for a later range; the service has gone meanwhile; the handle then fails.
      up = false;
      o.transport.requestDataRange(2048, 4096);
      await new Promise((r) => setTimeout(r, 30));
      queueMicrotask(() => f.fail(new PdfOpenError("other")));
      return f.handle;
    });
    screenFor();
    await expectState("Library service not reachable", SENTENCES.unreachable);
    expect(f.destroy).toHaveBeenCalled();
  });

  it("leaving the screen destroys the document, and one opened after leaving is destroyed at once", async () => {
    serveDocument();
    const f = fakeHandle(3);
    openPdf.mockResolvedValueOnce(f.handle);
    const a = screenFor();
    await screen.findByRole("region", { name: "Page 1 of 3" });
    a.unmount();
    expect(f.destroy).toHaveBeenCalled();

    let release: (h: PdfHandle) => void = () => {};
    openPdf.mockImplementationOnce(() => new Promise<PdfHandle>((r) => (release = r)));
    const b = screenFor();
    await waitFor(() => expect(openPdf).toHaveBeenCalledTimes(2));
    const signal = openPdf.mock.calls[1]![0].signal as AbortSignal;
    b.unmount();
    expect(signal.aborted).toBe(true);
    const late = fakeHandle(3);
    release(late.handle);
    await flush();
    expect(late.destroy).toHaveBeenCalled();
  });

  it("read-only shows the notice and no making control", async () => {
    serveDocument();
    openPdf.mockResolvedValueOnce(fakeHandle(3).handle);
    screenFor({ readOnly: true });
    await screen.findByRole("region", { name: "Page 1 of 3" });
    expect(screen.getByText(SENTENCES.readOnly)).toBeTruthy();
    // Reading controls only: nothing that makes or changes anything is enabled.
    const enabled = screen.getAllByRole("button").filter((b) => !(b as HTMLButtonElement).disabled).map((b) => b.textContent);
    expect(enabled.sort()).toEqual(["Fit width", "Next page", "Rotate view", "Zoom in", "Zoom out"].sort());
    cleanup();
    openPdf.mockResolvedValueOnce(fakeHandle(3).handle);
    screenFor({ readOnly: false });
    await screen.findByRole("region", { name: "Page 1 of 3" });
    expect(screen.queryByText(SENTENCES.readOnly)).toBeNull();
  });

  it("the toolbar pages, zooms and rotates, says the printed label, and places focus", async () => {
    serveDocument();
    const labels = Array.from({ length: 120 }, (_, i) => (i < 9 ? ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix"][i]! : String(i - 8)));
    openPdf.mockResolvedValueOnce(fakeHandle(120, { labels }).handle);
    const user = userEvent.setup();
    screenFor();
    await screen.findByRole("region", { name: "Page 1 of 120" });
    const toolbar = screen.getByRole("toolbar", { name: "Reader" });
    const field = within(toolbar).getByRole("spinbutton", { name: "Page" }) as HTMLInputElement;
    expect(field.value).toBe("1");
    expect(toolbar.textContent).toContain("of 120 (i)");
    expect(within(toolbar).getByRole("button", { name: "Previous page" })).toHaveProperty("disabled", true);

    // Next page: the field follows, focus stays on the button.
    const next = within(toolbar).getByRole("button", { name: "Next page" });
    await user.click(next);
    expect(field.value).toBe("2");
    expect(document.activeElement).toBe(next);

    // A page typed in: moved there, focus on that page.
    await user.clear(field);
    await user.type(field, "7{Enter}");
    expect(field.value).toBe("7");
    expect(toolbar.textContent).toContain("of 120 (vii)");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Page 7 of 120" })));
    // Past the end: the last page.
    await user.clear(field);
    await user.type(field, "999{Enter}");
    expect(field.value).toBe("120");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Page 120 of 120" })));
    expect(within(toolbar).getByRole("button", { name: "Next page" })).toHaveProperty("disabled", true);
    // Where the label equals the number, nothing in brackets.
    await user.clear(field);
    await user.type(field, "12{Enter}");
    expect(toolbar.textContent).toContain("of 120 (3)");

    // Zoom: 100% to start, steps up to 400% and down to 50%, and no further.
    const zoom = within(toolbar).getByRole("status", { name: "Zoom" });
    expect(zoom.textContent).toBe("100%");
    const zoomIn = within(toolbar).getByRole("button", { name: "Zoom in" });
    for (let i = 0; i < 12; i++) if (!(zoomIn as HTMLButtonElement).disabled) await user.click(zoomIn);
    expect(zoom.textContent).toBe("400%");
    expect(zoomIn).toHaveProperty("disabled", true);
    const zoomOut = within(toolbar).getByRole("button", { name: "Zoom out" });
    for (let i = 0; i < 20; i++) if (!(zoomOut as HTMLButtonElement).disabled) await user.click(zoomOut);
    expect(zoom.textContent).toBe("50%");
    expect(zoomOut).toHaveProperty("disabled", true);
    expect(screen.getByRole("region", { name: "Page 12 of 120" }).style.width).toBe("396px");

    // Fit width: the page's width fills the page area (1190 px of 1224: 150% of 793 px).
    const scroller = screen.getByRole("group", { name: "Pages" });
    Object.defineProperty(scroller, "clientWidth", { value: 1224, configurable: true });
    await user.click(within(toolbar).getByRole("button", { name: "Fit width" }));
    await waitFor(() => expect(zoom.textContent).toBe("150%"));

    // Rotate view: the page's box turns; nothing is sent anywhere.
    const before = requests.length;
    await user.click(within(toolbar).getByRole("button", { name: "Rotate view" }));
    const p12 = screen.getByRole("region", { name: "Page 12 of 120" });
    expect([p12.style.width, p12.style.height]).toEqual(["1684px", "1190px"]);
    expect(requests.length).toBe(before);
  });

  it("Page Down, Page Up, Home, End, + and - work on the page area and keep focus on the page", async () => {
    serveDocument();
    openPdf.mockResolvedValueOnce(fakeHandle(30).handle);
    screenFor();
    await screen.findByRole("region", { name: "Page 1 of 30" });
    const area = screen.getByRole("group", { name: "Pages" });
    const field = screen.getByRole("spinbutton", { name: "Page" }) as HTMLInputElement;
    const zoom = screen.getByRole("status", { name: "Zoom" });
    area.focus();
    fireEvent.keyDown(area, { key: "PageDown" });
    expect(field.value).toBe("2");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Page 2 of 30" })));
    // From the page itself (focus is there now), the keys still work.
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(field.value).toBe("30");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Page 30 of 30" })));
    fireEvent.keyDown(document.activeElement!, { key: "PageUp" });
    expect(field.value).toBe("29");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(field.value).toBe("1");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Page 1 of 30" })));
    fireEvent.keyDown(document.activeElement!, { key: "+" });
    expect(zoom.textContent).toBe("125%");
    fireEvent.keyDown(document.activeElement!, { key: "-" });
    fireEvent.keyDown(document.activeElement!, { key: "-" });
    expect(zoom.textContent).toBe("75%");
    expect(document.activeElement).toBe(screen.getByLabelText("Page 1 of 30"));
    // The keys are the page area's only: typed into the page field they do nothing of the sort.
    fireEvent.keyDown(field, { key: "End" });
    expect(field.value).toBe("1");
  });
  it("Open again is offered only where trying again can help; a locked project points to the library (A9)", async () => {
    const offers = () => ({
      again: screen.queryByRole("button", { name: "Open again" }) !== null,
      library: screen.queryByRole("link", { name: "Go to the library" })?.getAttribute("href") ?? null,
    });
    const cases: Array<[() => void, string, string, { again: boolean; library: string | null }]> = [
      [() => serveDocument(4096, () => serviceError(423, "PROJECT_LOCKED", "x") as unknown as Response), "Project locked", SENTENCES.locked, { again: false, library: "/?project=p1" }],
      [() => serveDocument(4096, () => serviceError(404, "NOT_FOUND", "x") as unknown as Response), "File not found", SENTENCES.missing, { again: true, library: null }],
      [() => serveDocument(4096, () => serviceError(413, "PAYLOAD_TOO_LARGE", "x") as unknown as Response), "PDF too large", SENTENCES.tooLarge, { again: false, library: null }],
      [() => serveDocument(4096, () => serviceError(400, "VALIDATION", "This file cannot be shown here.") as unknown as Response), "Not a PDF", "This file cannot be shown here.", { again: false, library: null }],
      [() => serveDocument(4096, () => HttpResponse.error() as unknown as Response), "Library service not reachable", SENTENCES.unreachable, { again: true, library: null }],
      [() => (serveDocument(), openPdf.mockRejectedValueOnce(new PdfOpenError("damaged"))), "Damaged PDF", SENTENCES.damaged, { again: true, library: null }],
      [() => (serveDocument(), openPdf.mockRejectedValueOnce(new PdfOpenError("other", "The file changed while it was being read. Open it again to read it as it is now."))), "PDF not shown", "The file changed while it was being read. Open it again to read it as it is now.", { again: true, library: null }],
    ];
    for (const [setUp, heading, sentence, want] of cases) {
      setUp();
      const { unmount } = screenFor();
      await expectState(heading, sentence);
      expect(offers(), heading).toEqual(want);
      unmount();
    }
    // In mid-read: any failure offers it again, except a lock, which points to the library.
    for (const [kind, want] of [
      ["missing", { again: true, library: null }],
      ["other", { again: true, library: null }],
      ["locked", { again: false, library: "/?project=p1" }],
    ] as const) {
      serveDocument();
      const f = fakeHandle(3);
      openPdf.mockResolvedValueOnce(f.handle);
      const { unmount } = screenFor();
      await screen.findByRole("region", { name: "Page 1 of 3" });
      act(() => f.fail(new PdfOpenError(kind)));
      await screen.findByRole("heading", { level: 2 });
      expect(offers(), kind).toEqual(want);
      unmount();
    }
  });

  it("a control disabled while it has focus hands focus to its neighbour, never to the page's body (A9, R145)", async () => {
    serveDocument();
    openPdf.mockResolvedValueOnce(fakeHandle(3).handle);
    const user = userEvent.setup();
    screenFor();
    await screen.findByRole("region", { name: "Page 1 of 3" });
    const button = (name: string) => screen.getByRole("button", { name });
    // Next page on the last page: focus to Previous page.
    await user.click(button("Next page"));
    expect(document.activeElement).toBe(button("Next page"));
    await user.click(button("Next page"));
    expect(button("Next page")).toHaveProperty("disabled", true);
    expect(document.activeElement).toBe(button("Previous page"));
    // Previous page on the first page: focus to Next page.
    await user.click(button("Previous page"));
    await user.click(button("Previous page"));
    expect(button("Previous page")).toHaveProperty("disabled", true);
    expect(document.activeElement).toBe(button("Next page"));
    // Zoom in at 400%: focus to Zoom out; Zoom out at 50%: focus to Zoom in.
    while (!(button("Zoom in") as HTMLButtonElement).disabled) await user.click(button("Zoom in"));
    expect(document.activeElement).toBe(button("Zoom out"));
    while (!(button("Zoom out") as HTMLButtonElement).disabled) await user.click(button("Zoom out"));
    expect(document.activeElement).toBe(button("Zoom in"));
    // By keyboard as well (Enter on the focused button).
    while (!(button("Zoom in") as HTMLButtonElement).disabled) {
      button("Zoom in").focus();
      await user.keyboard("{Enter}");
    }
    expect(document.activeElement).toBe(button("Zoom out"));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("100% is the page's printed size: 96 CSS pixels to the inch, as pdf.js's viewer and Zotero show it", async () => {
    serveDocument();
    openPdf.mockResolvedValueOnce(fakeHandle(2).handle);
    screenFor();
    const p1 = await screen.findByRole("region", { name: "Page 1 of 2" });
    expect(screen.getByRole("status", { name: "Zoom" }).textContent).toBe("100%");
    // An A4 page is 595 points wide: 793 CSS pixels at 100%.
    expect([p1.style.width, p1.style.height]).toEqual(["793px", "1122px"]);
  });
});

/** A server-sent event stream the test writes to. */
function eventStream() {
  const enc = new TextEncoder();
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const queued: string[] = [];
  const send = (type: string, data: unknown) => {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    if (ctrl) ctrl.enqueue(enc.encode(frame));
    else queued.push(frame);
  };
  const response = () =>
    new HttpResponse(
      new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          for (const f of queued.splice(0)) c.enqueue(enc.encode(f));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  return { send, response };
}

describe("ReaderRoute: the reader ends at once when its project is locked or its library closed (A9, Ruling R203)", () => {
  const LIB = { libraryId: "lib-1", name: "Thesis library", mode: "read-write" };
  const STATE = { open: true, ...LIB, integrityWarnings: [], projectWarnings: {} };
  const textHandle = () => {
    const f = fakeHandle(3);
    // Every page has text: its text layer is in the page.
    const doc = f.handle.doc as unknown as { getPage(n: number): Promise<Record<string, unknown>> };
    const getPage = doc.getPage.bind(doc);
    doc.getPage = async (n: number) => ({
      ...(await getPage(n)),
      getTextContent: async () => ({
        items: [{ str: `Words of page ${n}`, dir: "ltr", transform: [10, 0, 0, 10, 50, 700], width: 100, height: 10, fontName: "f1", hasEOL: false }],
        styles: { f1: { fontFamily: "sans-serif", ascent: 0.8, descent: -0.2, vertical: false } },
        lang: null,
      }),
    });
    return f;
  };

  const projectsAnswer = (unlocked: boolean) => HttpResponse.json({ projects: [{ id: "p1", name: "Dissertation", folder: "Dissertation", encrypted: true, unlocked }] }) as unknown as Response;

  function serveRoute(o: { unlocked: () => boolean; current?: Record<string, unknown>; projects?: (request: Request) => Response | Promise<Response> }) {
    const events = eventStream();
    const projectReads: number[] = [];
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: o.current ?? LIB })),
      http.get(url("/projects/:id/sources/:sid"), () => HttpResponse.json(SOURCE_FILE)),
      http.get(url("/projects"), ({ request }) => {
        projectReads.push(Date.now());
        return o.projects ? o.projects(request) : projectsAnswer(o.unlocked());
      }),
      http.get(url("/events"), () => events.response()),
    );
    serveDocument();
    return { events, projectReads };
  }

  async function openRoute(f: Fake) {
    openPdf.mockResolvedValueOnce(f.handle);
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    const r = render(<ReaderRoute client={testClient()} loc={{ pathname: "/reader", search: "?project=p1&source=s1" }} />);
    await screen.findByRole("region", { name: "Page 1 of 3" });
    await waitFor(() => expect(r.container.querySelector(".ao-reader-text-layer")?.textContent).toContain("Words of page 1"));
    await flush();
    expect(r.container.querySelectorAll("canvas").length).toBeGreaterThan(0);
    return r;
  }

  /** Nothing of the document is in the page: no canvas, no text layer, no page, no word of it; nothing of its annotations (R8). */
  function expectNothingLeft(container: HTMLElement) {
    expect(container.querySelectorAll("canvas, .ao-reader-text-layer, [data-page-number]").length).toBe(0);
    expect(document.body.textContent).not.toContain("Words of page");
    expect(container.querySelectorAll(".ao-hl, .ao-hl-layer, .ao-reader-hl-notices").length).toBe(0);
    expect(document.body.textContent).not.toContain("A quote that is not there");
    expect(document.querySelectorAll("canvas").length === 0 || [...document.querySelectorAll("canvas")].every((c) => !c.isConnected || c.width * c.height === 0)).toBe(true);
  }

  afterEach(() => window.history.replaceState(null, "", "/"));

  it("a lock of its project, with every page already fetched, ends the reader at once", async () => {
    let unlocked = true;
    const svc = serveRoute({ unlocked: () => unlocked });
    // Two highlights on page 1 (R8): one on its words, one whose text has changed, said so on screen.
    const at = { id: "", assetId: "a1", page: 1, rects: [{ x: 50, y: 698, w: 100, h: 10 }], sortIndex: "00000|000000|00000", sortIndexDerived: false };
    const hl = (id: string, quote: string): AnnotationRecord => ({ id, sourceId: "s1", kind: "highlight", pdfAnchors: [{ ...at, id: `${id}-a` }], otherAnchorKinds: [], quote, colorName: "blue", imported: true, author: "me", createdAt: "2026-11-13T10:00:00Z" });
    serveAnnotations([hl("on-words", "Words of page 1"), hl("changed", "A quote that is not there")]);
    const f = textHandle();
    const { container } = await openRoute(f);
    await waitFor(() => expect(container.querySelectorAll('[data-page-number="1"] .ao-hl')).toHaveLength(2));
    await waitFor(() => expect(container.querySelector(".ao-reader-hl-notices")?.textContent).toContain("A quote that is not there"));
    const documentCalls = requests.filter((r) => r.url.includes("/document")).length;
    svc.events.send("library.state", STATE);
    await flush();
    // Still unlocked: nothing changes.
    expect(screen.getByRole("region", { name: "Page 1 of 3" })).toBeTruthy();
    expect(f.destroy).not.toHaveBeenCalled();

    // Locked elsewhere (the state event names no project: the reader asks once).
    unlocked = false;
    const reads = svc.projectReads.length;
    svc.events.send("library.state", STATE);
    const heading = await screen.findByRole("heading", { level: 2, name: "Project locked" });
    expect(screen.getByText(SENTENCES.locked)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByRole("link", { name: "Go to the library" }).getAttribute("href")).toBe("/?project=p1");
    expect(screen.queryByRole("button", { name: "Open again" })).toBeNull();
    expect(svc.projectReads.length).toBe(reads + 1);
    expect(f.destroy).toHaveBeenCalled();
    expectNothingLeft(container);
    // Nothing was read of the document to learn it.
    expect(requests.filter((r) => r.url.includes("/document")).length).toBe(documentCalls);
  });

  it("the library closed or another one opened ends the reader at once, without asking about the project", async () => {
    for (const state of [{ open: false }, { ...STATE, libraryId: "lib-2", name: "Grant 2025" }]) {
      const svc = serveRoute({ unlocked: () => true });
      const f = textHandle();
      const { container, unmount } = await openRoute(f);
      const reads = svc.projectReads.length;
      svc.events.send("library.state", state);
      await screen.findByRole("heading", { level: 2, name: "Library closed" });
      expect(screen.getByText("The library this source belongs to is no longer open, so its files cannot be shown.")).toBeTruthy();
      expect(screen.getByRole("link", { name: "Go to the library" })).toBeTruthy();
      expect(svc.projectReads.length).toBe(reads);
      expect(f.destroy).toHaveBeenCalled();
      expectNothingLeft(container);
      unmount();
    }
  });

  it("the library turning read-only while reading shows the notice (the mode is followed)", async () => {
    const svc = serveRoute({ unlocked: () => true });
    await openRoute(textHandle());
    expect(screen.queryByText(SENTENCES.readOnly)).toBeNull();
    svc.events.send("library.state", { ...STATE, mode: "read-only", readOnlyReason: "locked-by-other-device" });
    expect(await screen.findByText(SENTENCES.readOnly)).toBeTruthy();
    // Still reading the same document.
    expect(screen.getByRole("region", { name: "Page 1 of 3" })).toBeTruthy();
  });

  it("a project locked before the reader listened is caught by the first state the reader hears", async () => {
    let unlocked = true;
    const svc = serveRoute({ unlocked: () => unlocked });
    const f = textHandle();
    await openRoute(f);
    unlocked = false;
    // The first state the stream sends on connecting.
    svc.events.send("library.state", STATE);
    await screen.findByRole("heading", { level: 2, name: "Project locked" });
    expect(f.destroy).toHaveBeenCalled();
  });

  it("a project no longer in the library ends the reader with Project not found (A10)", async () => {
    const svc = serveRoute({ unlocked: () => true, projects: () => HttpResponse.json({ projects: [] }) });
    const f = textHandle();
    const { container } = await openRoute(f);
    svc.events.send("library.state", STATE);
    const heading = await screen.findByRole("heading", { level: 2, name: "Project not found" });
    expect(screen.getByText("This project is no longer in the library, so its files cannot be shown.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByRole("link", { name: "Go to the library" })).toBeTruthy();
    expect(f.destroy).toHaveBeenCalled();
    expectNothingLeft(container);
  });

  describe("the lock question never fails open (A10, Ruling R205)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a 500 then a locked answer ends the reader after the retry", async () => {
      const answers: Array<() => Response> = [() => serviceError(500, "INTERNAL", "x") as unknown as Response, () => projectsAnswer(false)];
      const svc = serveRoute({ unlocked: () => true, projects: () => (answers.shift() ?? (() => projectsAnswer(false)))() });
      const f = textHandle();
      await openRoute(f);
      svc.events.send("library.state", STATE);
      await waitFor(() => expect(svc.projectReads.length).toBe(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      // The question failed: the reader stays, nothing is ended for that alone.
      expect(f.destroy).not.toHaveBeenCalled();
      expect(screen.getByRole("region", { name: "Page 1 of 3" })).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(QUESTION_RETRY_MS);
      });
      await screen.findByRole("heading", { level: 2, name: "Project locked" });
      expect(svc.projectReads.length).toBe(2);
      expect(f.destroy).toHaveBeenCalled();
    });

    it("a question that never answers is given up at 5 s and asked again", async () => {
      const signals: AbortSignal[] = [];
      let calls = 0;
      const svc = serveRoute({
        unlocked: () => true,
        projects: async (request) => {
          calls++;
          if (calls === 1) {
            signals.push(request.signal);
            await new Promise<void>((r) => request.signal.addEventListener("abort", () => r()));
            return HttpResponse.error() as unknown as Response;
          }
          return projectsAnswer(false);
        },
      });
      const f = textHandle();
      await openRoute(f);
      svc.events.send("library.state", STATE);
      await waitFor(() => expect(calls).toBe(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(QUESTION_TIMEOUT_MS - 100);
      });
      expect(signals[0]!.aborted).toBe(false);
      expect(calls).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(signals[0]!.aborted).toBe(true);
      expect(f.destroy).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(QUESTION_RETRY_MS);
      });
      await screen.findByRole("heading", { level: 2, name: "Project locked" });
      expect(calls).toBe(2);
    });

    it("no timer or request is left after the reader goes", async () => {
      let calls = 0;
      const signals: AbortSignal[] = [];
      const svc = serveRoute({
        unlocked: () => true,
        projects: async (request) => {
          calls++;
          signals.push(request.signal);
          if (calls === 1) return serviceError(500, "INTERNAL", "x") as unknown as Response;
          await new Promise<void>((r) => request.signal.addEventListener("abort", () => r()));
          return HttpResponse.error() as unknown as Response;
        },
      });
      const f = textHandle();
      const r = await openRoute(f);
      svc.events.send("library.state", STATE);
      await waitFor(() => expect(calls).toBe(1));
      // A retry is waiting: leaving cancels it.
      r.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(QUESTION_RETRY_MS + QUESTION_TIMEOUT_MS * 3);
      });
      expect(calls).toBe(1);

      // A request in flight: leaving aborts it, and nothing follows.
      calls = 0;
      signals.length = 0;
      const svc2 = serveRoute({
        unlocked: () => true,
        projects: async (request) => {
          calls++;
          signals.push(request.signal);
          await new Promise<void>((res) => request.signal.addEventListener("abort", () => res()));
          return HttpResponse.error() as unknown as Response;
        },
      });
      const r2 = await openRoute(textHandle());
      svc2.events.send("library.state", STATE);
      await waitFor(() => expect(calls).toBe(1));
      r2.unmount();
      await waitFor(() => expect(signals[0]!.aborted).toBe(true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(QUESTION_RETRY_MS + QUESTION_TIMEOUT_MS * 3);
      });
      expect(calls).toBe(1);
    });

    it("a burst of states while a retry waits still makes one request at a time", async () => {
      let inFlight = 0;
      let most = 0;
      let calls = 0;
      const svc = serveRoute({
        unlocked: () => true,
        projects: async () => {
          calls++;
          inFlight++;
          most = Math.max(most, inFlight);
          await new Promise((r) => setTimeout(r, 50));
          inFlight--;
          return calls < 3 ? (serviceError(500, "INTERNAL", "x") as unknown as Response) : projectsAnswer(true);
        },
      });
      const f = textHandle();
      await openRoute(f);
      svc.events.send("library.state", STATE);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      for (let i = 0; i < 8; i++) svc.events.send("library.state", STATE);
      for (let i = 0; i < 6; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(QUESTION_RETRY_MS);
        });
      }
      expect(most).toBe(1);
      // Two failures, then answered; the burst adds at most one more question after the answer.
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(calls).toBeLessThanOrEqual(4);
      expect(f.destroy).not.toHaveBeenCalled();
    });
  });
});

describe("ReaderScreen, fix round 2 (A10)", () => {
  beforeEach(() => {
    requests = [];
    server.events.on("request:start", record);
    openPdf.mockReset();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      return { canvas: this, measureText: () => ({ width: 10 }), font: "" } as unknown as CanvasRenderingContext2D;
    } as never);
  });

  it("not a PDF is told by the error's kind, not by its sentence: a reworded message still says Not a PDF", async () => {
    serveDocument();
    openPdf.mockRejectedValueOnce(new PdfOpenError("not-a-pdf", "Some other words for a file that is not a PDF."));
    screenFor();
    await screen.findByRole("heading", { level: 2, name: "Not a PDF" });
    expect(screen.getByText("This file cannot be shown here.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open again" })).toBeNull();
  });

  it("focus is handed over whenever a focused button becomes disabled, however the limit was reached (scrolling here)", async () => {
    serveDocument();
    openPdf.mockResolvedValueOnce(fakeHandle(5).handle);
    screenFor();
    await screen.findByRole("region", { name: "Page 1 of 5" });
    const button = (name: string) => screen.getByRole("button", { name });
    const scroller = screen.getByRole("group", { name: "Pages" });
    const scrollTo = (n: number) => {
      const box = scroller.querySelector<HTMLElement>(`[data-page-number="${n}"]`)!;
      act(() => {
        scroller.scrollTop = Number(box.dataset.top) + 5;
        scroller.dispatchEvent(new Event("scroll"));
      });
    };
    // Focus on Next page; the last page is reached by scrolling, not by a press.
    button("Next page").focus();
    scrollTo(5);
    await waitFor(() => expect(button("Next page")).toHaveProperty("disabled", true));
    await waitFor(() => expect(document.activeElement).toBe(button("Previous page")));
    // Focus on Previous page; the first page is reached by scrolling.
    scrollTo(1);
    await waitFor(() => expect(button("Previous page")).toHaveProperty("disabled", true));
    await waitFor(() => expect(document.activeElement).toBe(button("Next page")));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a key that leaves the page where it is (Home on page 1, - at 50%) leaves no focus request to steal the focus later", async () => {
    serveDocument();
    openPdf.mockResolvedValueOnce(fakeHandle(5).handle);
    screenFor();
    await screen.findByRole("region", { name: "Page 1 of 5" });
    const area = screen.getByRole("group", { name: "Pages" });
    area.focus();
    // Home on the first page: the page focused at once, nothing left pending.
    fireEvent.keyDown(area, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Page 1 of 5")));
    for (let i = 0; i < 4; i++) fireEvent.keyDown(document.activeElement!, { key: "-" });
    expect(screen.getByRole("status", { name: "Zoom" }).textContent).toBe("50%");
    expect(document.activeElement).toBe(screen.getByLabelText("Page 1 of 5"));
    // The researcher moves to a button; the page then changes by scrolling: focus stays where they put it.
    const next = screen.getByRole("button", { name: "Next page" });
    next.focus();
    const box = area.querySelector<HTMLElement>('[data-page-number="2"]')!;
    act(() => {
      area.scrollTop = Number(box.dataset.top) + 5;
      area.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect((screen.getByRole("spinbutton", { name: "Page" }) as HTMLInputElement).value).toBe("2"));
    await flush();
    await new Promise((r) => setTimeout(r, 120));
    expect(document.activeElement).toBe(next);
  });
});

describe("ReaderScreen: highlights drawn in place (Task R8)", () => {
  /** "Words of page n" in 10-point Helvetica at x 50, baseline 700 (73.37 points long), on every page. */
  const words = (n: number) => [textItem(`Words of page ${n}`, 50, 700, 10, 73.37)];
  /** Its glyphs' box: what a highlight of those words stores. */
  const onWords = [{ x: 50, y: 700 - 2.07, w: 73.37, h: 9.25 }];
  let made = 0;
  function rec(o: Partial<AnnotationRecord> & { page?: number; assetId?: string; rects?: Array<{ x: number; y: number; w: number; h: number }> }): AnnotationRecord {
    const id = o.id ?? `an-${++made}`;
    const { page = 1, assetId = "a1", rects = onWords, ...rest } = o;
    return {
      id,
      sourceId: "s1",
      kind: "highlight",
      pdfAnchors: [{ id: `${id}-a`, assetId, page, rects, sortIndex: "00000|000000|00000", sortIndexDerived: true }],
      otherAnchorKinds: [],
      quote: `Words of page ${page}`,
      colorName: "yellow",
      imported: false,
      author: "me",
      createdAt: "2026-11-13T10:00:00Z",
      ...rest,
    };
  }
  const drawnOn = (n: number) => [...document.querySelectorAll<HTMLElement>(`[data-page-number="${n}"] .ao-hl`)].map((e) => e.dataset.annotation);
  const CHANGED = "The text here has changed since this highlight was made.";

  it("this file's annotations are drawn on their pages, imported and new alike; another file's are not", async () => {
    serveDocument();
    serveAnnotations([
      rec({ id: "imported", imported: true, importedColour: "#ffd400" }),
      rec({ id: "made", colorName: "green" }),
      rec({ id: "other-file", assetId: "a2" }),
      rec({ id: "page-2", page: 2 }),
      rec({ id: "no-place", pdfAnchors: [] }),
    ]);
    openPdf.mockResolvedValueOnce(fakeHandle(3, { text: words }).handle);
    screenFor();
    await screen.findByRole("region", { name: "Page 1 of 3" });
    await waitFor(() => expect(drawnOn(1)).toEqual(["imported", "made"]));
    await waitFor(() => expect(drawnOn(2)).toEqual(["page-2"]));
    // Both drawn by the same code at the same place; the colour by class only.
    const [a, b] = [...document.querySelectorAll<HTMLElement>('[data-page-number="1"] .ao-hl')];
    expect(a!.getAttribute("style")).toBe(b!.getAttribute("style"));
    expect(a!.classList.contains("ao-hl--yellow")).toBe(true);
    expect(b!.classList.contains("ao-hl--green")).toBe(true);
    // At 100% (4/3 CSS pixels a point): x from 50, top from 842 − 707.18.
    expect(parseFloat(a!.style.left)).toBeCloseTo(50 * (4 / 3), 4);
    expect(parseFloat(a!.style.top)).toBeCloseTo((842 - (700 - 2.07 + 9.25)) * (4 / 3), 4);
    // The overlay is hidden from assistive technology; nothing of the quotes is in it.
    expect(document.querySelector(".ao-hl-layer")!.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByText(CHANGED, { exact: false })).toBeNull();
  });

  it("a highlight whose text no longer matches says so and is drawn dashed; one on a page the file does not have says so; a page not drawn says nothing yet", async () => {
    serveDocument();
    const textReads: number[] = [];
    serveAnnotations([
      rec({ id: "same" }),
      rec({ id: "changed", quote: "Other words entirely" }),
      rec({ id: "far", page: 412, quote: "On a page long gone" }),
      rec({ id: "unseen", page: 12, quote: "Not what page 12 says" }),
    ]);
    openPdf.mockResolvedValueOnce(fakeHandle(12, { text: words, textReads }).handle);
    screenFor();
    await screen.findByRole("region", { name: "Page 1 of 12" });
    const notices = await screen.findByRole("region", { name: "Highlights to check" });
    await waitFor(() => expect(notices.textContent).toContain(CHANGED));
    expect(notices.textContent).toContain("This highlight is on page 412, which this file does not have.");
    const items = within(notices).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Page 1, “Other words entirely”: " + CHANGED, "Page 412, “On a page long gone”: This highlight is on page 412, which this file does not have."]);
    expect(document.querySelector('[data-annotation="changed"]')!.classList.contains("ao-hl--changed")).toBe(true);
    expect(document.querySelector('[data-annotation="same"]')!.classList.contains("ao-hl--changed")).toBe(false);
    // Page 12 is not drawn: its highlight is not checked, and nothing is said of it.
    expect(notices.textContent).not.toContain("Not what page 12 says");
    // The text was read once a drawn page, by the pages themselves: never a second time to check quotes.
    expect(textReads.length).toBeGreaterThan(0);
    for (const n of new Set(textReads)) expect(textReads.filter((r) => r === n)).toHaveLength(1);
    expect(textReads).not.toContain(12);
  });

  it("clicking a highlight selects it", async () => {
    serveDocument();
    serveAnnotations([rec({ id: "one" })]);
    openPdf.mockResolvedValueOnce(fakeHandle(2, { text: words }).handle);
    screenFor();
    const page = await screen.findByRole("region", { name: "Page 1 of 2" });
    await waitFor(() => expect(drawnOn(1)).toEqual(["one"]));
    const mark = document.querySelector<HTMLElement>('[data-annotation="one"]')!;
    fireEvent.click(page, { clientX: parseFloat(mark.style.left) + 5, clientY: parseFloat(mark.style.top) + 5 });
    await waitFor(() => expect(document.querySelector('[data-annotation="one"]')!.classList.contains("ao-hl--selected")).toBe(true));
  });

  it("a 423 while the list is asked for: nothing of the annotations is left, and its answer arriving afterwards is dropped", async () => {
    serveDocument();
    let answer: (r: Response) => void = () => {};
    const held = new Promise<Response>((r) => (answer = r));
    serveAnnotations([], () => held);
    const f = fakeHandle(3, { text: words });
    openPdf.mockResolvedValueOnce(f.handle);
    const { container } = screenFor();
    await screen.findByRole("region", { name: "Page 1 of 3" });
    await waitFor(() => expect(requests.some((r) => r.url.endsWith("/annotations"))).toBe(true));
    await flush();
    act(() => f.fail(new PdfOpenError("locked")));
    await expectState("Project locked", SENTENCES.locked);
    // The list's answer comes late: dropped.
    answer(HttpResponse.json({ annotations: [rec({ id: "late", quote: "a late quote" })], count: 1, textChars: 12 }) as unknown as Response);
    await flush();
    expect(container.querySelectorAll(".ao-hl, .ao-hl-layer").length).toBe(0);
    expect(document.body.textContent).not.toContain("a late quote");
    expect(screen.queryByRole("region", { name: "Highlights to check" })).toBeNull();
  });

  it("highlights drawn, then a 423: every highlight, quote and notice goes with the document", async () => {
    serveDocument();
    serveAnnotations([rec({ id: "kept" }), rec({ id: "changed", quote: "Some quoted words" })]);
    const f = fakeHandle(3, { text: words });
    openPdf.mockResolvedValueOnce(f.handle);
    const { container } = screenFor();
    await screen.findByRole("region", { name: "Page 1 of 3" });
    await waitFor(() => expect(drawnOn(1)).toEqual(["kept", "changed"]));
    await screen.findByRole("region", { name: "Highlights to check" });
    act(() => f.fail(new PdfOpenError("locked")));
    await expectState("Project locked", SENTENCES.locked);
    expect(container.querySelectorAll(".ao-hl, .ao-hl-layer").length).toBe(0);
    expect(document.body.textContent).not.toContain("Some quoted words");
    expect(screen.queryByRole("region", { name: "Highlights to check" })).toBeNull();
  });

  it("a list answer arriving after the screen left is dropped, quietly", async () => {
    serveDocument();
    let answer: (r: Response) => void = () => {};
    const held = new Promise<Response>((r) => (answer = r));
    serveAnnotations([], () => held);
    openPdf.mockResolvedValueOnce(fakeHandle(2, { text: words }).handle);
    const errors = vi.spyOn(console, "error");
    const { unmount } = screenFor();
    await screen.findByRole("region", { name: "Page 1 of 2" });
    await waitFor(() => expect(requests.some((r) => r.url.endsWith("/annotations"))).toBe(true));
    unmount();
    answer(HttpResponse.json({ annotations: [rec({ id: "late", quote: "a late quote" })], count: 1, textChars: 12 }) as unknown as Response);
    await flush();
    expect(document.body.textContent).not.toContain("a late quote");
    expect(errors).not.toHaveBeenCalled();
  });

  it("the list is asked for once an opening, with ids only; a refused list says so in plain words and the pages still read", async () => {
    serveDocument();
    serveAnnotations([], () => serviceError(403, "POLICY_DENIED", "This project's rules do not allow it.") as unknown as Response);
    openPdf.mockResolvedValueOnce(fakeHandle(2, { text: words }).handle);
    screenFor();
    await screen.findByRole("region", { name: "Page 1 of 2" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The highlights of this file could not be shown: This project's rules do not allow it.");
    expect(requests.filter((r) => r.url.endsWith("/annotations")).map((r) => new URL(r.url).pathname)).toEqual(["/projects/p1/sources/s1/annotations"]);
    expect(screen.getByRole("region", { name: "Page 1 of 2" })).toBeTruthy();
  });
});
