/**
 * FR-756 (R584, R586): "Opening the PDF…". The reader asks the service for the file's first part (a byte range) and
 * pdf.js asks for the parts it needs while the document opens. An ask whose answer has not BEGUN within the limit is
 * given up and the screen says the service did not answer in time, with "Open again". The limit is on the answer
 * beginning only: a part whose answer has begun is never cut, however slowly its bytes arrive (a large file on a slow
 * drive). A range that FAILS for want of an answer keeps "could not be reached".
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readerApi } from "../api/reader";
import type { PDFDataRangeTransport } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PdfOpenError, type PdfHandle } from "../reader/pdfjs";
import { onRangeFailure } from "../reader/rangeTransport";
import { hang, server, testClient, url, useMockService } from "../test/service";
import { ReaderScreen } from "./Reader";

const openPdf = vi.hoisted(() => vi.fn());
vi.mock("../reader/pdfjs", async (importOriginal) => ({ ...(await importOriginal<typeof import("../reader/pdfjs")>()), openPdf }));

useMockService();

const DOC = "/projects/:id/sources/:sid/assets/:aid/document";
const NO_ANSWER_HEADING = "Library service did not answer";
const NO_ANSWER = "The library service did not answer in time, so this PDF cannot be shown. Try again in a moment.";
const UNREACHABLE = "The library service could not be reached, so this PDF cannot be shown. Try again in a moment.";
const TOTAL = 4096;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in open document (no pages are drawn in these tests: one page, no text). */
function handle(): PdfHandle {
  return {
    doc: { numPages: 1, getPage: () => new Promise(() => {}) },
    pageCount: 1,
    pageLabels: null,
    failed: new Promise(() => {}),
    dead: false,
    destroy: async () => {},
  } as unknown as PdfHandle;
}

/** A 206 for the asked range of a TOTAL-byte file, its body sent in `parts` pieces `gapMs` apart. */
function slowRange(request: Request, parts: number, gapMs: number): Response {
  const m = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "")!;
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), TOTAL - 1);
  const length = end - start + 1;
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      const size = Math.ceil(length / parts);
      for (let at = 0; at < length; at += size) {
        if (at > 0) await sleep(gapMs);
        c.enqueue(new Uint8Array(Math.min(size, length - at)));
      }
      c.close();
    },
  });
  return new HttpResponse(body, { status: 206, headers: { "content-type": "application/pdf", "content-range": `bytes ${start}-${end}/${TOTAL}`, "content-length": String(length) } }) as unknown as Response;
}

const show = (firstReadMs: number) => render(<ReaderScreen api={readerApi(testClient())} projectId="p1" sourceId="s1" assetId="a1" readOnly={false} firstReadMs={firstReadMs} />);

beforeEach(() => {
  openPdf.mockReset();
  server.use(http.get(url("/projects/:id/sources/:sid/annotations"), () => HttpResponse.json({ annotations: [], count: 0, textChars: 0 })));
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await sleep(10);
});

describe("ReaderScreen: “Opening the PDF…” when the service does not answer (FR-756)", () => {
  it("a first range whose answer never begins is given up at the limit: it did not answer in time, focus on the heading, “Open again” opens the file", async () => {
    let n = 0;
    const gate = hang();
    server.use(
      http.get(url(DOC), async ({ request }) => {
        if (++n === 1) await gate;
        return slowRange(request, 1, 0);
      }),
    );
    openPdf.mockResolvedValue(handle());
    show(300);
    expect(screen.getByText("Opening the PDF…")).toBeTruthy();
    const h = await screen.findByRole("heading", { level: 2, name: NO_ANSWER_HEADING }, { timeout: 5000 });
    expect(screen.getByText(NO_ANSWER)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(h));
    expect(openPdf).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open again" }));
    await screen.findByRole("button", { name: "Next page" });
    expect(n).toBe(2);
  });

  it("a range whose answer has begun is never cut by the limit, however slowly its bytes arrive", async () => {
    let n = 0;
    server.use(
      http.get(url(DOC), ({ request }) => {
        n++;
        // The headers at once; the body in four pieces over 900 ms — three times the limit.
        return slowRange(request, 4, 300);
      }),
    );
    openPdf.mockResolvedValue(handle());
    show(300);
    await screen.findByRole("button", { name: "Next page" }, { timeout: 5000 });
    expect(n).toBe(1);
    expect(openPdf).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { level: 2, name: NO_ANSWER_HEADING })).toBeNull();
  });

  it("a range pdf.js asks for while the document opens has the same limit: never answered, it is given up and said so", async () => {
    let n = 0;
    const gate = hang();
    server.use(
      http.get(url(DOC), async ({ request }) => {
        if (++n === 2) await gate;
        return slowRange(request, 1, 0);
      }),
    );
    // pdf.js asks for a further part through the transport; a part that failed ends its opening ("other"), as openPdf does.
    openPdf.mockImplementation(
      (o: { transport: PDFDataRangeTransport }) =>
        new Promise<PdfHandle>((_, reject) => {
          onRangeFailure(o.transport, () => reject(new PdfOpenError("other")));
          o.transport.requestDataRange(TOTAL - 100, TOTAL);
        }),
    );
    show(300);
    await screen.findByRole("heading", { level: 2, name: NO_ANSWER_HEADING }, { timeout: 5000 });
    expect(screen.getByText(NO_ANSWER)).toBeTruthy();
  });

  it("a first range that FAILS for want of an answer still says it could not be reached (unchanged)", async () => {
    server.use(http.get(url(DOC), () => HttpResponse.error()));
    show(300);
    await screen.findByRole("heading", { level: 2, name: "Library service not reachable" });
    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
  });
});
