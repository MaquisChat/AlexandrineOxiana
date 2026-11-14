/**
 * Task F11, the file check in closed form (Ruling R292): the reviewers' rows as a permanent table.
 *
 * Every row of both tables of both reviews (task-F11-review.md: rows A–Q; task-F11-review2.md: K7b–L6, the right
 * files Y1–Y12 and L2–L7), built with the tests' own builders exactly as the reviewer's probe built them, each with
 * the answer R292 requires and the clause that decides it. `before` is what the check answered at 0da788d (the
 * reviewer's observation); `want` is R292's answer. Then, for each clause, pairs of rows that differ only in that
 * clause (one matches, one does not). Every file is made here (no network); the people and works are invented.
 *
 * Reasons: when several apply, the first of no-text, other-doi, other-kind, other-version, title-absent; a file with
 * no place that satisfies clauses 2 and 3 is "title-absent" (R292). A match is always `by: "title"` (R292: a DOI is
 * never evidence; the field is kept because the asset's provenance records it).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPdf, buildZip } from "../../../../tests/fixtures/generate.mjs";
import { checkFileAgainstRecord, type FileCheckRecord } from "./file-check.js";

let tmp: string;
let n = 0;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-file-check-hostile-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Ordinary body text added after a file's own lines (so that it passes the 200-character rule), unless `pad: false`. */
const PAD = [
  "Introduction",
  "The valleys of the north have long been studied by historians of the rural economy and its seasonal labour.",
  "This paper takes up that question with new archival sources from parish registers and estate papers.",
  "We read them against oral testimony gathered between 2015 and 2019 in eleven settlements.",
];

type PdfFile = { kind: "pdf"; title?: string; author?: string; lines: string[]; pad?: boolean };
/** An EPUB: OPF metadata, one chapter whose body is `body` followed by PAD as <p> paragraphs (always). */
type EpubFile = { kind: "epub"; title?: string; creator?: string; doi?: string; body: string };
/** Raw bytes written as a .pdf. */
type RawFile = { kind: "raw"; data: string };
type FileSpec = PdfFile | EpubFile | RawFile;

async function build(f: FileSpec): Promise<string> {
  if (f.kind === "raw") {
    const p = join(tmp, `r${++n}.pdf`);
    await writeFile(p, f.data);
    return p;
  }
  if (f.kind === "pdf") {
    const p = join(tmp, `f${++n}.pdf`);
    const lines = [...f.lines, ...(f.pad === false ? [] : PAD)];
    await writeFile(p, await buildPdf({ ...(f.title !== undefined ? { title: f.title } : {}), ...(f.author !== undefined ? { author: f.author } : {}), lines }));
    return p;
  }
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${f.title ? `<dc:title>${f.title}</dc:title>` : ""}${f.creator ? `<dc:creator>${f.creator}</dc:creator>` : ""}${f.doi ? `<dc:identifier opf:scheme="DOI">${f.doi}</dc:identifier>` : ""}</metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
  const container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const p = join(tmp, `e${++n}.epub`);
  await writeFile(
    p,
    buildZip([
      { name: "mimetype", data: "application/epub+zip", store: true },
      { name: "META-INF/container.xml", data: container },
      { name: "OEBPS/content.opf", data: opf },
      { name: "OEBPS/c1.xhtml", data: `<html xmlns="http://www.w3.org/1999/xhtml"><body>${f.body}${PAD.map((l) => `<p>${l}</p>`).join("")}</body></html>` },
    ]),
  );
  return p;
}

// Records (made-up works and people).
const OK = [{ role: "author" as const, given: "Amara", family: "Okafor" }];
const T = "Rivers and Memory in Upland Villages";
const A = "Amara Okafor";
const D = "10.5555/ao.f11.rivers";
/** R with its DOI. */
const R: FileCheckRecord = { title: T, creators: OK, doi: D };
/** R without a DOI. */
const ND: FileCheckRecord = { title: T, creators: OK };
const CAP: FileCheckRecord = { title: "Capital", creators: [{ role: "author", given: "Wendel", family: "Brakkenridge" }] };
const STATE: FileCheckRecord = { title: "The State", creators: [{ role: "author", family: "Jessopp" }] };

type Answer = "MATCH title" | "MATCH doi" | "no-text" | "other-doi" | "title-absent" | "other-version" | "other-kind";
/** `before`: the check's answer at 0da788d (the reviewer's observation). `want`: R292's answer; `clause`: what decides it. */
type Row = { id: string; what: string; record: FileCheckRecord; file: FileSpec; before?: Answer; want: Answer; clause: string };

const run = async (row: Row): Promise<Answer> => {
  const r = await checkFileAgainstRecord(await build(row.file), row.record);
  return r.match ? (`MATCH ${r.by}` as Answer) : r.why;
};

const ROWS: Row[] = [
  // ---- the first review's rows (task-F11-review.md), as the second review ran them again ----
  { id: "A", what: "Capital: embedded title + author; CAPITAL / A Critique... / Volume II / author", record: CAP, file: { kind: "pdf", title: "Capital", author: "Wendel Brakkenridge", lines: ["CAPITAL", "A Critique of Political Economy", "Volume II", "Wendel Brakkenridge"] }, before: "other-version", want: "title-absent", clause: "3: the line below the block ('A Critique of …') is not a line of names" },
  { id: "A2", what: "Capital: 'capital' in a sentence first, 'CAPITAL Volume II' later", record: CAP, file: { kind: "pdf", title: "Capital", author: "Wendel Brakkenridge", lines: ["Introduction on capital flows", "of nations", "nothing", "CAPITAL Volume II", "Wendel Brakkenridge"] }, before: "other-version", want: "title-absent", clause: "2: no line holds exactly the title's content words" },
  { id: "B", what: "Capital: embedded title + author, no text (no pad)", record: CAP, file: { kind: "pdf", title: "Capital", author: "Wendel Brakkenridge", lines: [], pad: false }, before: "no-text", want: "no-text", clause: "1" },
  { id: "B2", what: "R: embedded title + author, no text (no pad), record with DOI", record: R, file: { kind: "pdf", title: T, author: "Amara Okafor", lines: [], pad: false }, before: "no-text", want: "no-text", clause: "1" },
  { id: "C", what: "The State: embedded 'State' + author, text State / Jessopp", record: STATE, file: { kind: "pdf", title: "State", author: "Bob Jessopp", lines: ["State", "Bob Jessopp"] }, before: "MATCH title", want: "MATCH title", clause: "2–8 hold: 'State' is the title's one content word; 'Bob Jessopp' below; nothing above" },
  { id: "C2", what: "Gender: text 'Gender / Ann Oakleigh / A review of gender studies'", record: { title: "Gender", creators: [{ role: "author", family: "Oakleigh" }] }, file: { kind: "pdf", lines: ["Gender", "Ann Oakleigh", "A review of gender studies"] }, before: "other-kind", want: "other-kind", clause: "5: 'review of' + the record's title within three lines after the block (R284 a as built)" },
  { id: "D", what: "record title is the prefix of the file's title line", record: ND, file: { kind: "pdf", lines: [`${T} of the North: A Sequel`, "Amara Okafor"] }, before: "title-absent", want: "title-absent", clause: "2: extra words on the line" },
  { id: "D2", what: "record 'Rivers, Memory and Upland' against a longer title", record: { title: "Rivers, Memory and Upland", creators: OK }, file: { kind: "pdf", lines: ["Rivers, Memory and Upland Farming Cooperatives in Twentieth-Century Wales", "Amara Okafor"] }, before: "title-absent", want: "title-absent", clause: "2: extra words on the line" },
  { id: "E", what: "book review: BOOK REVIEWS / R. By Okafor... / Reviewed by; embedded title = R", record: ND, file: { kind: "pdf", title: T, author: "Someone Else", lines: ["BOOK REVIEWS", `${T}. By Amara Okafor. Upland Press, 2020.`, "Reviewed by Someone Else", "This book is a fine study."] }, before: "other-kind", want: "title-absent", clause: "2: the title's line also holds the citation; the embedded title is never evidence (8)" },
  { id: "E2", what: "book review, no embedded title", record: ND, file: { kind: "pdf", lines: ["BOOK REVIEWS", `${T}. By Amara Okafor. Upland Press, 2020. 300 pp.`, "", "Reviewed by Someone Else", "This book is a fine study."] }, before: "other-kind", want: "title-absent", clause: "2: no block" },
  { id: "E3", what: "Book Review + the record's DOI", record: R, file: { kind: "pdf", lines: ["Book Review", `Okafor, Amara. ${T}.`, `Upland Press. doi:${D}`, "Reviewer: Someone"] }, before: "other-kind", want: "title-absent", clause: "2: no block (the DOI is never evidence: 7)" },
  { id: "F", what: "reply citing title + DOI, no DOI of its own", record: R, file: { kind: "pdf", lines: ["Journal of Upland Studies 13 (2022)", "A reply to Okafor", `In ${T} (doi:${D}), Amara Okafor argues`, "that rivers shape memory. We disagree."] }, before: "other-kind", want: "title-absent", clause: "2: the title only inside a sentence" },
  { id: "F2", what: "comment citing the title only (record with DOI)", record: R, file: { kind: "pdf", lines: ["A Comment on Okafor", `In her ${T}, Amara Okafor argues`, "that rivers shape memory. We disagree with this."] }, before: "other-kind", want: "title-absent", clause: "2: the title only inside a sentence" },
  { id: "G", what: "another paper with R in a page-1 bibliography line", record: ND, file: { kind: "pdf", lines: ["Mountain Pastures and Seasonal Labour", "Carl Other", "Abstract. A study of pastures.", "References", `Okafor, A. (2020) ${T}. Upland Press.`] }, before: "title-absent", want: "title-absent", clause: "2: no block" },
  { id: "H", what: "Correction to: R + the record's DOI", record: R, file: { kind: "pdf", lines: [`Correction to: ${T}`, "Amara Okafor", `The original article can be found online at https://doi.org/${D}`] }, before: "other-kind", want: "title-absent", clause: "2: 'Correction to' on the title's line" },
  { id: "H2", what: "Erratum / R / doi:R / Okafor", record: R, file: { kind: "pdf", lines: ["Erratum", T, `doi:${D}`, "Amara Okafor"] }, before: "other-kind", want: "title-absent", clause: "3: the line below the block is the DOI, not a line of names" },
  { id: "H3", what: "Retraction Note: R + doi", record: R, file: { kind: "pdf", lines: [`Retraction Note: ${T}`, `doi:${D}`, "Amara Okafor"] }, before: "other-kind", want: "title-absent", clause: "2: 'Retraction Note' on the title's line" },
  { id: "H4", what: "Supplementary material for R + doi", record: R, file: { kind: "pdf", lines: ["Supplementary material for", T, `https://doi.org/${D}`, "Amara Okafor"] }, before: "other-kind", want: "title-absent", clause: "3: the line below the block is a web address" },
  { id: "H5", what: "Correction to: R (no DOI)", record: ND, file: { kind: "pdf", lines: [`Correction to: ${T}`, "Amara Okafor"] }, before: "other-kind", want: "title-absent", clause: "2: 'Correction to' on the title's line" },
  { id: "H6", what: "R / Part II / Okafor", record: ND, file: { kind: "pdf", lines: [T, "Part II", "Amara Okafor"] }, before: "other-version", want: "title-absent", clause: "3: 'Part II' below the block does not hold the family name" },
  { id: "H7", what: "R / 2nd edition / Okafor", record: ND, file: { kind: "pdf", lines: [T, "2nd edition", "Amara Okafor"] }, before: "other-version", want: "title-absent", clause: "3: '2nd edition' is not a line of names" },
  { id: "H8", what: "R / Essays on the North / Volume 2 / Okafor", record: ND, file: { kind: "pdf", lines: [T, "Essays on the North", "Volume 2", "Amara Okafor"] }, before: "other-version", want: "title-absent", clause: "3: a subtitle below the block, not a line of names" },
  { id: "H9", what: "Reviewed Work: / R by Okafor", record: ND, file: { kind: "pdf", lines: ["Reviewed Work:", `${T} by Amara Okafor`] }, before: "other-kind", want: "title-absent", clause: "2: the name on the title's line" },
  { id: "K1", what: "the record's DOI in upper case, alone", record: R, file: { kind: "pdf", lines: [`doi:${D.toUpperCase()}`] }, before: "title-absent", want: "title-absent", clause: "2 (7: the DOI is never evidence)" },
  { id: "K2", what: "DOI ...rivers2 + title + author", record: R, file: { kind: "pdf", lines: [`doi:${D}2`, T, "Amara Okafor"] }, before: "other-doi", want: "other-doi", clause: "7" },
  { id: "K3", what: "DOI ...river (a prefix of the record's) + title + author", record: R, file: { kind: "pdf", lines: ["doi:10.5555/ao.f11.river", T, "Amara Okafor"] }, before: "other-doi", want: "other-doi", clause: "7" },
  // K4: a right file by the reviewer's table, held by the letter of clause 4: the DOI's broken end "rivers" stands as a
  // one-word line directly above the title.
  { id: "K4", what: "DOI wrapped across a line (joined = the record's) + title + author", record: R, file: { kind: "pdf", lines: ["doi:10.5555/ao.f11.", "rivers", T, "Amara Okafor"] }, before: "MATCH doi", want: "other-kind", clause: "4: 'rivers' is a one-word line directly above the block" },
  { id: "K5", what: "DOI in a URL with ?utm=1 + title + author", record: R, file: { kind: "pdf", lines: [`https://doi.org/${D}?utm=1`, T, "Amara Okafor"] }, before: "other-doi", want: "other-doi", clause: "7 (the query is read into the DOI, as built)" },
  { id: "K6", what: "DOI with a trailing full stop + title + author", record: R, file: { kind: "pdf", lines: [`See doi:${D}.`, T, "Amara Okafor"] }, before: "MATCH doi", want: "MATCH title", clause: "2–8 hold (the line above holds a digit)" },
  { id: "K7", what: "Cites doi:R / Our doi:other (no title)", record: R, file: { kind: "pdf", lines: [`Cites doi:${D}`, "Our doi:10.5555/ao.f11.other"] }, before: "title-absent", want: "title-absent", clause: "2 (7 excuses the other DOI after the record's, as built)" },
  { id: "P", what: "EPUB: metadata DOI = the record's, content another work", record: R, file: { kind: "epub", title: "Pastures", creator: "Carl Other", doi: D, body: "<p>Mountain Pastures and Seasonal Labour by Carl Other.</p>" }, before: "title-absent", want: "title-absent", clause: "2" },
  { id: "L", what: "Notes on R by Carl Other; family 'Young' read from 'Young people'", record: { title: T, creators: [{ role: "author", family: "Young" }] }, file: { kind: "pdf", lines: [`Notes on ${T}`, "by Carl Other", "Young people leave the villages."] }, before: "other-kind", want: "title-absent", clause: "2: 'Notes on' on the title's line" },
  { id: "O", what: "two columns interleaved (right file)", record: ND, file: { kind: "pdf", lines: ["Rivers and Memory          Abstract text of the", "in Upland Villages           other column here", "Amara Okafor"] }, before: "title-absent", want: "title-absent", clause: "2: the other column's words on the title's lines (accepted cost)" },
  { id: "Q", what: "damaged PDF", record: ND, file: { kind: "raw", data: "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj trailer" }, before: "no-text", want: "no-text", clause: "1" },

  // ---- the second review's new hostile rows (task-F11-review2.md) ----
  { id: "K7b", what: "Cites doi:R / Our doi:other / R in a sentence with Okafor", record: R, file: { kind: "pdf", lines: [`Cites doi:${D}`, "Our doi:10.5555/ao.f11.other", `We revisit ${T} by Amara Okafor.`] }, before: "MATCH doi", want: "title-absent", clause: "2: the title only inside a sentence (the DOI is never evidence: 7)" },
  { id: "N1", what: "another paper; abstract names R + Okafor; reference with doi:R; no own DOI, no metadata title", record: R, file: { kind: "pdf", lines: ["Mountain Pastures and Seasonal Labour", "Carl Other", `Abstract. Building on ${T} by Amara Okafor, we study pastures.`, "References", `Okafor, A. (2020) ${T}. doi:${D}`] }, before: "MATCH doi", want: "title-absent", clause: "2: no block" },
  { id: "N1b", what: "N1 with embedded title 'Mountain Pastures and Seasonal Labour'", record: R, file: { kind: "pdf", title: "Mountain Pastures and Seasonal Labour", lines: ["Mountain Pastures and Seasonal Labour", "Carl Other", `Abstract. Building on ${T} by Amara Okafor, we study pastures.`, "References", `Okafor, A. (2020) ${T}. doi:${D}`] }, before: "title-absent", want: "title-absent", clause: "2: no block" },
  { id: "N1c", what: "running head with doi:R; own title line; R in a sentence", record: R, file: { kind: "pdf", lines: [`Upland Studies 13 | doi:${D}`, "Seasonal Labour on Northern Pastures", "Carl Other", `As ${T} by Amara Okafor shows, memory travels.`] }, before: "MATCH doi", want: "title-absent", clause: "2: no block" },
  { id: "N2", what: "unlabelled review: heading is the book citation; embedded title = R (JSTOR-style)", record: ND, file: { kind: "pdf", title: T, author: "Someone Else", lines: [`${T}. By Amara Okafor. Upland Press, 2020. 300 pp. $45.00.`, "This ambitious book asks how rivers shape the memory of villages.", "Someone Else, University of Elsewhere"] }, before: "MATCH title", want: "title-absent", clause: "2: the citation on the title's line (8: the embedded title is never evidence)" },
  { id: "N2b", what: "unlabelled review: the book's title as a line, 'By Amara Okafor...300 pp.' below, no embedded title", record: ND, file: { kind: "pdf", lines: [T, "By Amara Okafor. Upland Press, 2020. 300 pp.", "This ambitious book asks how rivers shape memory. Someone Else"] }, before: "MATCH title", want: "title-absent", clause: "3: a year, a number and 'pp.' make the line below not a line of names" },
  { id: "N3", what: "A Response to \"R\" / Carl Other", record: ND, file: { kind: "pdf", lines: [`A Response to "${T}"`, "Carl Other"] }, before: "other-kind", want: "title-absent", clause: "2: 'A Response to' on the title's line" },
  { id: "N3b", what: "Reply to Okafor / Carl Other + R in the text", record: ND, file: { kind: "pdf", lines: ["Reply to Okafor", "Carl Other", `On ${T}, by Amara Okafor.`] }, before: "other-kind", want: "title-absent", clause: "2: no block" },
  { id: "N3c", what: "Rejoinder / R / Okafor", record: ND, file: { kind: "pdf", lines: ["Rejoinder", T, "Amara Okafor"] }, before: "other-kind", want: "other-kind", clause: "4: 'Rejoinder' is a one-word line above the block that is not an ordinary label" },
  { id: "N4", what: "Notice of Retraction / R / Okafor / doi", record: R, file: { kind: "pdf", lines: ["Notice of Retraction", T, "Amara Okafor", `doi:${D}`] }, before: "other-kind", want: "other-kind", clause: "4 (and 5: 'retraction')" },
  { id: "N4b", what: "RETRACTED: R / Okafor / doi", record: R, file: { kind: "pdf", lines: [`RETRACTED: ${T}`, "Amara Okafor", `doi:${D}`] }, before: "other-kind", want: "title-absent", clause: "2: 'RETRACTED' on the title's line" },
  { id: "N5", what: "Supporting Information (lone line) / R / Okafor", record: ND, file: { kind: "pdf", lines: ["Supporting Information", T, "Amara Okafor"] }, before: "MATCH title", want: "other-kind", clause: "4 (and 5: 'supporting information')" },
  { id: "N5b", what: "Online Appendix / R / Okafor", record: ND, file: { kind: "pdf", lines: ["Online Appendix", T, "Amara Okafor"] }, before: "MATCH title", want: "other-kind", clause: "4 (and 5: 'online appendix')" },
  { id: "N5c", what: "Supplement (lone line) / R / Okafor", record: ND, file: { kind: "pdf", lines: ["Supplement", T, "Amara Okafor"] }, before: "other-kind", want: "other-kind", clause: "4 (and 5: the lone line 'Supplement')" },
  { id: "N6", what: "R / Volume Two / Okafor", record: ND, file: { kind: "pdf", lines: [T, "Volume Two", "Amara Okafor"] }, before: "other-version", want: "title-absent", clause: "3: 'Volume Two' below the block does not hold the family name" },
  { id: "N6b", what: "R / Third Edition, Revised and Expanded / Okafor", record: ND, file: { kind: "pdf", lines: [T, "Third Edition, Revised and Expanded", "Amara Okafor"] }, before: "other-version", want: "title-absent", clause: "3: the line below does not hold the family name" },
  { id: "N6c", what: "R / Okafor / Second Edition", record: ND, file: { kind: "pdf", lines: [T, "Amara Okafor", "Second Edition"] }, before: "other-version", want: "other-version", clause: "6: an edition line within twelve lines below" },
  { id: "N6d", what: "R / Okafor / Upland Press / London / New York / 'Second edition published 2021'", record: ND, file: { kind: "pdf", lines: [T, "Amara Okafor", "Upland Press", "London", "New York", "Second edition published 2021"] }, before: "MATCH title", want: "other-version", clause: "6: the edition line five lines below, within twelve (M10)" },
  { id: "N6e", what: "R / Book Two of the Upland Trilogy / Okafor", record: ND, file: { kind: "pdf", lines: [T, "Book Two of the Upland Trilogy", "Amara Okafor"] }, before: "other-version", want: "title-absent", clause: "3: the line below is not a line of names" },
  { id: "N6f", what: "embedded title 'R, Vol. 2' + the R block", record: ND, file: { kind: "pdf", title: `${T}, Vol. 2`, author: "Amara Okafor", lines: [T, "Amara Okafor"] }, before: "other-version", want: "other-version", clause: "6: a volume in the embedded title, as built (8 would also hold it)" },
  { id: "N6g", what: "R / Volume 1 / Okafor", record: ND, file: { kind: "pdf", lines: [T, "Volume 1", "Amara Okafor"] }, before: "other-version", want: "title-absent", clause: "3: a number standing by itself on the line below" },
  { id: "N7", what: "preprint of a DIFFERENT paper, same author ('...Lowland Towns'), arXiv line first", record: ND, file: { kind: "pdf", lines: ["arXiv:2101.00001v1 [econ.GN] 3 Jan 2021", "Rivers and Memory in Lowland Towns", "Amara Okafor"] }, before: "title-absent", want: "title-absent", clause: "2" },
  { id: "N7b", what: "'R Revisited' on one line, same author", record: ND, file: { kind: "pdf", lines: [`${T} Revisited`, "Amara Okafor"] }, before: "title-absent", want: "title-absent", clause: "2: an extra word" },
  { id: "N7c", what: "R / 'Revisited' (capitalised next line) / Okafor", record: ND, file: { kind: "pdf", lines: [T, "Revisited", "Amara Okafor"] }, before: "MATCH title", want: "title-absent", clause: "3: 'Revisited' goes on with the title; it does not hold the family name" },
  { id: "N7d", what: "R / 'A Second Look' / Okafor", record: ND, file: { kind: "pdf", lines: [T, "A Second Look", "Amara Okafor"] }, before: "MATCH title", want: "title-absent", clause: "3" },
  { id: "N8", what: "The State against 'The Statesman's Yearbook'", record: STATE, file: { kind: "pdf", lines: ["The Statesman's Yearbook", "Bob Jessopp"] }, before: "title-absent", want: "title-absent", clause: "2" },
  { id: "N8b", what: "Capital against 'CAPITAL / AND IDEOLOGY', same author, embedded 'Capital and Ideology'", record: CAP, file: { kind: "pdf", title: "Capital and Ideology", author: "Wendel Brakkenridge", lines: ["CAPITAL", "AND IDEOLOGY", "Wendel Brakkenridge"] }, before: "MATCH title", want: "title-absent", clause: "3 (and 8: an embedded title of two content words that is not the record's)" },
  { id: "N8c", what: "Capital against 'CAPITAL / IN THE TWENTY-FIRST CENTURY', same author, embedded title", record: CAP, file: { kind: "pdf", title: "Capital in the Twenty-First Century", author: "Wendel Brakkenridge", lines: ["CAPITAL", "IN THE TWENTY-FIRST CENTURY", "Wendel Brakkenridge"] }, before: "title-absent", want: "title-absent", clause: "3 (and 8)" },
  { id: "N8d", what: "Capital against 'CAPITAL / AND IDEOLOGY', no embedded title", record: CAP, file: { kind: "pdf", lines: ["CAPITAL", "AND IDEOLOGY", "Wendel Brakkenridge"] }, before: "MATCH title", want: "title-absent", clause: "3: 'AND IDEOLOGY' does not hold the family name" },
  { id: "N8e", what: "The State against 'THE STATE / PAST, PRESENT, FUTURE', same author, no embedded title", record: STATE, file: { kind: "pdf", lines: ["THE STATE", "PAST, PRESENT, FUTURE", "Bob Jessopp"] }, before: "MATCH title", want: "title-absent", clause: "3" },
  { id: "N9", what: "repository cover sheet citing R, then a different paper", record: ND, file: { kind: "pdf", lines: ["Upland Repository", "This is a cover sheet. Please cite:", `Okafor, Amara (2020). ${T}.`, "Downloaded 2026", "Mountain Pastures and Seasonal Labour", "Carl Other"] }, before: "title-absent", want: "title-absent", clause: "2" },
  { id: "N11", what: "EPUB: metadata DOI = R (settable); another work naming R in its first paragraph", record: R, file: { kind: "epub", doi: D, body: `<p>Mountain Pastures and Seasonal Labour</p><p>Carl Other</p><p>Building on ${T} by Amara Okafor, we study pastures.</p>` }, before: "MATCH doi", want: "title-absent", clause: "2 (7: the metadata DOI is never evidence)" },
  { id: "N12", what: "fewer than 200 characters: the R block + author (no pad)", record: ND, file: { kind: "pdf", lines: [T, "Amara Okafor"], pad: false }, before: "no-text", want: "no-text", clause: "1" },
  { id: "N13", what: "about 200 characters: the title repeated + author (no pad)", record: ND, file: { kind: "pdf", lines: [T, "Amara Okafor", T, T, T, T, T], pad: false }, before: "no-text", want: "no-text", clause: "1" },
  { id: "N14", what: "EPUB: embedded title = R + creator Okafor; body another work naming R", record: ND, file: { kind: "epub", title: T, creator: "Amara Okafor", body: `<p>Mountain Pastures</p><p>Carl Other</p><p>Unlike ${T} by Amara Okafor, this is about pastures.</p>` }, before: "MATCH title", want: "title-absent", clause: "2 (8: the embedded title is never evidence)" },
  { id: "N15", what: "Editorial (lone line) / R / Okafor", record: ND, file: { kind: "pdf", lines: ["Editorial", T, "Amara Okafor"] }, before: "other-kind", want: "other-kind", clause: "4 (and 5)" },
  { id: "N16", what: "'Introduction to R' / Carl Other", record: ND, file: { kind: "pdf", lines: [`Introduction to ${T}`, "Carl Other"] }, before: "other-kind", want: "title-absent", clause: "2: 'Introduction to' on the title's line" },
  { id: "N17", what: "Symposium (lone line) / R / Okafor", record: ND, file: { kind: "pdf", lines: ["Symposium", T, "Amara Okafor"] }, before: "MATCH title", want: "other-kind", clause: "4: 'Symposium' is not an ordinary label" },
  { id: "N18", what: "Conference Abstracts / R / Okafor", record: ND, file: { kind: "pdf", lines: ["Conference Abstracts", T, "Amara Okafor"] }, before: "MATCH title", want: "other-kind", clause: "4 (and 5: 'conference abstracts')" },
  { id: "N19", what: "one chapter: R / Okafor / Chapter 3 / The Ferry", record: ND, file: { kind: "pdf", lines: [T, "Amara Okafor", "Chapter 3", "The Ferry"] }, before: "MATCH title", want: "other-version", clause: "6: 'Chapter 3' with no chapter numbered one before it (I6)" },
  { id: "N20", what: "contents page listing R + Okafor and another title", record: ND, file: { kind: "pdf", lines: ["Journal of Upland Studies", "Contents", T, "Amara Okafor", "Mountain Pastures and Seasonal Labour", "Carl Other"] }, before: "MATCH title", want: "other-kind", clause: "4: 'Contents' directly above (and 5)" },
  { id: "L1", what: "EPUB look-alike: Cyrillic o in title and name (another file)", record: ND, file: { kind: "epub", body: "<p>Rivers and Memоry in Upland Villages</p><p>Amara Оkafor</p>" }, before: "title-absent", want: "title-absent", clause: "2" },
  { id: "L5", what: "EPUB: 'R\\u200B Revisited' (zero-width space)", record: ND, file: { kind: "epub", body: `<p>${T}​ Revisited</p><p>Amara Okafor</p>` }, before: "title-absent", want: "title-absent", clause: "2" },
  { id: "L6", what: "EPUB: R / Revisited as two paragraphs", record: ND, file: { kind: "epub", body: `<p>${T}</p><p>Revisited</p><p>Amara Okafor</p>` }, before: "MATCH title", want: "title-absent", clause: "3" },

  // ---- right files (the second review's ten ordinary layouts and its extra right files) ----
  { id: "Y1", what: "RIGHT: journal header with Vol./No./pp., title block, author, affiliation, DOI line, abstract", record: R, file: { kind: "pdf", lines: ["Journal of Upland Studies, Vol. 12, No. 3 (2021), pp. 101-130", T, "Amara Okafor", "University of the North", `DOI: ${D}`, "Abstract. Rivers shape memory."] }, before: "MATCH doi", want: "MATCH title", clause: "2–8 hold (the line above holds a digit)" },
  { id: "Y2", what: "RIGHT: Y1 without the DOI line, record without DOI", record: ND, file: { kind: "pdf", lines: ["Journal of Upland Studies, Vol. 12, No. 3 (2021), pp. 101-130", T, "Amara Okafor", "University of the North", "Abstract. Rivers shape memory."] }, before: "MATCH title", want: "MATCH title", clause: "2–8 hold" },
  { id: "Y3", what: "RIGHT: title on two lines (title case), authors below", record: ND, file: { kind: "pdf", lines: ["Rivers and Memory", "in Upland Villages", "Amara Okafor and Ben Smith", "Abstract. Rivers shape memory."] }, before: "MATCH title", want: "MATCH title", clause: "2–8 hold" },
  { id: "Y3b", what: "RIGHT: title on two lines, second line capitalised", record: ND, file: { kind: "pdf", lines: ["Rivers and Memory in", "Upland Villages", "Amara Okafor and Ben Smith", "Abstract."] }, before: "MATCH title", want: "MATCH title", clause: "2–8 hold" },
  { id: "Y4", what: "RIGHT: record with a subtitle; 'Rivers and Memory:' / 'Upland Villages since 1800'", record: { title: "Rivers and Memory: Upland Villages since 1800", creators: OK }, file: { kind: "pdf", lines: ["Rivers and Memory:", "Upland Villages since 1800", "Amara Okafor"] }, before: "MATCH title", want: "MATCH title", clause: "2–8 hold" },
  { id: "Y5", what: "RIGHT: book chapter with an 'In: Northern Histories, ed. by ...' header", record: ND, file: { kind: "pdf", lines: ["In: Northern Histories, ed. by C. Editor (Upland Press, 2021), 45-70", T, "Amara Okafor"] }, before: "MATCH title", want: "MATCH title", clause: "2–8 hold (the line above holds a digit)" },
  { id: "Y6", what: "RIGHT: EPUB book, metadata title + creator, title page", record: ND, file: { kind: "epub", title: T, creator: "Amara Okafor", body: `<p>${T}</p><p>Amara Okafor</p><p>Upland Press</p>` }, before: "MATCH title", want: "MATCH title", clause: "2–8 hold" },
  { id: "Y7", what: "RIGHT: arXiv preprint, margin id, title, 'Amara Okafor1, Ben Smith2', affiliations", record: ND, file: { kind: "pdf", lines: ["arXiv:2101.00001v2 [econ.GN] 3 Jan 2021", T, "Amara Okafor1, Ben Smith2", "1 University of the North 2 Elsewhere", "Abstract. Rivers shape memory."] }, before: "title-absent", want: "MATCH title", clause: "3: affiliation digits glued to a name are left out" },
  { id: "Y8", what: "RIGHT: the DOI only in a footer beyond 2,000 characters (record with DOI)", record: R, file: { kind: "pdf", lines: [T, "Amara Okafor", "Abstract. Rivers shape memory.", ...PAD, ...PAD, ...PAD, ...PAD, ...PAD, `https://doi.org/${D}`] }, before: "MATCH doi", want: "MATCH title", clause: "2–8 hold" },
  { id: "Y9", what: "RIGHT: title and author in capitals (record with DOI, no DOI in the file)", record: R, file: { kind: "pdf", lines: ["RIVERS AND MEMORY IN UPLAND VILLAGES", "AMARA OKAFOR", "Abstract."] }, before: "MATCH title", want: "MATCH title", clause: "2–8 hold" },
  { id: "Y10", what: "RIGHT: author above the title (humanities layout)", record: ND, file: { kind: "pdf", lines: ["Amara Okafor", T, "Abstract. Rivers shape memory."] }, before: "title-absent", want: "title-absent", clause: "3: the line below is the abstract (accepted cost: the author above the title)" },
  {
    id: "Y11",
    what: "RIGHT: a long repository cover sheet, then the paper (record with DOI)",
    record: R,
    file: {
      kind: "pdf",
      lines: [
        "Upland Repository - Open Access",
        "This is the author's accepted manuscript of an article published in Journal of Upland Studies.",
        "Copyright remains with the authors. This version is made available under a CC BY licence.",
        "Please cite the published version. Terms of use apply; see the repository's policies page for details.",
        "Downloaded from the Upland Repository on 3 January 2026 by an anonymous reader of this deposit.",
        "Any queries should be addressed to the repository team, who will reply within thirty working days.",
        "Further information about open access is given on the repository's web pages for researchers here.",
        "Rights and permissions for reuse are stated in the licence that accompanies this deposit online.",
        T,
        "Amara Okafor",
      ],
    },
    before: "MATCH title",
    want: "MATCH title",
    clause: "2–8 hold (the line above has eight or more words)",
  },
  { id: "Y12", what: "RIGHT: 'Fishing Rivers and Memory' (plain letters: WinAnsi cannot draw a ligature)", record: { title: "Fishing Rivers and Memory", creators: OK }, file: { kind: "pdf", lines: ["Fishing Rivers and Memory", "Amara Okafor"] }, before: "MATCH title", want: "MATCH title", clause: "2–8 hold" },
  { id: "L2", what: "EPUB RIGHT: ligature U+FB01 in a title word", record: { title: "Fishing Rivers and Memory", creators: OK }, file: { kind: "epub", body: "<p>ﬁshing Rivers and Memory</p><p>Amara Okafor</p>" }, before: "MATCH title", want: "MATCH title", clause: "2 (ligatures as built)" },
  { id: "L3", what: "EPUB RIGHT: soft hyphen inside a title word", record: ND, file: { kind: "epub", body: "<p>Rivers and Mem­ory in Upland Villages</p><p>Amara Okafor</p>" }, before: "MATCH title", want: "MATCH title", clause: "2 (soft hyphens as built)" },
  { id: "L4", what: "EPUB RIGHT: RLM / LRM marks in the title line", record: ND, file: { kind: "epub", body: "<p>‏Rivers and Memory‎ in Upland Villages</p><p>Amara Okafor</p>" }, before: "MATCH title", want: "MATCH title", clause: "2" },
  // L7: a right file by the reviewer's table, held by the letter of clause 3: "1" and "2" stand by themselves.
  { id: "L7", what: "RIGHT: Y7 with 'Amara Okafor 1, Ben Smith 2' (spaced superscripts)", record: ND, file: { kind: "pdf", lines: ["arXiv:2101.00001v2 [econ.GN] 3 Jan 2021", T, "Amara Okafor 1, Ben Smith 2", "Abstract."] }, before: "MATCH title", want: "title-absent", clause: "3: a number standing by itself makes the line not a line of names" },
];

// ---- for each clause, pairs of rows that differ only in that clause (one matches, one does not) ----
/** A line of at least eight words (running text: allowed directly above the block; no sign, version or number). */
const F = "Ordinary words of a page that say nothing about anything in particular here, at all.";
const fill = (k: number) => Array.from({ length: k }, () => F);
const pdf = (lines: string[], meta: { title?: string; author?: string } = {}): FileSpec => ({ kind: "pdf", ...meta, lines });
const JOURNAL = "Journal of Upland Studies";
const WITH_CONTAINER: FileCheckRecord = { ...ND, container: JOURNAL };

/** The ordinary article labels of clause 4: each, as the whole line directly above the block, lets the file match. */
const ORDINARY_LABELS = ["Article", "Research Article", "ORIGINAL ARTICLE", "Original Paper", "Original Research", "Research Paper", "Full Paper", "Full Length Article", "Review Article", "Brief Report", "Short Communication", "Brief Communication", "Rapid Communication", "Letter", "Open Access", "Preprint", "Pre-print", "Working Paper", "Discussion Paper", "Accepted Manuscript", "Author Accepted Manuscript", "Author's Accepted Manuscript", "Postprint", "Post-print", "Manuscript", "Article in Press", "Version of Record", "Published Version"];
/** The labels clause 5 adds, as a line's beginning or a line of their own: each, high in the title zone, holds the file. */
const ADDED_KIND_LABELS = ["Supporting Information", "Supplementary Information", "Supplementary Material", "Supplementary Materials", "Supplementary Data", "Online Appendix", "Online Supplement", "Appendix", "SI Appendix", "Data Supplement", "Contents", "Table of Contents", "Abstracts", "Conference Abstracts", "Book of Abstracts", "Book Notes", "Books Received", "Publisher's Note", "Editor's Note", "Expression of Concern", "In Memoriam", "Index", "Front Matter", "Back Matter"];

const PAIRS: Row[] = [
  // Clause 2: the title block.
  { id: "2.exact", what: "the block exact", record: ND, file: pdf([T, A]), want: "MATCH title", clause: "2" },
  { id: "2.missing", what: "the block with one word missing", record: ND, file: pdf(["Rivers and Memory in Upland", A]), want: "title-absent", clause: "2: a word missing" },
  { id: "2.extra", what: "the block with one word extra", record: ND, file: pdf([`${T} Today`, A]), want: "title-absent", clause: "2: a word extra" },
  { id: "2.sentence", what: "the title in the middle of a sentence", record: ND, file: pdf([`In this study, ${T} is read again`, A]), want: "title-absent", clause: "2: other words on the title's line" },
  { id: "2.within2000", what: "the block beginning before character 2,000 (22 lines of running text above)", record: ND, file: pdf([...fill(22), T, A]), want: "MATCH title", clause: "2" },
  { id: "2.beyond2000", what: "the block beginning after character 2,000 (24 lines of running text above)", record: ND, file: pdf([...fill(24), T, A]), want: "title-absent", clause: "2: beginning beyond the first 2,000 characters" },
  { id: "2.fourLines", what: "the block on four lines", record: ND, file: pdf(["Rivers and", "Memory in", "Upland", "Villages", A]), want: "MATCH title", clause: "2" },
  { id: "2.fiveLines", what: "the block on five lines", record: ND, file: pdf(["Rivers", "and", "Memory", "in Upland", "Villages", A]), want: "title-absent", clause: "2: more than four lines" },
  // Clause 3: the line of names directly below.
  { id: "3.names", what: "below: a line of names", record: ND, file: pdf([T, "Amara Okafor and Ben Smith"]), want: "MATCH title", clause: "3" },
  { id: "3.year", what: "below: names with a year", record: ND, file: pdf([T, "Amara Okafor and Ben Smith 2020"]), want: "title-absent", clause: "3: a year" },
  { id: "3.pp", what: "below: names with 'pp.'", record: ND, file: pdf([T, "Amara Okafor and Ben Smith pp."]), want: "title-absent", clause: "3: 'pp.'" },
  { id: "3.price", what: "below: names with a price", record: ND, file: pdf([T, "Amara Okafor and Ben Smith $45"]), want: "title-absent", clause: "3: a price" },
  { id: "3.web", what: "below: names with a web address", record: ND, file: pdf([T, "Amara Okafor and Ben Smith www.upland.org"]), want: "title-absent", clause: "3: a web address" },
  { id: "3.email", what: "below: names with an e-mail address", record: ND, file: pdf([T, "Amara Okafor and Ben Smith amara@upland.org"]), want: "title-absent", clause: "3: an e-mail address" },
  { id: "3.number", what: "below: names with a number standing by itself", record: ND, file: pdf([T, "Amara Okafor and Ben Smith 3"]), want: "title-absent", clause: "3: a number by itself" },
  { id: "3.goesOn", what: "below: a line that goes on with the title", record: ND, file: pdf([T, "Revisited", A]), want: "title-absent", clause: "3: the family name absent from the line directly below" },
  { id: "3.familyAbsent", what: "below: a line of names without the family name", record: ND, file: pdf([T, "Ben Smith and Carl Other"]), want: "title-absent", clause: "3: the family name absent" },
  { id: "3.lowerWord", what: "below: names with a lower-case word that is not a joining word", record: ND, file: pdf([T, "Amara Okafor from Upland"]), want: "title-absent", clause: "3: 'from' is none of the allowed tokens" },
  { id: "3.joining", what: "below: 'by Amara Okafor et al.'", record: ND, file: pdf([T, "by Amara Okafor et al."]), want: "MATCH title", clause: "3: joining words" },
  { id: "3.marks", what: "below: affiliation marks glued to names ('Okafor*,', 'Smith†')", record: ND, file: pdf([T, "Amara Okafor*, Ben Smith†"]), want: "MATCH title", clause: "3: glued marks left out" },
  { id: "3.superscript", what: "below: superscript digits glued to names", record: ND, file: { kind: "epub", body: `<p>${T}</p><p>Amara Okafor¹, Ben Smith²</p>` }, want: "MATCH title", clause: "3: glued superscripts left out" },
  { id: "3.lowerCoauthor", what: "below: a co-author of the record written in lower case", record: { ...ND, creators: [...OK, { role: "author", given: "bell", family: "hooks" }] }, file: pdf([T, "Amara Okafor and bell hooks"]), want: "MATCH title", clause: "3: another name of a creator of the record" },
  { id: "3.lowerStranger", what: "below: someone not of the record written in lower case", record: ND, file: pdf([T, "Amara Okafor and bell hooks"]), want: "title-absent", clause: "3: a lower-case word that is no creator's name" },
  // The 30/31-token pair is an EPUB: a PDF line that long runs off the page and is cut by the extraction.
  { id: "3.thirty", what: "below: a line of names of 30 tokens (EPUB)", record: ND, file: { kind: "epub", body: `<p>${T}</p><p>${["Amara", "Okafor", ...Array.from({ length: 28 }, () => "Smith")].join(" ")}</p>` }, want: "MATCH title", clause: "3" },
  { id: "3.thirtyOne", what: "below: a line of names of 31 tokens (EPUB)", record: ND, file: { kind: "epub", body: `<p>${T}</p><p>${["Amara", "Okafor", ...Array.from({ length: 29 }, () => "Smith")].join(" ")}</p>` }, want: "title-absent", clause: "3: more than 30 tokens" },
  { id: "3.metaOnly", what: "the author only in the file's metadata, running text below the block", record: ND, file: pdf([T, F], { author: A }), want: "title-absent", clause: "3: the metadata is not the line below" },
  // Clause 4: nothing unexplained directly above.
  { id: "4.none", what: "above: nothing (the block opens the text)", record: ND, file: pdf([T, A]), want: "MATCH title", clause: "4" },
  { id: "4.digit", what: "above: a line holding a digit", record: ND, file: pdf(["Received 3 March", T, A]), want: "MATCH title", clause: "4" },
  { id: "4.web", what: "above: a web address", record: ND, file: pdf(["www.upland-studies.org", T, A]), want: "MATCH title", clause: "4" },
  { id: "4.email", what: "above: an e-mail address", record: ND, file: pdf(["editor@upland.org", T, A]), want: "MATCH title", clause: "4" },
  { id: "4.container", what: "above: the record's container title", record: WITH_CONTAINER, file: pdf([JOURNAL, T, A]), want: "MATCH title", clause: "4" },
  { id: "4.noContainer", what: "above: the same journal name, the record without a container title", record: ND, file: pdf([JOURNAL, T, A]), want: "other-kind", clause: "4: a four-word line above that is no ordinary label" },
  { id: "4.eight", what: "above: a line of eight words", record: ND, file: pdf(["This short line here has exactly eight words", T, A]), want: "MATCH title", clause: "4" },
  { id: "4.seven", what: "above: a line of seven words", record: ND, file: pdf(["This short line here has seven words", T, A]), want: "other-kind", clause: "4: one to seven words" },
  { id: "4.unknown", what: "above: a short unknown label", record: ND, file: pdf(["Perspective", T, A]), want: "other-kind", clause: "4: a label it does not know" },
  ...ORDINARY_LABELS.map((l): Row => ({ id: `4.label:${l}`, what: `above: the ordinary label '${l}'`, record: ND, file: pdf([l, T, A]), want: "MATCH title", clause: "4: an ordinary article label" })),
  // Clause 5: the added labels of another kind, high in the title zone (above a line the block may have above it).
  { id: "5.none", what: "zone: a cover line, a dated line, the block", record: ND, file: pdf(["Upland Studies 12 (2021)", T, A]), want: "MATCH title", clause: "5" },
  ...ADDED_KIND_LABELS.map((l): Row => ({ id: `5.label:${l}`, what: `zone: '${l}' as a line of its own above a dated line`, record: ND, file: pdf([l, "Upland Studies 12 (2021)", T, A]), want: "other-kind", clause: "5: an added label of another kind" })),
  { id: "5.lineStart", what: "zone: 'Appendix B. Further tables' as a line's beginning", record: ND, file: pdf(["Appendix B. Further tables 2021", T, A]), want: "other-kind", clause: "5: a label as a line's beginning" },
  { id: "5.notStart", what: "zone: 'see the appendix' inside a line", record: ND, file: pdf(["Upland Studies 12 (2021), see the appendix", T, A]), want: "MATCH title", clause: "5: not a line's beginning" },
  { id: "5.after3", what: "zone: 'Index' three lines after the block", record: ND, file: pdf([T, A, "Abstract. Rivers shape memory.", "Index"]), want: "other-kind", clause: "5: within three lines after the block" },
  { id: "5.after4", what: "zone: 'Index' four lines after the block", record: ND, file: pdf([T, A, "Abstract. Rivers shape memory.", "Keywords: rivers, memory.", "Index"]), want: "MATCH title", clause: "5: beyond the title zone" },
  // Clause 6: no other version or part.
  { id: "6.below12", what: "'Second Edition' twelve lines below the block", record: ND, file: pdf([T, A, ...fill(10), "Second Edition"]), want: "other-version", clause: "6: within twelve lines below" },
  { id: "6.below13", what: "'Second Edition' thirteen lines below the block", record: ND, file: pdf([T, A, ...fill(11), "Second Edition"]), want: "MATCH title", clause: "6: beyond twelve lines" },
  { id: "6.above3", what: "'Volume 2' three lines above the block", record: ND, file: pdf(["Volume 2", F, F, T, A]), want: "other-version", clause: "6: within three lines above" },
  { id: "6.above4", what: "'Volume 2' four lines above the block", record: ND, file: pdf(["Volume 2", F, F, F, T, A]), want: "MATCH title", clause: "6: beyond three lines above" },
  { id: "6.chapter3", what: "'Chapter 3' below, no chapter one before it", record: ND, file: pdf([T, A, "Chapter 3", "The Ferry"]), want: "other-version", clause: "6: a heading numbered two or more" },
  { id: "6.chapter1then3", what: "'Chapter 3' below, 'Chapter 1' before it", record: ND, file: pdf([T, A, "Chapter 1", "The Bridge", "Chapter 3", "The Ferry"]), want: "MATCH title", clause: "6: a heading numbered one before it" },
  { id: "6.sectionIV", what: "'Section IV. Methods' below, no section one before it", record: ND, file: pdf([T, A, "Section IV. Methods"]), want: "other-version", clause: "6: a heading numbered two or more" },
  { id: "6.sectionIthenIV", what: "'Section IV. Methods' below, 'Section I. Sources' before it", record: ND, file: pdf([T, A, "Section I. Sources", "Section IV. Methods"]), want: "MATCH title", clause: "6" },
  { id: "6.chapterThree", what: "'Chapter Three: The Ferry' below", record: ND, file: pdf([T, A, "Chapter Three: The Ferry"]), want: "other-version", clause: "6" },
  // Clause 7: no other DOI; a DOI is never evidence.
  { id: "7.own", what: "the record's DOI below the block", record: R, file: pdf([T, A, `doi:${D}`]), want: "MATCH title", clause: "7" },
  { id: "7.other", what: "another DOI below the block", record: R, file: pdf([T, A, "doi:10.5555/ao.f11.other"]), want: "other-doi", clause: "7: another DOI" },
  { id: "7.textNoStructure", what: "the record's DOI in the text, the title in a sentence (no structure)", record: R, file: pdf([`We read ${T} by Amara Okafor (doi:${D}) again.`, F]), want: "title-absent", clause: "7: a DOI is never evidence" },
  { id: "7.metaNoStructure", what: "the record's DOI in the metadata and the text, the title in a sentence (no structure)", record: R, file: { kind: "epub", title: T, creator: A, doi: D, body: `<p>We read ${T} by Amara Okafor again, doi:${D}.</p>` }, want: "title-absent", clause: "7: a DOI is never evidence" },
  // Clause 8: the embedded title is never evidence; it can only speak against a file.
  { id: "8.record", what: "an embedded title that is the record's", record: ND, file: pdf([T, A], { title: T }), want: "MATCH title", clause: "8" },
  { id: "8.twoOther", what: "an embedded title of two content words that is not the record's", record: ND, file: pdf([T, A], { title: "Upland Pastures" }), want: "title-absent", clause: "8: two content words, another title" },
  { id: "8.oneOther", what: "an embedded title of one content word that is not the record's", record: ND, file: pdf([T, A], { title: "Pastures" }), want: "MATCH title", clause: "8: under two content words, ignored" },
  { id: "8.fileName", what: "an embedded title that is a file name", record: ND, file: { kind: "epub", title: "upland pastures final.docx", body: `<p>${T}</p><p>${A}</p>` }, want: "MATCH title", clause: "8: a file name is ignored" },
  { id: "8.subtitle", what: "an embedded title that is the record's title with a subtitle", record: ND, file: pdf([T, A], { title: `${T}: Water and Belonging` }), want: "MATCH title", clause: "8" },
  { id: "8.alone", what: "the embedded title and author are the record's, the text another work", record: ND, file: pdf(["Mountain Pastures and Seasonal Labour", "Carl Other"], { title: T, author: A }), want: "title-absent", clause: "8: the embedded title is never evidence" },
  // Several places: any one place satisfying 2–4 (with 5–6 around it) is enough.
  { id: "P.coverThenPaper", what: "a cover sheet with the title under a short line, then the title again under running text", record: ND, file: pdf(["Upland Repository", T, A, ...fill(2), T, A]), want: "MATCH title", clause: "2–4 at the second place (the first fails 4)" },
  { id: "P.coverOnly", what: "the cover sheet's place alone", record: ND, file: pdf(["Upland Repository", T, A, ...fill(2)]), want: "other-kind", clause: "4" },
];

describe("R292: the reviewers' rows — what the file holds → R292's answer", () => {
  for (const row of ROWS) {
    it(`${row.id}: ${row.what} → ${row.want} (clause ${row.clause})`, async () => {
      expect(await run(row)).toBe(row.want);
    });
  }
});

describe("R292: for each clause, rows that differ only in that clause", () => {
  for (const row of PAIRS) {
    it(`${row.id}: ${row.what} → ${row.want} (clause ${row.clause})`, async () => {
      expect(await run(row)).toBe(row.want);
    });
  }
});
