/**
 * PDF: Info dictionary + XMP via pdfjs-dist, text of the first 3 pages. Nothing embedded is ever
 * run or fetched: no scripting (pdfjs only runs PDF JavaScript through its separate sandbox
 * bundle, which is never loaded), `isEvalSupported: false` (pdfjs 6 no longer has an eval path;
 * kept as defence in depth), `useWorkerFetch: false` and no cMap / standard-font / wasm URLs (so
 * nothing is fetched), no font-face loading, no XFA.
 */
import * as fsp from "node:fs/promises";
import type { Creator } from "@ao/core";
import { clean, cleanText, normalizeDate, parseName, parseNameList } from "./names.js";
import { OCR_THRESHOLD_CHARS, type RawExtract } from "./types.js";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Promise<PdfJs> | undefined;
const loadPdfJs = () => (pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs"));

const TEXT_PAGES = 3;
/** Larger PDFs are not read into memory for metadata. */
const MAX_PDF_BYTES = 512 * 1024 * 1024;
const JUNK_TITLE = /^(?:untitled|microsoft word - .*|.*\.(?:docx?|pdf|tex|indd|rtf|odt))$/iu;

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

    const xmpTitle = str(metadata?.get("dc:title"));
    const infoTitle = str(inf.Title);
    const title = [xmpTitle, infoTitle].find((t) => t && !JUNK_TITLE.test(t));
    if (title) out.title = title;

    const xmpCreators = metadata?.get("dc:creator");
    let creators: Creator[] = [];
    if (Array.isArray(xmpCreators)) creators = xmpCreators.map((c) => (typeof c === "string" ? parseName(c) : undefined)).filter((c): c is Creator => !!c);
    else if (str(xmpCreators)) creators = parseNameList(str(xmpCreators)!);
    if (!creators.length && str(inf.Author)) creators = parseNameList(str(inf.Author)!);
    if (creators.length) out.creators = creators;

    const issued = normalizeDate(str(metadata?.get("dc:date")) ?? str(metadata?.get("xmp:createdate")) ?? str(inf.CreationDate));
    if (issued) out.issued = issued;
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
    return {};
  } finally {
    await task.destroy().catch(() => {});
  }
}
