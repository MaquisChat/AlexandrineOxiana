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
/** Larger PDFs are not read into memory for metadata. */
const MAX_PDF_BYTES = 512 * 1024 * 1024;

const str = (v: unknown): string | undefined => (typeof v === "string" && clean(v) ? clean(v) : undefined);

export async function extractPdf(path: string): Promise<RawExtract> {
  const stat = await fsp.stat(path);
  if (stat.size > MAX_PDF_BYTES) return {};
  const data = new Uint8Array(await fsp.readFile(path));
  const { getDocument } = await loadPdfJs();
  const params = {
    data,
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
  const task = getDocument(params as Parameters<typeof getDocument>[0]);
  try {
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
  } catch {
    // Not a readable PDF (damaged, truncated, or encrypted with a password).
    return { readFailed: true };
  } finally {
    await task.destroy().catch(() => {});
  }
}
