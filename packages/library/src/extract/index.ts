/**
 * Embedded-metadata extraction (spec 5.1 drag-and-drop attach, 5.4 step 3.2–3.3): one entry point,
 * `extractMetadata(path, mime)`, dispatching on the MIME type (the file extension is the fallback
 * for generic types). Identifiers come from metadata fields and from the first pages / sections of
 * text (`findIdentifiers`); text is capped at 20,000 characters.
 *
 * Safety (R50): nothing embedded is executed or fetched (see pdf.ts, html.ts); EPUB/DOCX archives
 * are bounded (zip.ts) and refused with UnsafeFileError. Other unreadable files give empty
 * metadata rather than an error.
 */
import { findIdentifiers, toIsbn13, type FoundIdentifiers } from "@ao/core";
import { extname } from "node:path";
import { extractDocx } from "./docx.js";
import { extractEpub } from "./epub.js";
import { extractExif, shutdownExif } from "./exif.js";
import { extractHtml } from "./html.js";
import { extractMobi } from "./mobi.js";
import { extractPdf } from "./pdf.js";
import { MAX_TEXT_CHARS, type Extracted, type RawExtract } from "./types.js";

export { UnsafeFileError, type UnsafeFileCode } from "./errors.js";
export { mediaFromTags } from "./exif.js";
export { MAX_TEXT_CHARS, OCR_THRESHOLD_CHARS, type Extracted, type MediaMetadata } from "./types.js";
export { ZIP_LIMITS } from "./zip.js";

type Kind = "pdf" | "epub" | "mobi" | "docx" | "html" | "media";

const BY_MIME: Record<string, Kind> = {
  "application/pdf": "pdf",
  "application/epub+zip": "epub",
  "application/x-mobipocket-ebook": "mobi",
  "application/vnd.amazon.ebook": "mobi",
  "application/vnd.amazon.mobi8-ebook": "mobi",
  "application/x-mobi8-ebook": "mobi",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/html": "html",
  "application/xhtml+xml": "html",
};
const BY_EXT: Record<string, Kind> = {
  ".pdf": "pdf",
  ".epub": "epub",
  ".mobi": "mobi",
  ".azw": "mobi",
  ".azw3": "mobi",
  ".docx": "docx",
  ".html": "html",
  ".htm": "html",
  ".xhtml": "html",
};

function kindOf(path: string, mime: string): Kind | undefined {
  const m = mime.toLowerCase().split(";")[0]!.trim();
  if (BY_MIME[m]) return BY_MIME[m];
  if (/^(?:image|video|audio)\//u.test(m)) return "media";
  if (m === "" || m === "application/octet-stream" || m === "application/zip") return BY_EXT[extname(path).toLowerCase()];
  return undefined;
}

const EXTRACTORS: Record<Kind, (path: string) => Promise<RawExtract>> = {
  pdf: extractPdf,
  epub: extractEpub,
  mobi: extractMobi,
  docx: extractDocx,
  html: extractHtml,
  media: extractExif,
};

function mergeIdentifiers(raw: RawExtract, text: string | undefined): FoundIdentifiers {
  const found = text ? findIdentifiers(text) : { dois: [], isbns: [], arxiv: [] };
  const dois = (raw.ids?.dois ?? []).map((d) => d.trim().toLowerCase()).filter((d) => /^10\.\d{4,9}\/\S+$/u.test(d));
  const isbns = (raw.ids?.isbns ?? []).map((i) => toIsbn13(i)).filter((i): i is string => !!i && !i.startsWith("9790"));
  const arxiv = raw.ids?.arxiv ?? [];
  return {
    dois: [...new Set([...dois, ...found.dois])],
    isbns: [...new Set([...isbns, ...found.isbns])],
    arxiv: [...new Set([...arxiv, ...found.arxiv])],
  };
}

/** At most MAX_TEXT_CHARS UTF-16 units, never ending in half a surrogate pair. */
function capText(t: string): string {
  const s = t.slice(0, MAX_TEXT_CHARS);
  return /[\uD800-\uDBFF]$/u.test(s) && t.length > MAX_TEXT_CHARS ? s.slice(0, -1) : s;
}

export async function extractMetadata(path: string, mime: string): Promise<Extracted> {
  const kind = kindOf(path, mime);
  if (!kind) return { identifiers: { dois: [], isbns: [], arxiv: [] } };
  // Video: embedded and timed metadata too (-ee), e.g. a GPS track recorded with the frames (R85).
  const raw = kind === "media" && /^video\//iu.test(mime) ? await extractExif(path, { embedded: true }) : await EXTRACTORS[kind](path);
  const text = raw.text ? capText(raw.text) : undefined;
  // The embedded title as found is for the file check alone (R410 b): the import reads the filtered `title`.
  const { ids: _ids, text: _text, rawTitle: _rawTitle, ...rest } = raw;
  return { ...rest, identifiers: mergeIdentifiers(raw, text), ...(text ? { text } : {}) };
}

/** Ends helper processes (exiftool). Call on shutdown. */
export async function shutdownExtractors(): Promise<void> {
  await shutdownExif();
}
