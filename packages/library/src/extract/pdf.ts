/**
 * PDF: Info dictionary + XMP via pdfjs-dist, text of the first 3 pages. Nothing embedded is ever
 * run or fetched: no scripting (pdfjs only runs PDF JavaScript through its separate sandbox
 * bundle, which is never loaded), `isEvalSupported: false` (pdfjs 6 no longer has an eval path;
 * kept as defence in depth), `useWorkerFetch: false` and no cMap / standard-font / wasm URLs (so
 * nothing is fetched), no font-face loading, no XFA.
 */
import * as fsp from "node:fs/promises";
import { basename } from "node:path";
import type { Creator } from "@ao/core";
import { clean, cleanText, normalizeDate, parseName, parseNameList } from "./names.js";
import { embeddedTitle, keepCreators } from "./title-like.js";
import { OCR_THRESHOLD_CHARS, type RawExtract } from "./types.js";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Promise<PdfJs> | undefined;
const loadPdfJs = () => (pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs"));

const TEXT_PAGES = 3;
/** FR-577: the file is read in ranges of this size, as pdf.js asks for them, never whole. */
const RANGE_CHUNK = 64 * 1024;
/** Larger PDFs are not read into memory for metadata. */
const MAX_PDF_BYTES = 512 * 1024 * 1024;

/** Test seam (R47: honoured only under NODE_ENV=test): told the size of each read of the file. */
export const pdfSeams: { onRead?: (bytes: number) => void } = {};

const str = (v: unknown): string | undefined => (typeof v === "string" && clean(v) ? clean(v) : undefined);

export async function extractPdf(path: string): Promise<RawExtract> {
  const stat = await fsp.stat(path);
  if (stat.size > MAX_PDF_BYTES) return {};
  const { getDocument, PDFDataRangeTransport } = await loadPdfJs();
  // FR-577: pdf.js reads the file by ranges, as it needs them (the cross-reference table, the metadata, the first
  // pages), through this transport — never the whole file into memory. A range that cannot be read ends the document
  // (pdf.js has no way to fail a range, so its reads would otherwise wait for ever): the file counts as unreadable.
  const fh = await fsp.open(path, "r");
  const size = stat.size;
  let ended = false;
  let task: ReturnType<typeof getDocument> | undefined;
  /** Rejects when a range could not be read: what waits on pdf.js then stops waiting. */
  let failRead!: (err: unknown) => void;
  const readFailed = new Promise<never>((_, reject) => (failRead = reject));
  readFailed.catch(() => {});
  const readRange = async (begin: number, end: number): Promise<Uint8Array> => {
    const buf = Buffer.alloc(Math.max(0, end - begin));
    let at = 0;
    while (at < buf.length) {
      const { bytesRead } = await fh.read(buf, at, buf.length - at, begin + at);
      if (bytesRead === 0) throw new Error("the file is shorter than it was");
      at += bytesRead;
    }
    if (pdfSeams.onRead && process.env.NODE_ENV === "test") pdfSeams.onRead(buf.length);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  };
  class FileRangeTransport extends PDFDataRangeTransport {
    override requestDataRange(begin: number, end: number): void {
      if (ended) return;
      readRange(begin, Math.min(end, size)).then(
        (chunk) => {
          if (ended) return;
          try {
            this.onDataRange(begin, chunk);
          } catch {
            // pdf.js no longer waits for this range.
          }
        },
        (err: unknown) => {
          ended = true;
          failRead(err);
          void task?.destroy().catch(() => {});
        },
      );
    }
  }
  let first: Uint8Array;
  try {
    first = await readRange(0, Math.min(size, RANGE_CHUNK));
  } catch {
    await fh.close().catch(() => {});
    return { readFailed: true };
  }
  const params = {
    range: new FileRangeTransport(size, first),
    rangeChunkSize: RANGE_CHUNK,
    isEvalSupported: false,
    useWorkerFetch: false,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useWasm: false,
    stopAtErrors: false,
    disableAutoFetch: true,
    disableStream: true,
    verbosity: 0,
  };
  task = getDocument(params as Parameters<typeof getDocument>[0]);
  const loading = task;
  try {
    return await Promise.race([readFailed, read(loading, path)]);
  } catch {
    // Not a readable PDF (damaged, truncated, or encrypted with a password), or a range of it could not be read.
    return { readFailed: true };
  } finally {
    ended = true;
    await loading.destroy().catch(() => {});
    await fh.close().catch(() => {});
  }
}

/** The metadata and the first pages' text of the document `task` opens (`path`: the file's, for its name). */
async function read(task: ReturnType<PdfJs["getDocument"]>, path: string): Promise<RawExtract> {
  {
    const doc = await task.promise;
    const out: RawExtract = {};
    const { info, metadata } = await doc.getMetadata().catch(() => ({ info: {} as Record<string, unknown>, metadata: null }));
    const inf = (info ?? {}) as Record<string, unknown>;

    // R394 a: the XMP title, else the Info Title, whichever first looks like a title.
    const name = basename(path);
    const xmpTitle = str(metadata?.get("dc:title"));
    const infoTitle = str(inf.Title);
    const title = embeddedTitle(xmpTitle, name) ?? embeddedTitle(infoTitle, name);
    if (title) out.title = title;
    const rawTitles = [xmpTitle, infoTitle].filter((t): t is string => !!t);
    if (rawTitles.length) out.rawTitles = rawTitles;

    const xmpCreators = metadata?.get("dc:creator");
    let creators: Creator[] = [];
    // R394 b: stock names ("Administrator", "LaTeX with hyperref") are no authors; the Info Author is read when XMP names none.
    if (Array.isArray(xmpCreators)) creators = keepCreators(xmpCreators.map((c) => (typeof c === "string" ? parseName(c) : undefined)).filter((c): c is Creator => !!c));
    else if (str(xmpCreators)) creators = keepCreators(parseNameList(str(xmpCreators)!));
    if (!creators.length && str(inf.Author)) creators = keepCreators(parseNameList(str(inf.Author)!));
    if (creators.length) out.creators = creators;

    // Publication dates only (R54b): the Info CreationDate/ModDate and xmp:CreateDate are the
    // file's own dates, kept apart as `fileCreated` and never used as `issued`.
    const firstStr = (v: unknown) => str(Array.isArray(v) ? v[0] : v);
    const issued = normalizeDate(
      firstStr(metadata?.get("prism:publicationdate")) ??
        firstStr(metadata?.get("prism:publicationDate")) ??
        firstStr(metadata?.get("prism:coverdate")) ??
        firstStr(metadata?.get("prism:coverDate")) ??
        firstStr(metadata?.get("dc:date")),
    );
    if (issued) out.issued = issued;
    const fileCreated = normalizeDate(firstStr(metadata?.get("xmp:createdate")) ?? str(inf.CreationDate));
    if (fileCreated) out.fileCreated = fileCreated;
    const lang = str(metadata?.get("dc:language")) ?? str(inf.Language);
    if (lang) out.language = lang;

    const doi = str(metadata?.get("prism:doi")) ?? str(metadata?.get("prism:DOI"));
    if (doi) out.ids = { dois: [doi] };

    const pages: string[] = [];
    for (let i = 1; i <= Math.min(TEXT_PAGES, doc.numPages); i++) {
      try {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        pages.push(
          tc.items
            .map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : ""))
            .join("")
            .replace(/[ \t]+/gu, " ")
            .trim(),
        );
        page.cleanup();
      } catch {
        pages.push("");
      }
    }
    const text = cleanText(pages.join("\n\n"));
    if (text) out.text = text;
    out.needsOcr = (pages[0] ?? "").replace(/\s+/gu, "").length < OCR_THRESHOLD_CHARS;
    return out;
  }
}
