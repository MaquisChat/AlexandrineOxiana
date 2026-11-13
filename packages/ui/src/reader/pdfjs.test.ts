// @vitest-environment node
/**
 * The one place pdf.js is loaded and configured (Task R6): the options the plan lists, exactly; the
 * legacy build and its worker; nothing of pdf.js's link, form, XFA or scripting layers anywhere in
 * the interface; opening a document through the range transport with real pdf.js (its worker on the
 * main thread here, as Node has no web workers); and every way an opening fails, each as its kind.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildDamagedPdf, buildMultiPagePdf } from "../../../../tests/fixtures/generate.mjs";
import { ApiClientError } from "../api/client";
import { openPdf, PDF_OPTIONS, PdfOpenError, pdfDocumentParams, toPdfOpenError } from "./pdfjs";
import { createRangeTransport, type FetchRange } from "./rangeTransport";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");
const REPO = join(SRC, "..", "..", "..");

beforeAll(async () => {
  // Node has no web workers: pdf.js runs its worker code on the main thread when it finds it here.
  // @ts-expect-error: the worker module ships no type declarations.
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
});

/** A transport over `data` held in memory: the first `firstBytes` given, the rest through `fetchRange`. */
function memoryTransport(data: Uint8Array, opts: { firstBytes?: number; fail?: unknown } = {}) {
  const first = data.subarray(0, Math.min(opts.firstBytes ?? 1048576, data.length));
  const calls: Array<[number, number]> = [];
  const fetchRange: FetchRange = async (start, end) => {
    calls.push([start, end]);
    if (opts.fail !== undefined) throw opts.fail;
    return data.slice(start, end + 1);
  };
  return { transport: createRangeTransport({ bytes: first.slice(), total: data.length }, fetchRange), calls };
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

describe("pdf.js options", () => {
  it("every option is set as the plan lists", () => {
    expect(PDF_OPTIONS).toEqual({
      isEvalSupported: false,
      enableXfa: false,
      useWasm: false,
      useWorkerFetch: false,
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: 1048576,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
      iccUrl: "/pdfjs/iccs/",
    });
    expect(Object.isFrozen(PDF_OPTIONS)).toBe(true);
    // What getDocument is given: those options, the transport, the password only when there is one,
    // and nothing that would let pdf.js reach for the file itself (no url, no data, no headers).
    const { transport } = memoryTransport(new Uint8Array(100));
    const params = pdfDocumentParams(transport);
    expect(params).toEqual({ ...PDF_OPTIONS, range: transport });
    expect(pdfDocumentParams(transport, "secret")).toEqual({ ...PDF_OPTIONS, range: transport, password: "secret" });
    for (const p of [params, pdfDocumentParams(transport, "secret")]) {
      for (const k of ["url", "data", "httpHeaders", "withCredentials", "worker", "docBaseUrl"]) expect(p, k).not.toHaveProperty(k);
    }
  });

  it("loads the legacy build and its minified worker through Vite, and nothing else of pdf.js", () => {
    const source = readFileSync(join(here, "pdfjs.ts"), "utf8");
    expect(source).toMatch(/from "pdfjs-dist\/legacy\/build\/pdf\.mjs"/);
    expect(source).toMatch(/from "pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url"/);
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
      for (const [s, e] of calls) expect(e).toBeLessThan(data.length);
      const page = await handle.doc.getPage(3);
      const text = (await page.getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ");
      expect(text).toContain("Page 3 of 12");
    } finally {
      await handle.destroy();
    }
    // destroy() ends the document and its worker side (the worker's copy of the bytes with it).
    await expect((async () => handle.doc.getPage(1))()).rejects.toBeTruthy();
  });

  it("a password-protected PDF asks for its password, says when it is wrong, and opens with it", async () => {
    const data = new Uint8Array(readFileSync(join(REPO, "tests", "fixtures", "pdf", "password-protected.pdf")));
    expect(await kindOf(openPdf({ transport: memoryTransport(data).transport, signal: signal() }))).toBe("password-needed");
    expect(await kindOf(openPdf({ transport: memoryTransport(data).transport, password: "not-it", signal: signal() }))).toBe("password-wrong");
    const handle = await openPdf({ transport: memoryTransport(data).transport, password: "ao-fixture", signal: signal() });
    expect(handle.pageCount).toBe(1);
    await handle.destroy();
  });

  it("a damaged PDF is damaged", async () => {
    const data = new Uint8Array(buildDamagedPdf());
    expect(await kindOf(openPdf({ transport: memoryTransport(data).transport, signal: signal() }))).toBe("damaged");
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
    expect(toPdfOpenError(new Error("anything")).kind).toBe("other");
    const same = new PdfOpenError("damaged");
    expect(toPdfOpenError(same)).toBe(same);
    // The message is plain words, never the service's or pdf.js's own.
    expect(toPdfOpenError(new ApiClientError(413, { code: "PAYLOAD_TOO_LARGE", message: "x" })).message).toBe("This PDF is larger than 512 MB, too large to open in the app.");
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
  });
});
