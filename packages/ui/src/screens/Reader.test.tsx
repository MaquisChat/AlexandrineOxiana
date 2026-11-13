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
import { readerApi } from "../api/reader";
import { PdfOpenError, type PdfHandle } from "../reader/pdfjs";
import { server, serviceError, testClient, url, useMockService } from "../test/service";
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

/** A stand-in open document of `pages` A4 pages without text. */
function fakeHandle(pages = 12, opts: { labels?: string[] | null; hold?: boolean } = {}): Fake {
  let fail: (e: PdfOpenError) => void = () => {};
  const failed = new Promise<PdfOpenError>((r) => {
    fail = r;
  });
  let dead = false;
  const holdRenders: Array<() => void> = [];
  const destroy = vi.fn(async () => {
    dead = true;
  });
  const vp = (scale: number, rotation: number) => ({ width: (rotation % 180 ? 842 : 595) * scale, height: (rotation % 180 ? 595 : 842) * scale, scale, rotation, rawDims: { pageWidth: 595, pageHeight: 842, pageX: 0, pageY: 0 } });
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
    getTextContent: async () => ({ items: [], styles: {}, lang: null }),
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

beforeEach(() => {
  requests = [];
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

    // "Open again" opens it from the start: a new first range and a new handle; the dead one is never reused.
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
    expect(screen.getByRole("region", { name: "Page 12 of 120" }).style.width).toBe("297px");

    // Fit width: the page's width fills the page area.
    const scroller = screen.getByRole("group", { name: "Pages" });
    Object.defineProperty(scroller, "clientWidth", { value: 1224, configurable: true });
    await user.click(within(toolbar).getByRole("button", { name: "Fit width" }));
    await waitFor(() => expect(zoom.textContent).toBe("200%"));

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
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Page 1 of 30" }));
    // The keys are the page area's only: typed into the page field they do nothing of the sort.
    fireEvent.keyDown(field, { key: "End" });
    expect(field.value).toBe("1");
  });
});
