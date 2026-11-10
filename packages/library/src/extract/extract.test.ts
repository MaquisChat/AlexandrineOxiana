import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_DOI, FIXTURE_ISBN, buildPdf, buildZip, generateFixtures, type GeneratedFixtures } from "../../../../tests/fixtures/generate.mjs";
import { docxText } from "./docx.js";
import { elements } from "./scan.js";
import { MAX_TEXT_CHARS, UnsafeFileError, extractMetadata, mediaFromTags, shutdownExtractors } from "./index.js";

const DOWNLOADED = join(dirname(fileURLToPath(import.meta.url)), "../../../../tests/fixtures/downloaded");
const DNG = join(DOWNLOADED, "canon-eos-5d-mark-iii-14bit.dng");
const CR3 = join(DOWNLOADED, "canon-eos-r6-craw-crop.cr3");

let tmp: string;
let fx: GeneratedFixtures;
let server: Server;
let serverHits = 0;
let serverUrl: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-extract-"));
  fx = await generateFixtures(join(tmp, "fx"));
  server = createServer((_req, res) => {
    serverHits++;
    res.end("x");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await shutdownExtractors();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(tmp, { recursive: true, force: true });
});

describe("PDF", () => {
  it("never takes issued from the Info CreationDate/ModDate or xmp:CreateDate (R54b)", async () => {
    const p = join(tmp, "dated.pdf");
    await writeFile(p, await buildPdf({ title: "Field Notes on Market Days", lines: ["Field Notes on Market Days"] }));
    const x = await extractMetadata(p, "application/pdf");
    expect(x.issued).toBeUndefined();
    expect(x.fileCreated).toBe("2021-03-04");
  });

  it("finds the DOI on page 1 and reads Info + XMP", async () => {
    const x = await extractMetadata(fx.doiPdf, "application/pdf");
    expect(x.identifiers.dois[0]).toBe(FIXTURE_DOI);
    expect(x.title).toBe("Rivers and Memory in Upland Villages");
    expect(x.creators).toEqual([
      { given: "Amara", family: "Okafor", role: "author" },
      { given: "Henrik", family: "Lindqvist", role: "author" },
    ]);
    expect(x.issued).toBe("2021-03-04");
    expect(x.language).toBe("en");
    expect(x.needsOcr).toBe(false);
    expect(x.text).toContain("Oral histories"); // page 2 is within the first 3 pages
  });

  it("flags an image-only (scanned) PDF as needing OCR", async () => {
    const x = await extractMetadata(fx.scannedPdf, "application/pdf");
    expect(x.needsOcr).toBe(true);
    expect(x.identifiers).toEqual({ dois: [], isbns: [], arxiv: [] });
  });

  it("never runs JavaScript embedded in a PDF", async () => {
    const x = await extractMetadata(fx.scriptPdf, "application/pdf");
    expect(x.title).toBe("Scripted Document");
    expect((globalThis as Record<string, unknown>).__aoPdfJsRan).toBeUndefined();
  });

  it("an unreadable PDF yields empty metadata, not a crash", async () => {
    const bad = join(tmp, "bad.pdf");
    await writeFile(bad, "%PDF-1.7\nnot really a pdf");
    const x = await extractMetadata(bad, "application/pdf");
    expect(x.identifiers).toEqual({ dois: [], isbns: [], arxiv: [] });
  });
});

describe("EPUB", () => {
  it("reads title, creators, date, language and ISBN from the OPF", async () => {
    const x = await extractMetadata(fx.epub, "application/epub+zip");
    expect(x.title).toBe("The Weaver's Almanac");
    expect(x.creators).toEqual([
      { given: "Ngozi", family: "Adebayo", role: "author" },
      { given: "Tomás", family: "Herrera", role: "author" },
    ]);
    expect(x.issued).toBe("2009-05-01");
    expect(x.language).toBe("en");
    expect(x.identifiers.isbns).toEqual([FIXTURE_ISBN]);
    expect(x.text).toContain("Looms and seasons");
    expect(x.text).not.toContain("__aoEpubJsRan");
    expect((globalThis as Record<string, unknown>).__aoEpubJsRan).toBeUndefined();
  });

  it("rejects path traversal entry names", async () => {
    await expect(extractMetadata(fx.traversalEpub, "application/epub+zip")).rejects.toMatchObject({ name: "UnsafeFileError", code: "zip-path" });
  });

  it("rejects an entry declared larger than 50 MB", async () => {
    await expect(extractMetadata(fx.oversizeEpub, "application/epub+zip")).rejects.toMatchObject({ code: "zip-entry-too-large" });
  });

  it("rejects archives with more than 10,000 entries", async () => {
    const err = await extractMetadata(fx.manyEntriesEpub, "application/epub+zip").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsafeFileError);
    expect((err as UnsafeFileError).code).toBe("zip-too-many-entries");
  });
});

describe("DOCX", () => {
  it("reads docProps/core.xml and finds identifiers in the body text", async () => {
    const x = await extractMetadata(fx.docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(x.title).toBe("Field Report on Market Days");
    expect(x.creators).toEqual([{ given: "Priya", family: "Raman", role: "author" }]);
    // dcterms:created is the file's date, never the publication date (R54b).
    expect(x.issued).toBeUndefined();
    expect(x.fileCreated).toBe("2020-11-02");
    expect(x.language).toBe("en-GB");
    expect(x.identifiers.dois).toEqual(["10.5555/ao.docx.7"]);
    expect(x.text).toContain("See also doi:10.5555/ao.docx.7 for the earlier survey.");
  });
});

describe("HTML", () => {
  it("prefers Highwire citation_* tags", async () => {
    const x = await extractMetadata(fx.html, "text/html");
    expect(x.title).toBe("Les marchés du dimanche & leurs publics");
    expect(x.creators).toEqual([
      { family: "Dubois", given: "Camille", role: "author" },
      { family: "Martin", given: "Louis", role: "author" },
    ]);
    expect(x.issued).toBe("2018-06-15");
    expect(x.language).toBe("fr");
    expect(x.identifiers.dois).toEqual(["10.5555/ao.html.42"]);
    expect(x.text).toContain("Un article sur les marchés.");
    expect(x.text).not.toContain("__aoHtmlJsRan");
  });

  it("falls back to Dublin Core, OpenGraph and <title>", async () => {
    const dc = join(tmp, "dc.html");
    await writeFile(dc, `<html><head><title>T</title><meta content="Dublin Title" name="DC.title"><meta name="DC.creator" content="Ana Lima"><meta name="DC.date" content="2001"><meta property="og:title" content="OG"></head></html>`);
    expect(await extractMetadata(dc, "text/html")).toMatchObject({ title: "Dublin Title", creators: [{ given: "Ana", family: "Lima", role: "author" }], issued: "2001" });
    const og = join(tmp, "og.html");
    await writeFile(og, `<html><head><title>Plain &lt;Title&gt;</title><meta property="og:title" content="Open Graph Title"></head></html>`);
    expect((await extractMetadata(og, "text/html")).title).toBe("Open Graph Title");
    const plain = join(tmp, "plain.html");
    await writeFile(plain, `<html><head><title>Plain &lt;Title&gt;</title></head><body>x</body></html>`);
    expect((await extractMetadata(plain, "text/html")).title).toBe("Plain <Title>");
  });

  it("never fetches anything the page references", async () => {
    const page = join(tmp, "refs.html");
    await writeFile(
      page,
      `<html><head><title>Refs</title><script src="${serverUrl}/a.js"></script><link rel="stylesheet" href="${serverUrl}/a.css"><meta http-equiv="refresh" content="0;url=${serverUrl}/r"></head><body><img src="${serverUrl}/a.png"><iframe src="${serverUrl}/f"></iframe></body></html>`,
    );
    await extractMetadata(page, "text/html");
    await new Promise((r) => setTimeout(r, 50));
    expect(serverHits).toBe(0);
  });

  it("caps extracted text at 20,000 characters", async () => {
    const long = join(tmp, "long.html");
    await writeFile(long, `<html><body><p>${"word ".repeat(10_000)}</p></body></html>`);
    const x = await extractMetadata(long, "text/html");
    expect(MAX_TEXT_CHARS).toBe(20_000);
    expect(x.text!.length).toBe(20_000);
  });
});

describe("MOBI", () => {
  it("reads EXTH title, author, ISBN and date", async () => {
    const x = await extractMetadata(fx.mobi, "application/x-mobipocket-ebook");
    expect(x.title).toBe("The Salt Roads");
    expect(x.creators).toEqual([{ family: "Okonkwo", given: "Ada", role: "author" }]);
    expect(x.identifiers.isbns).toEqual([FIXTURE_ISBN]);
    expect(x.issued).toBe("2015-09-01");
  });

  it("survives a corrupt EXTH block and a truncated file", async () => {
    const corrupt = await extractMetadata(fx.corruptMobi, "application/x-mobipocket-ebook");
    expect(corrupt.title).toBe("The Salt Roads");
    const truncated = await extractMetadata(fx.truncatedMobi, "application/x-mobipocket-ebook");
    expect(truncated.identifiers).toEqual({ dois: [], isbns: [], arxiv: [] });
    expect(truncated.title).toBe("salt_roads"); // only the PalmDB name survives
  });
});

describe("camera media (exiftool)", () => {
  it("reads capture time, time zone, device, lens and raw GPS", async () => {
    const x = await extractMetadata(fx.cameraTiff, "image/tiff");
    expect(x.media).toMatchObject({
      capturedAt: "2024-07-14T18:30:05-04:00",
      tzOffset: "-04:00",
      device: "Apple iPhone 15 Pro",
      lens: "iPhone 15 Pro back triple camera 6.86mm f/1.78",
      gps: { lat: 40.6892, lon: -74.0445 },
      capturedAtSource: "original",
      width: 4,
      height: 4,
    });
  });

  it.skipIf(!existsSync(DNG))("DNG (downloaded fixture): capture time and device", async () => {
    const x = await extractMetadata(DNG, "image/x-adobe-dng");
    expect(x.media?.device).toBe("Canon EOS 5D Mark III");
    expect(x.media?.capturedAt).toBe("2017-12-12T09:45:40");
    expect(x.media?.capturedAtSource).toBe("modified"); // only IFD0 DateTime: flagged, not a capture time
    expect(x.media?.tzOffset).toBeUndefined();
  });

  it.skipIf(!existsSync(CR3))("CR3 (downloaded fixture): capture time with offset, device and lens", async () => {
    const x = await extractMetadata(CR3, "image/x-canon-cr3");
    expect(x.media).toMatchObject({
      capturedAt: "2021-05-12T12:21:21.920+02:00",
      tzOffset: "+02:00",
      device: "Canon EOS R6",
      lens: "RF70-200mm F2.8 L IS USM",
      width: 3408,
      height: 2272,
    });
  });

  it("maps QuickTime tags: content identifier, duration, creation date with zone", () => {
    const m = mediaFromTags({
      Make: "Apple",
      Model: "iPhone 13",
      CreationDate: "2023-01-02T03:04:05+09:00",
      ContentIdentifier: "6F1D2A3B-0000-4C5D-8E9F-123456789ABC",
      Duration: 3.4,
      ImageWidth: 1920,
      ImageHeight: 1080,
    });
    expect(m).toEqual({
      capturedAt: "2023-01-02T03:04:05+09:00",
      capturedAtSource: "created",
      tzOffset: "+09:00",
      device: "Apple iPhone 13",
      model: "iPhone 13",
      contentIdentifier: "6F1D2A3B-0000-4C5D-8E9F-123456789ABC",
      durationSec: 3.4,
      width: 1920,
      height: 1080,
    });
  });
});

describe("capturedAtSource", () => {
  it("marks a ModifyDate fallback as 'modified'", () => {
    expect(mediaFromTags({ ModifyDate: "2019:01:02 03:04:05" })).toEqual({ capturedAt: "2019-01-02T03:04:05", capturedAtSource: "modified" });
    expect(mediaFromTags({ DateTimeOriginal: "2019:01:02 03:04:05" }).capturedAtSource).toBe("original");
    expect(mediaFromTags({ CreateDate: "2019:01:02 03:04:05" }).capturedAtSource).toBe("created");
  });
});

describe("linear-time parsing of hostile markup", () => {
  const fast = async (fn: () => Promise<unknown>) => {
    const t0 = performance.now();
    await fn();
    return performance.now() - t0;
  };

  it("HTML of 200,000 unclosed <title> tags", async () => {
    const f = join(tmp, "titles.html");
    await writeFile(f, "<title>".repeat(200_000));
    expect(await fast(() => extractMetadata(f, "text/html"))).toBeLessThan(1000);
  });

  it("HTML of unclosed <script> and <meta> tags", async () => {
    const f = join(tmp, "scripts.html");
    await writeFile(f, "<body>" + "<script><meta ".repeat(100_000));
    expect(await fast(() => extractMetadata(f, "text/html"))).toBeLessThan(1000);
  });

  it("an OPF of ~2 MB of unclosed <dc:title>", async () => {
    const f = join(tmp, "unclosed.epub");
    const opf = '<package><metadata xmlns:dc="x">' + "<dc:title>".repeat(200_000) + "</metadata></package>";
    await writeFile(
      f,
      buildZip([
        { name: "mimetype", data: "application/epub+zip", store: true },
        { name: "META-INF/container.xml", data: '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>' },
        { name: "c.opf", data: opf },
      ]),
    );
    expect(await fast(() => extractMetadata(f, "application/epub+zip"))).toBeLessThan(1000);
  });

  it("a DOCX with an unclosed <w:p> and <w:t>", async () => {
    const f = join(tmp, "unclosed.docx");
    await writeFile(f, buildZip([{ name: "word/document.xml", data: "<w:document><w:body>" + "<w:p><w:t>x".repeat(200_000) }]));
    expect(await fast(() => extractMetadata(f, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))).toBeLessThan(1000);
  });

  it("DOCX text extraction stops at 20,000 characters", async () => {
    const f = join(tmp, "long.docx");
    const para = `<w:p><w:r><w:t>${"y".repeat(1000)}</w:t></w:r></w:p>`;
    await writeFile(f, buildZip([{ name: "word/document.xml", data: "<w:document><w:body>" + para.repeat(5000) + "</w:body></w:document>" }]));
    const x = await extractMetadata(f, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(x.text!.length).toBeLessThanOrEqual(20_000);
    expect(x.text!.length).toBeGreaterThan(19_000);
  });
});

describe("review round 2", () => {
  const ms = async (fn: () => Promise<unknown>) => {
    const t0 = performance.now();
    await fn();
    return performance.now() - t0;
  };

  it("a repeated meta key stays linear (23,000 repeats) and values are capped", async () => {
    const f = join(tmp, "metas.html");
    await writeFile(f, "<meta name=a content=b>".repeat(23_000));
    expect(await ms(() => extractMetadata(f, "text/html"))).toBeLessThan(1000);
    const g = join(tmp, "authors.html");
    await writeFile(g, '<meta name="citation_author" content="Ana Lima">'.repeat(2_000));
    expect((await extractMetadata(g, "text/html")).creators).toHaveLength(500);
  });

  it("text survives a page with no </head> and no <body>", async () => {
    const f = join(tmp, "nohead.html");
    await writeFile(f, "<html><head><title>T</title><p>Paragraph text here</p>");
    const x = await extractMetadata(f, "text/html");
    expect(x.title).toBe("T");
    expect(x.text).toContain("Paragraph text here");
  });

  it("a stray '<' with no '>' is text, and the scan carries on (linearly)", async () => {
    const f = join(tmp, "stray.html");
    await writeFile(f, "<p>Hello</p>if a<b then c and more text");
    expect((await extractMetadata(f, "text/html")).text).toBe("Hello\nif a<b then c and more text");
    const g = join(tmp, "strays.html");
    await writeFile(g, "<body>" + "a<b ".repeat(200_000));
    expect(await ms(() => extractMetadata(g, "text/html"))).toBeLessThan(1000);
  });

  it("an unclosed element does not hide a later complete one", () => {
    expect([...elements("<dc:title>Broken<dc:title>Real</dc:title>", "title")].map((e) => e.inner)).toContain("Real");
  });

  it("DOCX text never ends in half a surrogate pair", () => {
    const t = docxText(`<w:p><w:t>${"y".repeat(19_999)}\u{1F600}${"z".repeat(10)}</w:t></w:p>`);
    expect(t.length).toBeLessThanOrEqual(20_000);
    expect(/[\uD800-\uDBFF]$/u.test(t)).toBe(false);
  });
});

describe("robustness", () => {
  it("an EPUB manifest href with a malformed %-escape is skipped, not a URIError", async () => {
    const f = join(tmp, "badhref.epub");
    const opf = '<package><metadata xmlns:dc="x"><dc:title>Bad Href</dc:title></metadata><manifest><item id="a" href="a%zz.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>';
    await writeFile(
      f,
      buildZip([
        { name: "META-INF/container.xml", data: '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>' },
        { name: "c.opf", data: opf },
        { name: "a%zz.xhtml", data: "<html><body>x</body></html>" },
      ]),
    );
    const x = await extractMetadata(f, "application/epub+zip");
    expect(x.title).toBe("Bad Href");
  });

  it("extracted text keeps single line breaks (at most one blank line)", async () => {
    const f = join(tmp, "lines.html");
    await writeFile(f, "<html><body><p>one  \t two</p><p>three</p><br><br><br><br><p>four</p></body></html>");
    const x = await extractMetadata(f, "text/html");
    expect(x.text).toBe("one two\nthree\n\nfour");
  });
});

describe("dispatch", () => {
  it("an unsupported type yields empty identifiers", async () => {
    const f = join(tmp, "notes.bin");
    await writeFile(f, "binary");
    expect(await extractMetadata(f, "application/octet-stream")).toEqual({ identifiers: { dois: [], isbns: [], arxiv: [] } });
  });
});
