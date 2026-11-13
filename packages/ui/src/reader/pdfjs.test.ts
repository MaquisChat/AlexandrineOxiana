// @vitest-environment node
/**
 * The one place pdf.js is loaded and configured (Task R6, A6): the options, exactly, and that
 * getDocument is given them; the legacy build; nothing of pdf.js's link, form, XFA or scripting
 * layers anywhere in the interface; the worker created by the app itself from the bundled file and
 * never a fake one; opening a document through the range transport with real pdf.js; every way an
 * opening fails, each as its kind; and the failure channel of an open document.
 *
 * Node has no web workers: a stand-in `Worker` (LoopbackWorker) runs pdf.js's own worker code in this
 * process behind a message channel with the browser's semantics (structured clone, transfer,
 * asynchronous delivery). pdf.js's "fake worker" hook is removed, so a fall-back fails here.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import bundledWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { READER_PDF_MAX_BYTES } from "@ao/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDamagedPdf, buildMultiPagePdf } from "../../../../tests/fixtures/generate.mjs";
import { ApiClientError } from "../api/client";
import { openPdf, PDF_OPTIONS, PdfOpenError, pdfDocumentParams, toPdfOpenError } from "./pdfjs";
import { createRangeTransport, type FetchRange } from "./rangeTransport";

// openPdf hands getDocument its parameters: watched here, pdf.js otherwise unchanged.
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async (importOriginal) => {
  const real = await importOriginal<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>();
  return { ...real, getDocument: vi.fn(real.getDocument) };
});

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");
const REPO = join(SRC, "..", "..", "..");

/** pdf.js's worker code, run in this process behind the stand-in Worker. */
let WorkerMessageHandler: { initializeFromPort(port: unknown): void };
beforeAll(async () => {
  // @ts-expect-error: the worker module ships no type declarations.
  ({ WorkerMessageHandler } = await import("pdfjs-dist/legacy/build/pdf.worker.mjs"));
  // Importing it leaves pdf.js's "fake worker" hook on globalThis; removed, so that a fall-back to
  // parsing on the page's own thread fails loudly instead of passing unseen.
  delete (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker;
});

/** One end of a message channel with the browser's semantics. */
class Endpoint extends EventTarget {
  other: Endpoint | undefined;
  closed = false;
  postMessage(data: unknown, transfer?: Transferable[] | { transfer?: Transferable[] }): void {
    const list = Array.isArray(transfer) ? transfer : (transfer?.transfer ?? []);
    const copy = structuredClone(data, { transfer: list });
    const to = this.other;
    setTimeout(() => {
      if (!to || to.closed || this.closed) return;
      to.dispatchEvent(new MessageEvent("message", { data: copy }));
    }, 0);
  }
}

/** A stand-in for `Worker`: records how it was created and runs pdf.js's worker code on the other end. */
class LoopbackWorker extends Endpoint {
  static made: Array<{ url: string; options: unknown; worker: LoopbackWorker }> = [];
  static mode: "ok" | "error" = "ok";
  terminated = false;
  constructor(url: string | URL, options?: unknown) {
    super();
    LoopbackWorker.made.push({ url: String(url), options, worker: this });
    if (LoopbackWorker.mode === "error") {
      // As a browser does when the worker's script cannot be loaded or is refused by the policy.
      setTimeout(() => this.dispatchEvent(new Event("error")), 0);
      return;
    }
    const inside = new Endpoint();
    inside.other = this;
    this.other = inside;
    WorkerMessageHandler.initializeFromPort(inside);
  }
  terminate(): void {
    this.terminated = true;
    this.closed = true;
    if (this.other) this.other.closed = true;
  }
}

beforeEach(() => {
  LoopbackWorker.made = [];
  LoopbackWorker.mode = "ok";
  vi.stubGlobal("Worker", LoopbackWorker);
  vi.mocked(getDocument).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A transport over `data` held in memory: the first `firstBytes` given, the rest through `fetchRange`. */
function memoryTransport(data: Uint8Array, opts: { firstBytes?: number; fail?: unknown; failFrom?: number } = {}) {
  const first = data.subarray(0, Math.min(opts.firstBytes ?? 1048576, data.length));
  const calls: Array<[number, number]> = [];
  // `failFrom` may be moved later (state.failFrom), e.g. once the document is open.
  const state = { failFrom: opts.failFrom ?? 1 };
  const fetchRange: FetchRange = async (start, end) => {
    calls.push([start, end]);
    if (opts.fail !== undefined && calls.length >= state.failFrom) throw opts.fail;
    return data.slice(start, end + 1);
  };
  return { transport: createRangeTransport({ bytes: first.slice(), total: data.length }, fetchRange), calls, state };
}

const signal = () => new AbortController().signal;
const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "opened";
  } catch (e) {
    return e instanceof PdfOpenError ? e.kind : `not a PdfOpenError: ${String(e)}`;
  }
};
const within = async (p: Promise<unknown>, ms: number) =>
  Promise.race([
    p.then(
      () => "settled",
      () => "settled",
    ),
    new Promise((r) => setTimeout(() => r("pending"), ms)),
  ]);

/** `pages` pages whose content streams each carry ~600 KB of filler, so that reading a page needs ranges of its own. */
async function bigPdf(pages: number): Promise<Uint8Array> {
  type Lib = {
    PDFDocument: { create(o: object): Promise<{ embedFont(f: string): Promise<unknown>; addPage(s: [number, number]): { drawText(t: string, o: object): void; node: { addContentStream(r: unknown): void } }; context: { register(o: unknown): unknown; stream(s: string): unknown }; save(o: object): Promise<Uint8Array> }> };
    StandardFonts: { Helvetica: string };
  };
  const { PDFDocument, StandardFonts } = createRequire(join(REPO, "packages", "library", "package.json"))("pdf-lib") as Lib;
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // Every page first (their objects together at the start of the file, which pdf.js reads to open
  // it), then each page's filler (written after them, read only when that page is read).
  const made = Array.from({ length: pages }, (_, i) => {
    const page = doc.addPage([595, 842]);
    page.drawText(`Page ${i + 1}`, { x: 50, y: 780, size: 12, font });
    return page;
  });
  for (const page of made) page.node.addContentStream(doc.context.register(doc.context.stream(`% ${randomBytes(300_000).toString("hex")}\n`)));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

describe("pdf.js options", () => {
  it("every option is set as the plan lists", async () => {
    expect(PDF_OPTIONS).toEqual({
      isEvalSupported: false,
      enableXfa: false,
      useWasm: false,
      useWorkerFetch: false,
      useSystemFonts: true,
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: 1048576,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
      maxImageSize: 67108864,
      canvasMaxAreaInBytes: 134217728,
    });
    expect(Object.isFrozen(PDF_OPTIONS)).toBe(true);
    // pdf.js reads canvasMaxAreaInBytes with `>> 2`: it must stay below 2^31.
    expect(PDF_OPTIONS.canvasMaxAreaInBytes).toBeLessThan(2 ** 31);
    // What getDocument is given: those options, the transport, the password only when there is one,
    // and nothing that would let pdf.js reach for the file itself (no url, no data, no headers).
    const { transport } = memoryTransport(new Uint8Array(100));
    const params = pdfDocumentParams(transport);
    expect(params).toEqual({ ...PDF_OPTIONS, range: transport });
    expect(pdfDocumentParams(transport, "secret")).toEqual({ ...PDF_OPTIONS, range: transport, password: "secret" });
    for (const p of [params, pdfDocumentParams(transport, "secret")]) {
      for (const k of ["url", "data", "httpHeaders", "withCredentials", "worker", "docBaseUrl", "iccUrl"]) expect(p, k).not.toHaveProperty(k);
    }
    // And openPdf gives getDocument exactly that, plus the worker it made itself.
    const data = new Uint8Array(await buildMultiPagePdf(1));
    const t = memoryTransport(data).transport;
    const handle = await openPdf({ transport: t, signal: signal() });
    expect(getDocument).toHaveBeenCalledTimes(1);
    const given = vi.mocked(getDocument).mock.calls[0]![0] as Record<string, unknown>;
    const { worker, ...rest } = given;
    expect(rest).toEqual(pdfDocumentParams(t));
    expect(worker).toBeDefined();
    await handle.destroy();
  });

  it("loads the legacy build and its minified worker through Vite, and nothing else of pdf.js", () => {
    const source = readFileSync(join(here, "pdfjs.ts"), "utf8");
    expect(source).toMatch(/from "pdfjs-dist\/legacy\/build\/pdf\.mjs"/);
    expect(source).toMatch(/from "pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url"/);
    // The worker is never left to pdf.js to make (it would wrap it in a blob: address, A6).
    expect(source).not.toMatch(/GlobalWorkerOptions/);
    // Across the interface's own code: pdf.js only from the legacy build; never the viewer, the
    // sandbox (scripting), the annotation, form, editor or XFA layers.
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n) && !/\.test\.(ts|tsx)$/.test(n)) files.push(p);
      }
    };
    walk(SRC);
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/from\s+"(pdfjs-dist[^"]*)"|import\(\s*"(pdfjs-dist[^"]*)"\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? "";
        if (spec !== "pdfjs-dist/legacy/build/pdf.mjs" && spec !== "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url") offenders.push(`${relative(SRC, f)}: ${spec}`);
      }
      if (/\b(AnnotationLayer|AnnotationEditorLayer|AnnotationEditorUIManager|XfaLayer|pdf\.sandbox|PDFScriptingManager)\b/.test(text)) offenders.push(`${relative(SRC, f)}: a pdf.js layer`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("the worker", () => {
  it("is created by the app from the bundled worker file, as a module, never as a blob: address, even where the page's origin reads as null", async () => {
    // The shell's page: tauri://localhost, whose origin reads as "null".
    vi.stubGlobal("location", new URL("tauri://localhost/index.html"));
    vi.stubGlobal("window", { location: new URL("tauri://localhost/index.html") });
    const blobs = vi.spyOn(URL, "createObjectURL");
    const data = new Uint8Array(await buildMultiPagePdf(2));
    const handle = await openPdf({ transport: memoryTransport(data).transport, signal: signal() });
    expect(handle.pageCount).toBe(2);
    expect(LoopbackWorker.made.map((m) => ({ url: m.url, options: m.options }))).toEqual([{ url: bundledWorkerUrl, options: { type: "module" } }]);
    expect(blobs).not.toHaveBeenCalled();
    // Destroying the document ends the worker too (pdf.js does not end a worker it was handed).
    await handle.destroy();
    expect(LoopbackWorker.made[0]!.worker.terminated).toBe(true);
    blobs.mockRestore();
  });

  it("a worker that cannot start is an error in plain words, never parsing on the page's own thread", async () => {
    LoopbackWorker.mode = "error";
    const data = new Uint8Array(await buildMultiPagePdf(1));
    const err = await openPdf({ transport: memoryTransport(data).transport, signal: signal() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfOpenError);
    expect((err as PdfOpenError).kind).toBe("other");
    expect((err as PdfOpenError).message).toBe("The PDF reader could not start. Close the reader and open the file again.");
    expect(LoopbackWorker.made[0]!.worker.terminated).toBe(true);
    expect(getDocument).not.toHaveBeenCalled();
    // No Worker at all (an environment without web workers): the same error, no fall-back.
    vi.stubGlobal("Worker", undefined);
    expect(await kindOf(openPdf({ transport: memoryTransport(data).transport, signal: signal() }))).toBe("other");
  });
});

describe("openPdf", () => {
  it("opens a document through the range transport, with its page count and printed page labels", async () => {
    const data = new Uint8Array(await buildMultiPagePdf(12));
    // Only the first 2 KB given: the rest (the cross-reference table at the end) through ranges.
    const { transport, calls } = memoryTransport(data, { firstBytes: 2048 });
    const handle = await openPdf({ transport, signal: signal() });
    try {
      expect(handle.pageCount).toBe(12);
      expect(handle.doc.numPages).toBe(12);
      expect(handle.pageLabels).toEqual(["i", "ii", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
      expect(calls.length).toBeGreaterThan(0);
      for (const [, e] of calls) expect(e).toBeLessThan(data.length);
      const page = await handle.doc.getPage(3);
      const text = (await page.getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ");
      expect(text).toContain("Page 3 of 12");
    } finally {
      await handle.destroy();
    }
    // destroy() ends the document and its worker (the worker's copy of the bytes with it).
    await expect((async () => handle.doc.getPage(1))()).rejects.toBeTruthy();
  });

  it("a password-protected PDF asks for its password, says when it is wrong, and opens with it", async () => {
    const data = new Uint8Array(readFileSync(join(REPO, "tests", "fixtures", "pdf", "password-protected.pdf")));
    expect(await kindOf(openPdf({ transport: memoryTransport(data).transport, signal: signal() }))).toBe("password-needed");
    expect(await kindOf(openPdf({ transport: memoryTransport(data).transport, password: "not-it", signal: signal() }))).toBe("password-wrong");
    const handle = await openPdf({ transport: memoryTransport(data).transport, password: "ao-fixture", signal: signal() });
    expect(handle.pageCount).toBe(1);
    await handle.destroy();
    // Every worker made along the way was ended.
    expect(LoopbackWorker.made.every((m) => m.worker.terminated)).toBe(true);
  });

  it("a damaged PDF is damaged", async () => {
    const data = new Uint8Array(buildDamagedPdf());
    expect(await kindOf(openPdf({ transport: memoryTransport(data).transport, signal: signal() }))).toBe("damaged");
  });

  it("a file over 512 MB is too large before pdf.js is given it", async () => {
    const t = createRangeTransport({ bytes: new Uint8Array(1024), total: READER_PDF_MAX_BYTES + 1 }, async () => new Uint8Array(1));
    expect(await kindOf(openPdf({ transport: t, signal: signal() }))).toBe("too-large");
    expect(getDocument).not.toHaveBeenCalled();
    expect(LoopbackWorker.made).toEqual([]);
  });

  it("a locked project while opening is locked, and the service's other refusals map to their kinds", async () => {
    const data = new Uint8Array(await buildMultiPagePdf(3));
    const locked = new ApiClientError(423, { code: "PROJECT_LOCKED", message: "This project is locked." });
    const { transport, calls } = memoryTransport(data, { firstBytes: 1024, fail: locked });
    expect(await kindOf(openPdf({ transport, signal: signal() }))).toBe("locked");
    expect(calls).toHaveLength(1); // the transport stopped at the first refusal
    const err = (status: number, code: string) => toPdfOpenError(new ApiClientError(status, { code, message: "x" })).kind;
    expect(err(413, "PAYLOAD_TOO_LARGE")).toBe("too-large");
    expect(err(404, "NOT_FOUND")).toBe("missing");
    expect(err(423, "PROJECT_LOCKED")).toBe("locked");
    expect(err(502, "INTERNAL")).toBe("other");
    expect(err(0, "UNAVAILABLE")).toBe("other");
    // The service's other answers in their own plain words (review M7): an asset that is not a PDF,
    // and a range past the end (the file shrank since it was opened).
    expect(toPdfOpenError(new ApiClientError(400, { code: "VALIDATION", message: "This file cannot be shown here." }))).toMatchObject({ kind: "other", message: "This file cannot be shown here." });
    expect(toPdfOpenError(new ApiClientError(416, { code: "VALIDATION", message: "x" }))).toMatchObject({ kind: "other", message: "The file changed while it was being read. Open it again to read it as it is now." });
    expect(toPdfOpenError(new Error("anything")).kind).toBe("other");
    const same = new PdfOpenError("damaged");
    expect(toPdfOpenError(same)).toBe(same);
    // The message is plain words, never the service's or pdf.js's own.
    expect(toPdfOpenError(new ApiClientError(413, { code: "PAYLOAD_TOO_LARGE", message: "x" })).message).toBe("This PDF is larger than 512 MB, too large to open in the app.");
    // A file that changed while it was read (review M1) is said as such, not as "damaged".
    const changed = Object.assign(new Error("changed"), { name: "FileChangedError" });
    expect(toPdfOpenError(changed)).toMatchObject({ kind: "other", message: "The file changed while it was being read. Open it again to read it as it is now." });
  });

  it("an aborted signal ends the opening: AbortError, and the document is destroyed", async () => {
    const data = new Uint8Array(await buildMultiPagePdf(3));
    const already = new AbortController();
    already.abort();
    await expect(openPdf({ transport: memoryTransport(data).transport, signal: already.signal })).rejects.toMatchObject({ name: "AbortError" });

    const ac = new AbortController();
    let release: (() => void) | undefined;
    const fetchRange = vi.fn<FetchRange>(
      (start, end) =>
        new Promise<Uint8Array>((resolve) => {
          release = () => resolve(data.slice(start, end + 1));
        }),
    );
    const transport = createRangeTransport({ bytes: data.slice(0, 1024), total: data.length }, fetchRange);
    const opening = openPdf({ transport, signal: ac.signal });
    await vi.waitFor(() => expect(fetchRange).toHaveBeenCalled());
    ac.abort();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    release?.();
    await vi.waitFor(() => expect(LoopbackWorker.made.every((m) => m.worker.terminated)).toBe(true));
  });
});

describe("PdfHandle.failed", () => {
  /**
   * Opens `data`, then reads its pages one after another (each needs ranges of its own); the `nth`
   * range asked for after opening, and every later one, fails with `fail`. `reading` settles when the
   * reading has stopped, one way or the other.
   */
  async function readPages(data: Uint8Array, fail: unknown, nth: number) {
    const t = memoryTransport(data, { firstBytes: 1048576, fail, failFrom: Number.POSITIVE_INFINITY });
    const handle = await openPdf({ transport: t.transport, signal: signal() });
    const callsAtOpen = t.calls.length;
    t.state.failFrom = callsAtOpen + nth;
    const reading = (async () => {
      for (let i = 1; i <= handle.pageCount; i++) await (await handle.doc.getPage(i)).getOperatorList().catch(() => {});
    })();
    return { handle, t, callsAtOpen, reading };
  }

  it("a range refused after opening (423 on a later range): failed says locked, no range is asked for after it, nothing waits for ever", async () => {
    const data = await bigPdf(16);
    const locked = new ApiClientError(423, { code: "PROJECT_LOCKED", message: "This project is locked." });
    const { handle, t, callsAtOpen, reading } = await readPages(data, locked, 3);
    const failure = await handle.failed;
    expect(failure).toBeInstanceOf(PdfOpenError);
    expect(failure.kind).toBe("locked");
    // The third range asked for after opening was the one refused, and nothing was asked for after it.
    expect(t.calls.length).toBe(callsAtOpen + 3);
    // The page read that was waiting for it, and every later one, finishes: nothing waits for ever.
    expect(await within(reading, 10000)).toBe("settled");
    expect(t.calls.length).toBe(callsAtOpen + 3);
    // The reader then destroys the document, which ends the worker.
    await handle.destroy();
    expect(LoopbackWorker.made[0]!.worker.terminated).toBe(true);
  });

  it("a network failure after opening: failed says other, and everything settles", async () => {
    const data = await bigPdf(16);
    const down = new ApiClientError(0, { code: "UNAVAILABLE", message: "The library service could not be reached." });
    const { handle, t, callsAtOpen, reading } = await readPages(data, down, 2);
    expect((await handle.failed).kind).toBe("other");
    expect(await within(reading, 10000)).toBe("settled");
    expect(t.calls.length).toBe(callsAtOpen + 2);
    await handle.destroy();
  });

  it("an abort is not a failure", async () => {
    const data = await bigPdf(16);
    const aborted = new DOMException("The range was no longer wanted.", "AbortError");
    const { handle, t, callsAtOpen } = await readPages(data, aborted, 2);
    await vi.waitFor(() => expect(t.calls.length).toBe(callsAtOpen + 2));
    expect(await within(handle.failed, 500)).toBe("pending");
    await handle.destroy();
    expect(await within(handle.failed, 100)).toBe("pending");
  });
});
