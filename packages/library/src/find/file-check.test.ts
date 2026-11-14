/**
 * Task F11 (R277 a): the file check — a downloaded file against the record it was found for. Strict: a wrong
 * file attached to a record is worse than no file. Every file here is made by the tests' own builders (no network).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPdf, buildScanPdf, buildZip } from "../../../../tests/fixtures/generate.mjs";
import { FILE_CHECK_EVIDENCE_CHARS, FILE_CHECK_TEXT_CHARS, checkFileAgainstRecord, type FileCheckRecord } from "./file-check.js";

let tmp: string;
let n = 0;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-file-check-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const pdf = async (o: { title?: string; author?: string; lines?: string[] }) => {
  const p = join(tmp, `f${++n}.pdf`);
  await writeFile(p, await buildPdf(o));
  return p;
};

/** A small EPUB: OPF metadata and one chapter of text. */
const epub = async (o: { title?: string; creator?: string; doi?: string; body: string }) => {
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${o.title ? `<dc:title>${o.title}</dc:title>` : ""}${o.creator ? `<dc:creator>${o.creator}</dc:creator>` : ""}${o.doi ? `<dc:identifier opf:scheme="DOI">${o.doi}</dc:identifier>` : ""}</metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
  const container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const p = join(tmp, `e${++n}.epub`);
  await writeFile(
    p,
    buildZip([
      { name: "mimetype", data: "application/epub+zip", store: true },
      { name: "META-INF/container.xml", data: container },
      { name: "OEBPS/content.opf", data: opf },
      { name: "OEBPS/c1.xhtml", data: `<html xmlns="http://www.w3.org/1999/xhtml"><body>${o.body}</body></html>` },
    ]),
  );
  return p;
};

// Made-up works (10.5555 is a test prefix; the people are invented).
const RIVERS: FileCheckRecord = {
  title: "Rivers and Memory in Upland Villages",
  creators: [{ role: "author", given: "Amara", family: "Okafor" }],
  doi: "10.5555/ao.f11.rivers",
};
const NO_DOI = { title: RIVERS.title, creators: RIVERS.creators };
const CAPITAL: FileCheckRecord = { title: "Capital", creators: [{ role: "author", given: "Wendel", family: "Brakkenridge" }] };

describe("by DOI: the record's DOI as the file's own", () => {
  it("the record's DOI in the first page matches", async () => {
    const p = await pdf({ lines: ["Journal of Upland Studies 12 (2021)", "A study of something", `https://doi.org/${RIVERS.doi}`, "Abstract. Nothing here names the title."] });
    expect(await checkFileAgainstRecord(p, RIVERS)).toMatchObject({ match: true, by: "doi" });
  });

  it("a PDF whose text names another DOI goes to the review queue, never into the source (the file's own DOI comes first)", async () => {
    const p = await pdf({
      title: RIVERS.title,
      author: "Amara Okafor",
      lines: ["Journal of Upland Studies 12 (2021)", "doi:10.5555/ao.f11.someone-else", RIVERS.title, "Amara Okafor", `See also doi:${RIVERS.doi} for the companion piece.`],
    });
    const r = await checkFileAgainstRecord(p, RIVERS);
    expect(r).toMatchObject({ match: false, why: "other-doi" });
    expect(r.evidence.fileDoi).toBe("10.5555/ao.f11.someone-else");
  });

  it("a DOI in the metadata that is not the record's is another DOI, whatever the text says", async () => {
    const p = await epub({ title: RIVERS.title, creator: "Amara Okafor", doi: "10.5555/ao.f11.other", body: `<p>${RIVERS.title}</p><p>doi:${RIVERS.doi}</p>` });
    expect(await checkFileAgainstRecord(p, RIVERS)).toMatchObject({ match: false, why: "other-doi" });
  });

  it("the record's DOI in an EPUB's metadata matches", async () => {
    const p = await epub({ title: "Something else entirely", doi: RIVERS.doi, body: "<p>Chapter one.</p>" });
    expect(await checkFileAgainstRecord(p, RIVERS)).toMatchObject({ match: true, by: "doi" });
  });

  it("a DOI only beyond the first 6,000 characters is not seen", async () => {
    const filler = Array.from({ length: 80 }, (_, i) => `Line ${i} of a long first page with nothing in it but words and more words to fill.`);
    const p = await pdf({ lines: [...filler, `doi:${RIVERS.doi}`] });
    const r = await checkFileAgainstRecord(p, RIVERS);
    expect(r.match).toBe(false);
    expect(FILE_CHECK_TEXT_CHARS).toBe(6000);
  });
});

describe("by title: an embedded title that IS the record's title, with the first author", () => {
  it("an embedded title that is the record's title with the author matches", async () => {
    const p = await pdf({ title: RIVERS.title, author: "Amara Okafor", lines: ["Some text of the first page."] });
    expect(await checkFileAgainstRecord(p, NO_DOI)).toMatchObject({ match: true, by: "title" });
  });

  it("the same title without the author's name anywhere does not match", async () => {
    const p = await pdf({ title: RIVERS.title, author: "Someone Different", lines: ["Some text of the first page."] });
    expect(await checkFileAgainstRecord(p, NO_DOI)).toMatchObject({ match: false, why: "title-absent" });
  });

  it("the same with 'Volume 2' does not match: other-version", async () => {
    const p = await pdf({ title: `${RIVERS.title}, Volume 2`, author: "Amara Okafor", lines: ["Some text."] });
    expect(await checkFileAgainstRecord(p, NO_DOI)).toMatchObject({ match: false, why: "other-version" });
  });

  it("the same with '(review)' does not match: other-version", async () => {
    const p = await pdf({ title: `${RIVERS.title} (review)`, author: "Amara Okafor", lines: ["Some text."] });
    expect(await checkFileAgainstRecord(p, NO_DOI)).toMatchObject({ match: false, why: "other-version" });
  });

  it("an exact embedded title whose first page says 'Second edition' beside the title is another version", async () => {
    const p = await pdf({ title: RIVERS.title, author: "Amara Okafor", lines: [RIVERS.title, "Second edition", "Amara Okafor"] });
    expect(await checkFileAgainstRecord(p, NO_DOI)).toMatchObject({ match: false, why: "other-version" });
  });

  it("a word order that differs is not the same title", async () => {
    const p = await pdf({ title: "Upland Villages in Memory and Rivers", author: "Amara Okafor", lines: ["x"] });
    expect((await checkFileAgainstRecord(p, NO_DOI)).match).toBe(false);
  });

  it("a volume number the record's title holds is not another version", async () => {
    const rec = { title: "Collected Letters, Volume 2", creators: RIVERS.creators };
    const p = await pdf({ title: "Collected Letters, Volume 2", author: "Amara Okafor", lines: ["Collected Letters, Volume 2"] });
    expect(await checkFileAgainstRecord(p, rec)).toMatchObject({ match: true, by: "title" });
  });

  it("an EPUB whose title and creator are the record's matches", async () => {
    const p = await epub({ title: RIVERS.title, creator: "Amara Okafor", body: "<p>Chapter one.</p>" });
    expect(await checkFileAgainstRecord(p, NO_DOI)).toMatchObject({ match: true, by: "title" });
  });
});

describe("by the text of the first pages: 90% (and at least 3) of the title's words in order, with the author", () => {
  it("the record's title in the first page matches", async () => {
    const p = await pdf({ lines: ["Journal of Upland Studies", "Rivers and Memory in Upland Villages", "Amara Okafor", "Abstract. We study rivers."] });
    expect(await checkFileAgainstRecord(p, NO_DOI)).toMatchObject({ match: true, by: "title" });
  });

  it("the title without the author's name does not match", async () => {
    const p = await pdf({ lines: ["Rivers and Memory in Upland Villages", "Someone Different", "Abstract. A long enough first page of ordinary text about rivers."] });
    expect(await checkFileAgainstRecord(p, NO_DOI)).toMatchObject({ match: false, why: "title-absent" });
  });

  it("the title's words scattered over the page do not match", async () => {
    const p = await pdf({ lines: ["Rivers are long.", "Many lines of other words come here to keep them apart from each other.", "Memory fails.", "More words, many of them, unrelated to anything.", "Upland walks.", "Yet more text that has nothing to do with it at all.", "Villages grow.", "Amara Okafor"] });
    expect(await checkFileAgainstRecord(p, NO_DOI)).toMatchObject({ match: false, why: "title-absent" });
  });

  it("'Volume 2' on the title's line is another version", async () => {
    const p = await pdf({ lines: ["Rivers and Memory in Upland Villages, Volume 2", "Amara Okafor"] });
    expect(await checkFileAgainstRecord(p, NO_DOI)).toMatchObject({ match: false, why: "other-version" });
  });

  it("'Erratum' beside the title is another version", async () => {
    const p = await pdf({ lines: ["Erratum: Rivers and Memory in Upland Villages", "Amara Okafor"] });
    expect(await checkFileAgainstRecord(p, NO_DOI)).toMatchObject({ match: false, why: "other-version" });
  });

  it("'Capital' never matches by text alone", async () => {
    const p = await pdf({ lines: ["Capital", "Wendel Brakkenridge", "A study of capital in its many forms."] });
    expect(await checkFileAgainstRecord(p, CAPITAL)).toMatchObject({ match: false, why: "title-absent" });
  });

  it("'Capital' matches by an exact embedded title with its author", async () => {
    const p = await pdf({ title: "Capital", author: "Wendel Brakkenridge", lines: ["Capital"] });
    expect(await checkFileAgainstRecord(p, CAPITAL)).toMatchObject({ match: true, by: "title" });
  });

  it("'Capital, Volume 2' as the embedded title is another version", async () => {
    const p = await pdf({ title: "Capital, Volume 2", author: "Wendel Brakkenridge", lines: ["Capital"] });
    expect(await checkFileAgainstRecord(p, CAPITAL)).toMatchObject({ match: false, why: "other-version" });
  });
});

describe("files that cannot be read", () => {
  it("a scanned PDF without text needs a check", async () => {
    const p = join(tmp, "scan.pdf");
    await writeFile(p, await buildScanPdf(2));
    expect(await checkFileAgainstRecord(p, NO_DOI)).toMatchObject({ match: false, why: "no-text" });
  });

  it("a file the extraction cannot read needs a check", async () => {
    const p = join(tmp, "broken.pdf");
    await writeFile(p, "%PDF-1.7\nnot really a pdf at all");
    expect(await checkFileAgainstRecord(p, NO_DOI)).toMatchObject({ match: false, why: "no-text" });
  });

  it("a broken EPUB needs a check", async () => {
    const p = join(tmp, "broken.epub");
    await writeFile(p, Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(64)]));
    expect(await checkFileAgainstRecord(p, NO_DOI)).toMatchObject({ match: false, why: "no-text" });
  });
});

describe("what the check found, for the researcher (R277 d)", () => {
  it("is bounded and cleaned: the embedded title and the first 300 characters of text, the kind and the size", async () => {
    const long = "W".repeat(2000);
    const p = await pdf({ title: `A ‮title ${long}`, author: "Someone", lines: [`Start of the text ${"x".repeat(400)}`, "more"] });
    const r = await checkFileAgainstRecord(p, NO_DOI);
    expect(r.match).toBe(false);
    expect(r.evidence.kind).toBe("pdf");
    expect(r.evidence.bytes).toBeGreaterThan(100);
    expect(r.evidence.embeddedTitle!.length).toBeLessThanOrEqual(FILE_CHECK_EVIDENCE_CHARS);
    expect(r.evidence.embeddedTitle).not.toMatch(/[‮\u0000-\u001f]/u);
    expect(r.evidence.textStart!.length).toBeLessThanOrEqual(FILE_CHECK_EVIDENCE_CHARS);
    expect(r.evidence.textStart!.startsWith("Start")).toBe(true);
    expect(r.evidence.textStart).not.toMatch(/[\u0000-\u001f]/u);
  });
});
