#!/usr/bin/env node
// Builds the metadata-extraction test fixtures deterministically (same bytes on every run, no
// network): PDFs with pdf-lib, EPUB/DOCX with a small built-in ZIP writer, an HTML page, a MOBI
// with EXTH records, an uncompressed TIFF with camera EXIF (written by exiftool), and a few
// deliberately hostile archives/books for the extractor safety tests. Nothing here is committed:
// tests call `generateFixtures(dir)` into a temp folder, and `node tests/fixtures/generate.mjs [dir]`
// writes them to tests/fixtures/generated/ (gitignored) for manual inspection.
//
// Real camera files (DNG, CR3) cannot be generated; scripts/fetch-fixtures.mjs downloads them.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// pdf-lib and exiftool-vendored are dependencies of @ao/library, so resolve them from there.
const requireLib = createRequire(join(root, "packages", "library", "package.json"));

const FIXED_DATE = new Date("2021-03-04T05:06:07Z");
export const FIXTURE_DOI = "10.5555/ao.fixture.2021.001";
export const FIXTURE_ISBN = "9780262033848";

// ---------------------------------------------------------------------------------------------
// ZIP writer (stored or deflated entries, fixed timestamps). `declaredSize` lets a test lie about
// an entry's uncompressed size to exercise the extractor's limits without building a huge file.

/**
 * `unixMode` (e.g. 0o120777 for a symbolic link) marks the entry as made on Unix with that mode.
 * @param {{name: string, data: Buffer|string, store?: boolean, declaredSize?: number, unixMode?: number}[]} entries
 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // 2021-03-04 05:06:06 in DOS time/date.
  const dosTime = (5 << 11) | (6 << 5) | 3;
  const dosDate = ((2021 - 1980) << 9) | (3 << 5) | 4;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const method = e.store ? 0 : 8;
    const body = method === 0 ? data : deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const size = e.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.unixMode !== undefined ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    if (e.unixMode !== undefined) central.writeUInt32LE((e.unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------------------------------------------------------------------------------------------
// Tiny images

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A 64×64 grayscale PNG with a diagonal pattern ("scanned page" stand-in). */
export function tinyPng() {
  const w = 64;
  const h = 64;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = (x + y) % 16 < 8 ? 30 : 230;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A 4×4 8-bit grayscale uncompressed baseline TIFF (exiftool then writes camera EXIF into it). */
export function tinyTiff() {
  const w = 4;
  const h = 4;
  const pixels = Buffer.alloc(w * h, 128);
  const tags = [
    [256, 3, 1, w], // ImageWidth
    [257, 3, 1, h], // ImageLength
    [258, 3, 1, 8], // BitsPerSample
    [259, 3, 1, 1], // Compression: none
    [262, 3, 1, 1], // Photometric: BlackIsZero
    [273, 4, 1, 0], // StripOffsets (patched below)
    [277, 3, 1, 1], // SamplesPerPixel
    [278, 3, 1, h], // RowsPerStrip
    [279, 4, 1, pixels.length], // StripByteCounts
  ];
  const ifdOffset = 8;
  const ifdSize = 2 + tags.length * 12 + 4;
  const dataOffset = ifdOffset + ifdSize;
  const buf = Buffer.alloc(dataOffset + pixels.length);
  buf.write("II", 0, "latin1");
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifdOffset, 4);
  buf.writeUInt16LE(tags.length, ifdOffset);
  tags.forEach(([tag, type, count, value], i) => {
    const p = ifdOffset + 2 + i * 12;
    buf.writeUInt16LE(tag, p);
    buf.writeUInt16LE(type, p + 2);
    buf.writeUInt32LE(count, p + 4);
    const v = tag === 273 ? dataOffset : value;
    if (type === 3) buf.writeUInt16LE(v, p + 8);
    else buf.writeUInt32LE(v, p + 8);
  });
  buf.writeUInt32LE(0, ifdOffset + 2 + tags.length * 12);
  pixels.copy(buf, dataOffset);
  return buf;
}

// ---------------------------------------------------------------------------------------------
// PDFs

const XMP = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Rivers and Memory in Upland Villages</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>Amara Okafor</rdf:li><rdf:li>Lindqvist, Henrik</rdf:li></rdf:Seq></dc:creator>
   <dc:language><rdf:Bag><rdf:li>en</rdf:li></rdf:Bag></dc:language>
   <prism:doi>${FIXTURE_DOI}</prism:doi>
   <prism:publicationDate>2021-03-04</prism:publicationDate>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

async function pdfWithDoi() {
  const { PDFDocument, PDFName, StandardFonts } = requireLib("pdf-lib");
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle("Rivers and Memory in Upland Villages");
  doc.setAuthor("Amara Okafor; Henrik Lindqvist");
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer("ao-fixtures");
  doc.setCreator("ao-fixtures");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    "Journal of Upland Studies 12 (2021) 1-20",
    "Rivers and Memory in Upland Villages",
    "Amara Okafor and Henrik Lindqvist",
    `https://doi.org/${FIXTURE_DOI}`,
    "Abstract. We study how villagers remember the course of rivers over three generations.",
  ];
  const page = doc.addPage([595, 842]);
  lines.forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 22, size: 11, font }));
  const p2 = doc.addPage([595, 842]);
  p2.drawText("1. Introduction. Oral histories were gathered in 2019 and 2020.", { x: 50, y: 780, size: 11, font });
  const meta = doc.context.stream(Buffer.from(XMP, "utf8"), { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(meta));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/**
 * A simple text PDF for import tests: optional Info title/author, the given lines on page 1.
 * Deterministic (fixed dates). `extra` adds bytes to a comment so otherwise identical PDFs differ.
 * @param {{ title?: string, author?: string, lines?: string[], extra?: string }} [opts]
 */
export async function buildPdf(opts = {}) {
  const { PDFDocument, StandardFonts } = requireLib("pdf-lib");
  const doc = await PDFDocument.create({ updateMetadata: false });
  if (opts.title) doc.setTitle(opts.title);
  if (opts.author) doc.setAuthor(opts.author);
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer("ao-fixtures");
  if (opts.extra) doc.setSubject(opts.extra);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  (opts.lines ?? []).forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 22, size: 11, font }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** The DOI article PDF (`doiPdf` of generateFixtures) as bytes. */
export function buildDoiPdf() {
  return pdfWithDoi();
}

async function scannedPdf() {
  const { PDFDocument } = requireLib("pdf-lib");
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer("ao-fixtures");
  const img = await doc.embedPng(tinyPng());
  const page = doc.addPage([595, 842]);
  page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** A PDF whose OpenAction runs JavaScript; extraction must never execute it. */
async function pdfWithJavaScript() {
  const { PDFDocument, PDFName, PDFString, StandardFonts } = requireLib("pdf-lib");
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle("Scripted Document");
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer("ao-fixtures");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("This page has enough ordinary text to not need OCR at all, really.", { x: 50, y: 780, size: 11, font });
  const js = doc.context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("globalThis.__aoPdfJsRan = true; app.alert('x');") });
  doc.catalog.set(PDFName.of("OpenAction"), doc.context.register(js));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// ---------------------------------------------------------------------------------------------
// PDFs for the reader (Task R6 onwards): deterministic, invented text, standard fonts only (not
// embedded: pdf.js draws them from its bundled standard fonts).

/** A new document with the fixtures' fixed dates and producer. */
async function readerDoc(title) {
  const { PDFDocument } = requireLib("pdf-lib");
  const doc = await PDFDocument.create({ updateMetadata: false });
  if (title) doc.setTitle(title);
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer("ao-fixtures");
  return doc;
}

const COLUMN_ONE = [
  "Market days in the upland villages begin before dawn,",
  "when traders carry baskets down the river path and",
  "set out their goods beneath the old plane trees.",
  "The elders remember when the river ran further east,",
  "and they measure the years by the floods that came.",
  "At the foot of this column the sentence continues",
];
const COLUMN_TWO = [
  "into the head of the second column, where the story",
  "of the bridge is told by those who built it in 1962.",
  "Children learn the names of the fields from songs,",
  "and the songs change a little with every harvest.",
  "Nobody writes the songs down; they are sung instead.",
  "This is the last line of the second column.",
];

/**
 * A two-column article on A4 (columns at x 50-280 and 315-545, a 35-point gutter), two pages, so
 * that a selection can run from the foot of column one to the head of column two, and from page 1
 * into page 2.
 */
export async function buildTwoColumnPdf() {
  const { StandardFonts } = requireLib("pdf-lib");
  const doc = await readerDoc("Rivers and Markets: a two-column article");
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let n = 1; n <= 2; n++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Rivers and Markets, page ${n}`, { x: 50, y: 790, size: 14, font });
    COLUMN_ONE.forEach((l, i) => page.drawText(l, { x: 50, y: 740 - i * 16, size: 9, font }));
    COLUMN_TWO.forEach((l, i) => page.drawText(l, { x: 315, y: 740 - i * 16, size: 9, font }));
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/**
 * A scanned book: `pages` pages that are each one picture and no text at all (one shared image
 * object, so even 900 pages stay small).
 * @param {number} pages
 */
export async function buildScanPdf(pages) {
  const doc = await readerDoc("A scanned book");
  const img = await doc.embedPng(tinyPng());
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawImage(img, { x: 40, y: 40, width: 515, height: 762 });
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

/**
 * One page turned by the file itself (/Rotate 90) whose crop box is offset from the media box
 * (MediaBox 0 0 700 900, CropBox 50 60 645 880), with text inside the crop box: highlights must land
 * on their words whatever the rotation and the crop.
 */
export async function buildRotatedCropPdf() {
  const { StandardFonts, degrees } = requireLib("pdf-lib");
  const doc = await readerDoc("A rotated page with a crop box");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([700, 900]);
  page.setCropBox(50, 60, 595, 820);
  page.setRotation(degrees(90));
  ["The ferry timetable was rewritten every spring.", "Passengers argued about it on the quay.", "The ledger of crossings survives in the archive."].forEach((l, i) =>
    page.drawText(l, { x: 100, y: 800 - i * 20, size: 12, font }),
  );
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/**
 * `pages` pages, each saying which it is ("Page n of N" and a sentence). Its page labels are
 * printed like a book's: the first two pages "i" and "ii", the rest "1", "2" … from page 3.
 * @param {number} pages
 */
export async function buildMultiPagePdf(pages) {
  const { PDFName, StandardFonts } = requireLib("pdf-lib");
  const doc = await readerDoc(`A document of ${pages} pages`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Page ${n} of ${pages}`, { x: 50, y: 790, size: 14, font });
    page.drawText(`This is the text of page ${n}, written for the reader's tests.`, { x: 50, y: 760, size: 11, font });
  }
  const nums = pages > 2 ? [0, { S: "r" }, 2, { S: "D", St: 1 }] : [0, { S: "r" }];
  doc.catalog.set(PDFName.of("PageLabels"), doc.context.obj({ Nums: nums }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/**
 * A PDF read in many ranges (Task R6): `pages` pages, each with ~600 KB of filler and then the words
 * "Quote on page N" in its content, and all that content written AFTER the page objects, so that
 * opening it reads little and each page's text needs ranges of its own. Page `latePage` (1-based,
 * not the last) also has its page object written halfway through the content, so that even getting
 * that page needs a range. Deterministic; uncompressed.
 * @param {number} pages
 * @param {number} latePage
 */
export async function buildRangeReadPdf(pages, latePage) {
  const { PDFName, StandardFonts } = requireLib("pdf-lib");
  if (!(latePage >= 1 && latePage < pages)) throw new Error("latePage must be a page before the last");
  const doc = await readerDoc("A document read in ranges");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const line = `% ${"filler ".repeat(13)}\n`;
  const content = (n) => doc.context.register(doc.context.stream(`${line.repeat(6000)}BT /FQ 14 Tf 50 700 Td (Quote on page ${n}) Tj ET\n`));
  const withFont = (page) => {
    page.node.setFontDictionary(PDFName.of("FQ"), font.ref);
    return page;
  };
  const made = [];
  for (let n = 1; n <= pages; n++) if (n !== latePage) made[n - 1] = withFont(doc.addPage([595, 842]));
  const half = Math.floor(pages / 2);
  for (let n = 1; n <= half; n++) if (n !== latePage) made[n - 1].node.addContentStream(content(n));
  made[latePage - 1] = withFont(doc.insertPage(latePage - 1, [595, 842]));
  made[latePage - 1].node.addContentStream(content(latePage));
  for (let n = half + 1; n <= pages; n++) if (n !== latePage) made[n - 1].node.addContentStream(content(n));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/**
 * A file that starts like a PDF and is not one: the header, then nothing a PDF reader can recover
 * (no objects, no cross-reference table, no trailer). pdf.js answers InvalidPDFException.
 */
export function buildDamagedPdf() {
  return Buffer.concat([Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1"), Buffer.from("This file was damaged in transit; nothing of the document is left.\n".repeat(40), "latin1")]);
}

/**
 * Japanese text in a font the file does not embed, with a predefined character map
 * (UniJIS-UCS2-H, Adobe-Japan1): pdf.js reads it only with its bundled character maps. The page
 * says "日本語のテキスト" (Japanese text) and, in Helvetica, "Japanese text".
 */
export async function buildCjkPdf() {
  const { PDFName, PDFString, StandardFonts } = requireLib("pdf-lib");
  const doc = await readerDoc("Japanese text");
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const descriptor = ctx.register(
    ctx.obj({ Type: "FontDescriptor", FontName: "KozMinPr6N-Regular", Flags: 6, FontBBox: [-195, -272, 1110, 1075], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 740, StemV: 80 }),
  );
  const cidFont = ctx.register(
    ctx.obj({ Type: "Font", Subtype: "CIDFontType0", BaseFont: "KozMinPr6N-Regular", CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Japan1"), Supplement: 6 }, FontDescriptor: descriptor, DW: 1000 }),
  );
  const type0 = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "KozMinPr6N-Regular-UniJIS-UCS2-H", Encoding: "UniJIS-UCS2-H", DescendantFonts: [cidFont] }));
  const page = doc.addPage([595, 842]);
  page.drawText("Japanese text", { x: 50, y: 790, size: 12, font: helvetica });
  const fonts = page.node.Resources().lookup(PDFName.of("Font"));
  fonts.set(PDFName.of("FJ"), type0);
  const text = "日本語のテキスト";
  const hex = [...text].map((c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join("");
  const content = ctx.register(ctx.flateStream(`BT /FJ 24 Tf 50 720 Td <${hex}> Tj ET`));
  page.node.addContentStream(content);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// ---------------------------------------------------------------------------------------------
// EPUB / DOCX

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Weaver&apos;s Almanac</dc:title>
    <dc:creator id="c1">Ngozi Adebayo</dc:creator>
    <dc:creator id="c2">Tomás Herrera</dc:creator>
    <dc:date>2009-05-01</dc:date>
    <dc:identifier id="bookid">urn:isbn:${FIXTURE_ISBN}</dc:identifier>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2021-03-04T05:06:07Z</meta>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`;

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title>
<script>globalThis.__aoEpubJsRan = true;</script></head>
<body><h1>Chapter One</h1><p>Looms and seasons: a record of the weaving year.</p></body></html>`;

function epub(extra = []) {
  return buildZip([
    { name: "mimetype", data: "application/epub+zip", store: true },
    { name: "META-INF/container.xml", data: CONTAINER },
    { name: "OEBPS/content.opf", data: OPF },
    { name: "OEBPS/ch1.xhtml", data: CH1 },
    ...extra,
  ]);
}

const CORE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Field Report on Market Days</dc:title>
  <dc:creator>Priya Raman</dc:creator>
  <dc:language>en-GB</dc:language>
  <dcterms:created xsi:type="dcterms:W3CDTF">2020-11-02T09:00:00Z</dcterms:created>
</cp:coreProperties>`;

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Field Report on Market Days</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">See also doi:10.5555/ao.docx.7 for the </w:t></w:r><w:r><w:t>earlier survey.</w:t></w:r></w:p>
</w:body></w:document>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

function docx() {
  return buildZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "docProps/core.xml", data: CORE_XML },
    { name: "word/document.xml", data: DOCUMENT_XML },
  ]);
}

// ---------------------------------------------------------------------------------------------
// HTML

const HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Ignored page title | Example Journal</title>
<meta name="citation_title" content="Les marchés du dimanche &amp; leurs publics">
<meta name="citation_author" content="Dubois, Camille">
<meta name="citation_author" content="Martin, Louis">
<meta name="citation_publication_date" content="2018/06/15">
<meta name="citation_doi" content="10.5555/ao.html.42">
<meta name="citation_journal_title" content="Revue des Terrains">
<meta property="og:title" content="OG title should lose">
<meta name="DC.title" content="DC title should lose">
<script src="http://127.0.0.1:9/should-not-load.js"></script>
<link rel="stylesheet" href="http://127.0.0.1:9/should-not-load.css">
<script>globalThis.__aoHtmlJsRan = true;</script>
</head>
<body><img src="http://127.0.0.1:9/should-not-load.png"><p>Un article sur les marchés.</p></body>
</html>`;

// ---------------------------------------------------------------------------------------------
// MOBI (PalmDB + record 0 with PalmDOC, MOBI and EXTH headers)

function exthRecord(type, value) {
  const data = Buffer.from(value, "utf8");
  const b = Buffer.alloc(8 + data.length);
  b.writeUInt32BE(type, 0);
  b.writeUInt32BE(8 + data.length, 4);
  data.copy(b, 8);
  return b;
}

/** @param {{exth?: [number, string][], fullName?: string, corruptExth?: boolean}} [opts] */
export function buildMobi(opts = {}) {
  const exthRecs = (opts.exth ?? [
    [503, "The Salt Roads"],
    [100, "Okonkwo, Ada"],
    [104, "978-0-262-03384-8"],
    [106, "2015-09-01"],
  ]).map(([t, v]) => exthRecord(t, v));
  let exthBody = Buffer.concat(exthRecs);
  const exthHead = Buffer.alloc(12);
  exthHead.write("EXTH", 0, "latin1");
  exthHead.writeUInt32BE(12 + exthBody.length, 4);
  exthHead.writeUInt32BE(opts.corruptExth ? 0x7fffffff : exthRecs.length, 8);
  if (opts.corruptExth) {
    // A record claiming a huge length, then garbage.
    const bad = Buffer.alloc(16);
    bad.writeUInt32BE(503, 0);
    bad.writeUInt32BE(0xfffffff0, 4);
    exthBody = Buffer.concat([exthBody, bad]);
  }
  const exth = Buffer.concat([exthHead, exthBody, Buffer.alloc((4 - ((12 + exthBody.length) % 4)) % 4)]);

  const mobiHeaderLen = 232;
  const fullName = Buffer.from(opts.fullName ?? "Salt Roads (full name)", "utf8");
  const rec0 = Buffer.alloc(16 + mobiHeaderLen + exth.length + fullName.length + 2);
  // PalmDOC header: compression 1 (none), text length, record count, record size.
  rec0.writeUInt16BE(1, 0);
  rec0.writeUInt32BE(0, 4);
  rec0.writeUInt16BE(0, 8);
  rec0.writeUInt16BE(4096, 10);
  const m = 16;
  rec0.write("MOBI", m, "latin1");
  rec0.writeUInt32BE(mobiHeaderLen, m + 4);
  rec0.writeUInt32BE(2, m + 8); // mobi type: book
  rec0.writeUInt32BE(65001, m + 12); // text encoding: UTF-8
  const fullNameOffset = 16 + mobiHeaderLen + exth.length;
  rec0.writeUInt32BE(fullNameOffset, 0x54);
  rec0.writeUInt32BE(fullName.length, 0x58);
  rec0.writeUInt32BE(0x40, 0x80); // EXTH present
  exth.copy(rec0, 16 + mobiHeaderLen);
  fullName.copy(rec0, fullNameOffset);

  const numRecords = 1;
  const header = Buffer.alloc(78 + numRecords * 8 + 2);
  header.write("salt_roads", 0, "latin1");
  header.write("BOOK", 60, "latin1");
  header.write("MOBI", 64, "latin1");
  header.writeUInt16BE(numRecords, 76);
  header.writeUInt32BE(header.length, 78); // record 0 offset
  return Buffer.concat([header, rec0]);
}

// ---------------------------------------------------------------------------------------------

/** Writes the camera TIFF fixture (iPhone EXIF incl. GPS) to `path`. */
export function buildCameraTiff(path) {
  return cameraTiff(path);
}

async function cameraTiff(path) {
  const { ExifTool } = requireLib("exiftool-vendored");
  writeFileSync(path, tinyTiff());
  const et = new ExifTool({ maxProcs: 1 });
  try {
    await et.write(
      path,
      {
        Make: "Apple",
        Model: "iPhone 15 Pro",
        LensModel: "iPhone 15 Pro back triple camera 6.86mm f/1.78",
        DateTimeOriginal: "2024:07:14 18:30:05",
        CreateDate: "2024:07:14 18:30:05",
        OffsetTimeOriginal: "-04:00",
        GPSLatitude: 40.6892,
        GPSLatitudeRef: "N",
        GPSLongitude: -74.0445,
        GPSLongitudeRef: "W",
      },
      { writeArgs: ["-overwrite_original"] },
    );
  } finally {
    await et.end();
  }
}

/**
 * Writes every fixture into `outDir` and returns their paths.
 * @param {string} outDir
 */
export async function generateFixtures(outDir) {
  mkdirSync(outDir, { recursive: true });
  const p = (n) => join(outDir, n);
  const files = {
    doiPdf: p("doi-article.pdf"),
    scannedPdf: p("scanned.pdf"),
    scriptPdf: p("scripted.pdf"),
    epub: p("weavers-almanac.epub"),
    traversalEpub: p("traversal.epub"),
    oversizeEpub: p("oversize.epub"),
    manyEntriesEpub: p("many-entries.epub"),
    docx: p("market-days.docx"),
    html: p("article.html"),
    mobi: p("salt-roads.mobi"),
    corruptMobi: p("corrupt.mobi"),
    truncatedMobi: p("truncated.mobi"),
    cameraTiff: p("camera.tif"),
  };
  writeFileSync(files.doiPdf, await pdfWithDoi());
  writeFileSync(files.scannedPdf, await scannedPdf());
  writeFileSync(files.scriptPdf, await pdfWithJavaScript());
  writeFileSync(files.epub, epub());
  writeFileSync(files.traversalEpub, epub([{ name: "../../escape.txt", data: "x" }]));
  writeFileSync(files.oversizeEpub, epub([{ name: "OEBPS/huge.bin", data: "tiny", declaredSize: 60 * 1024 * 1024 }]));
  writeFileSync(
    files.manyEntriesEpub,
    epub(Array.from({ length: 10_001 }, (_, i) => ({ name: `OEBPS/f${i}.txt`, data: "", store: true }))),
  );
  writeFileSync(files.docx, docx());
  writeFileSync(files.html, HTML);
  const mobi = buildMobi();
  writeFileSync(files.mobi, mobi);
  writeFileSync(files.corruptMobi, buildMobi({ corruptExth: true }));
  writeFileSync(files.truncatedMobi, mobi.subarray(0, 120));
  await cameraTiff(files.cameraTiff);
  return files;
}

/**
 * The Bulk Import fixture folder: 20 generated PDFs in nested folders (5 at the top, including the
 * DOI article; Fieldwork/2021 and Fieldwork/2022 with 4 each; Theory with 4; Theory/Classics with
 * 3), one ZIP archive holding 2 more PDFs (one in a folder), one corrupt PDF and one exact
 * duplicate of a top-level PDF (in Theory). 24 importable items.
 * @param {string} dir
 */
export async function buildImportFolder(dir) {
  const write = (rel, data) => {
    const p = join(dir, ...rel.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    return p;
  };
  const names = [
    ["", ["Okafor - 2019 - Feeding the Feed", "Lindqvist - 2020 - Harbour Voices", "Mensah - 2018 - Weather Talk", "Novak - 2017 - Kitchen Archives"]],
    ["Fieldwork/2021", ["Ito - 2021 - Market Days", "Haddad - 2021 - Bus Routes", "Silva - 2021 - Night Shifts", "Kowalski - 2021 - Allotments"]],
    ["Fieldwork/2022", ["Ndiaye - 2022 - River Crossings", "Petrov - 2022 - Village Radio", "Garcia - 2022 - Street Saints", "Olsen - 2022 - Ferry Timetables"]],
    ["Theory", ["Weber - 1922 - Economy and Society Notes", "Arendt - 1958 - On Labour", "Bourdieu - 1979 - Taste Maps", "Ostrom - 1990 - Commons Revisited"]],
    ["Theory/Classics", ["Durkheim - 1897 - Suicide Rates", "Simmel - 1903 - Metropolis", "Mauss - 1925 - The Gift Economy"]],
  ];
  const files = { doiPdf: write("doi-article.pdf", await pdfWithDoi()) };
  const all = [files.doiPdf];
  for (const [folder, list] of names) {
    for (const n of list) {
      const [creator, , title] = n.split(" - ");
      const bytes = await buildPdf({ title, author: creator, lines: [title, `by ${creator}`, "Generated for the bulk import tests."] });
      all.push(write(`${folder ? `${folder}/` : ""}${n}.pdf`, bytes));
    }
  }
  const zipped = [
    { name: "Zipped Notes - 2015 - Inside the Archive.pdf", data: await buildPdf({ title: "Inside the Archive", author: "Zipped", lines: ["Inside the Archive"] }) },
    { name: "Sub/Packed - 2016 - Second Entry.pdf", data: await buildPdf({ title: "Second Entry", author: "Packed", lines: ["Second Entry"] }) },
  ];
  files.zip = write("Bundle.zip", buildZip(zipped));
  files.corruptPdf = write("Damaged - 2020 - Broken Scan.pdf", Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> broken\n%%EOF garbage", "latin1"));
  files.duplicate = write("Theory/copy of Feeding the Feed.pdf", readFileSync(all[1]));
  files.generated = all;
  return { ...files, items: 24 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? join(root, "tests", "fixtures", "generated"));
  const files = await generateFixtures(out);
  for (const f of Object.values(files)) console.log(f);
}
