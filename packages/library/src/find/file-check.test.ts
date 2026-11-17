/**
 * Task F11 (R277 a, rebuilt by R282 a–c, stated in closed form by R292): the file check — a downloaded file against
 * the record it was found for. The app attaches a file by itself only on strong, positive evidence that the file IS
 * the record's work; everything else goes to the researcher. Every file here is made by the tests' own builders (no
 * network). R292 changed some rows' answers: each such row says so, naming the clause ("R292 n: …"); a match is
 * always `by: "title"` now (R292 7: a DOI is never evidence). The reviewers' rows are in file-check.hostile.test.ts.
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
const NO_DOI: FileCheckRecord = { title: RIVERS.title, creators: RIVERS.creators };
const CAPITAL: FileCheckRecord = { title: "Capital", creators: [{ role: "author", given: "Wendel", family: "Brakkenridge" }] };
const CAPITAL_DOI: FileCheckRecord = { ...CAPITAL, doi: "10.5555/ao.f11.capital" };
const T = RIVERS.title;
const A = "Amara Okafor";
const D = RIVERS.doi!;
/** Ordinary text of a first page: no title, no name, no DOI, no label, no number (makes a file's text long enough). */
const BODY = [
  "This study follows how people in hill settlements recall floods, droughts and the",
  "slow changes of watercourses over three generations, drawing on interviews, parish",
  "registers and maps kept by families. It argues that shared stories of water shape",
  "who belongs to a place and who is remembered as having left it behind for good.",
];
/** More ordinary text, to push what follows beyond 600 or 2,000 characters. */
const filler = (k: number) => Array.from({ length: k }, () => "Ordinary words of a page that say nothing about anything in particular here, at all.");

type Want = { match: true; by: "doi" | "title" } | { match: false; why: "no-text" | "other-doi" | "other-kind" | "other-version" | "title-absent" };
type Row = { name: string; rec: FileCheckRecord; file: () => Promise<string>; want: Want };
const M = (by: "doi" | "title"): Want => ({ match: true, by });
const X = (why: "no-text" | "other-doi" | "other-kind" | "other-version" | "title-absent"): Want => ({ match: false, why });

/** The reviewer's table and probes (task-F11-review.md, C1, C2, I4, I5): each must NOT match. */
const MUST_NOT: Row[] = [
  // C1: another kind of document citing the record's DOI on its first page.
  // R292 2: the title only inside a sentence — no block (was other-kind).
  { name: "a reply citing the record's DOI", rec: RIVERS, want: X("other-kind") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ lines: ["Journal of Upland Studies", "A reply to Okafor", "Carl Young", `In ${T} (doi:${D}), Amara Okafor argues that`, ...BODY] }) },
  // R292 2: "Comment on" on the title's line — no block (was other-kind).
  { name: "a comment citing the record's DOI", rec: RIVERS, want: X("other-kind") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ lines: [`Comment on ${T}`, "Carl Young", `doi:${D}`, `Amara Okafor argues that`, ...BODY] }) },
  // R292 2: "Correction to" on the title's line — no block (was other-kind).
  { name: "a correction citing the record's DOI", rec: RIVERS, want: X("other-kind") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ lines: [`Correction to: ${T}`, A, `The original article can be found online at https://doi.org/${D}`, ...BODY] }) },
  { name: "an erratum (a header line) with the record's title, author and DOI", rec: RIVERS, want: X("other-kind"), file: () => pdf({ lines: ["Erratum", T, A, `doi:${D}`, ...BODY] }) },
  // R292 2: "Retraction Note" on the title's line — no block (was other-kind).
  { name: "a retraction note citing the record's DOI", rec: RIVERS, want: X("other-kind") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ lines: [`Retraction Note: ${T}`, A, `doi:${D}`, ...BODY] }) },
  { name: "supplementary material citing the record's DOI", rec: RIVERS, want: X("other-kind"), file: () => pdf({ lines: ["Supplementary material for", T, A, `https://doi.org/${D}`, ...BODY] }) },
  // R292 2: the title only inside a citation — no block (was other-kind).
  { name: "a book review citing the record's DOI", rec: RIVERS, want: X("other-kind") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ lines: ["Book Review", `Okafor, Amara. ${T}.`, `Upland Press. doi:${D}`, "Reviewed by Carl Young", ...BODY] }) },
  // C2: "Capital" volume II.
  // R292 3: "Volume II" directly below the block is not a line of names (was other-version).
  { name: "'Capital' with 'Volume II' on the line after", rec: CAPITAL, want: X("other-version") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ title: "Capital", author: "Wendel Brakkenridge", lines: ["CAPITAL", "Volume II", "Wendel Brakkenridge", ...BODY] }) },
  // R292 3: the subtitle directly below the block is not a line of names (was other-version).
  { name: "'Capital' with 'Volume II' two lines after, below a subtitle", rec: CAPITAL, want: X("other-version") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ title: "Capital", author: "Wendel Brakkenridge", lines: ["CAPITAL", "A Critique of Political Economy", "Volume II", "Wendel Brakkenridge", ...BODY] }) },
  // R292 2: no line holds the title's content words exactly — no block (was other-version).
  { name: "'Capital': the word first in a sentence, 'CAPITAL Volume II' later", rec: CAPITAL, want: X("other-version") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ title: "Capital", author: "Wendel Brakkenridge", lines: ["capital accumulates in the hands of a few, as every reader of this book knows.", ...BODY, "CAPITAL Volume II"] }) },
  // C2: book reviews and comments by title.
  { name: "a book review whose embedded title is the reviewed book's ('BOOK REVIEWS' above the title)", rec: NO_DOI, want: X("other-kind"), file: () => pdf({ title: T, author: A, lines: ["BOOK REVIEWS", T, "By Amara Okafor. Upland Press.", "Reviewed by Carl Young", ...BODY] }) },
  { name: "the same review without an embedded title", rec: NO_DOI, want: X("other-kind"), file: () => pdf({ lines: ["BOOK REVIEWS", T, "By Amara Okafor. Upland Press.", "Carl Young", ...BODY] }) },
  { name: "'Reviewed Work:' then the title by the author", rec: NO_DOI, want: X("other-kind"), file: () => pdf({ title: T, author: A, lines: ["Reviewed Work:", T, "by Amara Okafor", ...BODY] }) },
  { name: "'Erratum' as a header line above the title (no DOI)", rec: NO_DOI, want: X("other-kind"), file: () => pdf({ lines: ["Erratum", T, A, ...BODY] }) },
  // R292 2: the title only inside a sentence — no block (was other-kind).
  { name: "a comment ('Comment' as a lone line) citing the record by title only", rec: RIVERS, want: X("other-kind") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ lines: ["Comment", "Carl Young", `In her ${T}, Amara Okafor argues that`, ...BODY] }) },
  // R292 2: "Correction to" on the title's line — no block (was other-kind).
  { name: "'Correction to: <title>' with the author, no DOI", rec: NO_DOI, want: X("other-kind") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ lines: [`Correction to: ${T}`, A, ...BODY] }) },
  { name: "another paper with the record in a page-1 reference list", rec: NO_DOI, want: X("title-absent"), file: () => pdf({ lines: ["Mountain Pastures and Seasonal Work", "Carl Young", ...BODY, "References", `Okafor, A. (2020) ${T}. Upland Press.`] }) },
  // R292 2: "Notes on" on the title's line — no block (was other-kind).
  { name: "another author's 'Notes on <title>' (the record's author's name read from 'Young people'; R284: 'notes on' before the title is a sign)", rec: { title: T, creators: [{ role: "author", given: "Ada", family: "Young" }] }, want: X("other-kind") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ lines: [`Notes on ${T}`, "Carl Other", "Young people in the hills tell it differently.", ...BODY] }) },
  // Version marks beside the title.
  // R292 3: "Part II" directly below the block is not a line of names holding the family name (was other-version).
  { name: "'Part II' on the line after the title", rec: NO_DOI, want: X("other-version") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ lines: [T, "Part II", A, ...BODY] }) },
  // R292 3: "2nd edition" directly below the block is not a line of names (was other-version).
  { name: "'2nd edition' on the line after the title", rec: NO_DOI, want: X("other-version") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ lines: [T, "2nd edition", A, ...BODY] }) },
  // R292 3: the subtitle directly below the block is not a line of names (was other-version).
  { name: "'Volume 2' two lines below the title, under a subtitle", rec: NO_DOI, want: X("other-version") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ lines: [T, "Essays on the North", "Volume 2", A, ...BODY] }) },
  // I4: no text.
  { name: "no text, with the right embedded title and author ('Capital')", rec: CAPITAL, want: X("no-text"), file: () => pdf({ title: "Capital", author: "Wendel Brakkenridge" }) },
  { name: "no text, with the right embedded title and author (a record with a DOI)", rec: RIVERS, want: X("no-text"), file: () => pdf({ title: T, author: A }) },
  { name: "text under 200 characters, even the title and author", rec: NO_DOI, want: X("no-text"), file: () => pdf({ title: T, author: A, lines: [T, A, "A short page."] }) },
  // I5: the record's title is the beginning of a longer title.
  { name: "a longer title that begins with the record's title", rec: NO_DOI, want: X("title-absent"), file: () => pdf({ lines: [`${T} of the North: A Sequel`, A, ...BODY] }) },
  { name: "'Rivers, Memory and Upland' against a longer title", rec: { title: "Rivers, Memory and Upland", creators: RIVERS.creators }, want: X("title-absent"), file: () => pdf({ lines: ["Rivers, Memory and Upland Farming Cooperatives in Twentieth-Century Wales", A, ...BODY] }) },
  // DOIs.
  { name: "a DOI of which the record's DOI is a prefix", rec: RIVERS, want: X("other-doi"), file: () => pdf({ lines: [T, A, `doi:${D}2`, ...BODY] }) },
  { name: "a DOI that is a prefix of the record's DOI", rec: RIVERS, want: X("other-doi"), file: () => pdf({ lines: [T, A, "doi:10.5555/ao.f11.river", ...BODY] }) },
  { name: "a DOI broken across a line that, joined, is another DOI", rec: RIVERS, want: X("other-doi"), file: () => pdf({ lines: [T, A, "doi:10.5555/ao.f11.", "rivers2", ...BODY] }) },
  { name: "the record's DOI in another case, alone (the DOI alone never matches)", rec: RIVERS, want: X("title-absent"), file: () => pdf({ lines: ["Journal of Upland Studies", "doi:10.5555/AO.F11.RIVERS", ...BODY] }) },
  { name: "the record's DOI alone on the first page", rec: RIVERS, want: X("title-absent"), file: () => pdf({ lines: ["Journal of Upland Studies 12 (2021)", "A study of something", `https://doi.org/${D}`, ...BODY] }) },
  { name: "a DOI with a query read into it", rec: RIVERS, want: X("other-doi"), file: () => pdf({ lines: [T, A, `https://doi.org/${D}?utm=1`, ...BODY] }) },
  { name: "another DOI labelled before the record's", rec: RIVERS, want: X("other-doi"), file: () => pdf({ title: T, author: A, lines: ["doi:10.5555/ao.f11.someone-else", T, A, `See also doi:${D} for the companion piece.`, ...BODY] }) },
  { name: "the record's DOI cited, then another as 'ours', no title", rec: RIVERS, want: X("title-absent"), file: () => pdf({ lines: [`Cites doi:${D}`, "Our doi:10.5555/ao.f11.other", ...BODY] }) },
  { name: "an EPUB whose metadata DOI is another, whatever the text says", rec: RIVERS, want: X("other-doi"), file: () => epub({ title: T, creator: A, doi: "10.5555/ao.f11.other", body: `<p>${T}</p><p>${A}</p><p>doi:${D}</p>${BODY.map((l) => `<p>${l}</p>`).join("")}` }) },
  { name: "an EPUB whose metadata DOI is the record's, its content another work", rec: RIVERS, want: X("title-absent"), file: () => epub({ title: "Something else entirely", doi: D, body: `<p>Mountain Pastures</p><p>Carl Young</p>${BODY.map((l) => `<p>${l}</p>`).join("")}` }) },
  // Embedded titles alone.
  { name: "an embedded title 'State' with its author, for the record 'The State', the text without it", rec: { title: "The State", creators: CAPITAL.creators }, want: X("title-absent"), file: () => pdf({ title: "State", author: "Wendel Brakkenridge", lines: BODY }) },
  { name: "the right embedded title and author, the text not holding the title", rec: NO_DOI, want: X("title-absent"), file: () => pdf({ title: T, author: A, lines: BODY }) },
  { name: "an embedded title 'Capital, Volume 2'", rec: CAPITAL, want: X("other-version"), file: () => pdf({ title: "Capital, Volume 2", author: "Wendel Brakkenridge", lines: ["CAPITAL", "Wendel Brakkenridge", ...BODY] }) },
  { name: "an embedded title '<title> (review)'", rec: NO_DOI, want: X("other-kind"), file: () => pdf({ title: `${T} (book review)`, author: A, lines: [T, A, ...BODY] }) },
  { name: "the title's words scattered over the page", rec: NO_DOI, want: X("title-absent"), file: () => pdf({ lines: ["Rivers are long.", "Many lines of other words come here to keep them apart from each other.", "Memory fails.", "More words, many of them, unrelated to anything.", "Upland walks.", "Yet more text that has nothing to do with it at all.", "Villages grow.", A, ...BODY] }) },
  { name: "the title as a block without the author's name", rec: NO_DOI, want: X("title-absent"), file: () => pdf({ lines: [T, "Someone Different", ...BODY] }) },
  // Rows of my own (what the rule made me doubt).
  // R292 4: "Mountain Pastures:" is a two-word line directly above the block (was title-absent by the colon rule, gone).
  { name: "[own] the record's title as the subtitle of another title (the line before ends with a colon)", rec: NO_DOI, want: X("other-kind"), file: () => pdf({ lines: ["Mountain Pastures:", T, A, ...BODY] }) },
  { name: "[own] the title going on, in lower case, on the next line", rec: NO_DOI, want: X("title-absent"), file: () => pdf({ lines: [T, "of the North and the South", A, ...BODY] }) },
  // R292 4 before 6: "VOLUME II" is a two-word line directly above the block; other-kind comes before other-version (was other-version).
  { name: "[own] 'Volume II' alone on the line above the title", rec: CAPITAL, want: X("other-kind"), file: () => pdf({ lines: ["VOLUME II", "CAPITAL", "Wendel Brakkenridge", ...BODY] }) },
  { name: "[own] the author more than 600 characters after the title, no author metadata", rec: NO_DOI, want: X("title-absent"), file: () => pdf({ lines: [T, ...filler(9), A, ...BODY] }) },
  { name: "[own] the title only beyond the first 2,000 characters", rec: NO_DOI, want: X("title-absent"), file: () => pdf({ lines: [...filler(26), T, A] }) },
  { name: "[own] 'Retracted' in the embedded title", rec: NO_DOI, want: X("other-kind"), file: () => pdf({ title: `RETRACTED: ${T}`, author: A, lines: [T, A, ...BODY] }) },
  // Round 2 (R284): labels count only before the record's title or author; a version is a short line; the DOI path's
  // title begins within 800 characters; an embedded title of another document.
  { name: "R284: 'Review of <title>' on the line above the title", rec: RIVERS, want: X("other-kind"), file: () => pdf({ lines: ["Review of", T, "Amara Okafor, Upland Press", "Carl Young", `doi:${D}`, ...BODY] }) },
  { name: "R284: 'Reply to <family name>'", rec: RIVERS, want: X("other-kind"), file: () => pdf({ lines: ["Reply to Okafor", T, A, `doi:${D}`, ...BODY] }) },
  // R292 3: "Carl Young" below the block does not hold the family name (was other-kind).
  { name: "R284: 'Notes on <title>' with the record's embedded title", rec: NO_DOI, want: X("other-kind") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ title: T, author: A, lines: ["Notes on", T, "Carl Young", ...BODY] }) },
  { name: "R284: 'Capital' with 'Volume II' as a short line", rec: CAPITAL_DOI, want: X("other-version"), file: () => pdf({ lines: ["CAPITAL", "Wendel Brakkenridge", "Volume II", `doi:${CAPITAL_DOI.doi}`, ...BODY] }) },
  { name: "R284: 'Second edition' as a short line", rec: RIVERS, want: X("other-version"), file: () => pdf({ lines: [T, A, "Second edition", `doi:${D}`, ...BODY] }) },
  // R292 3: "Revised edition" directly below the block is not a line of names (was other-version).
  { name: "R284: 'Revised edition' as a short line", rec: NO_DOI, want: X("other-version") /* R293 e: no place, the sign in the first 1,000 characters gives the reason (R292 had title-absent) */, file: () => pdf({ lines: [T, "Revised edition", A, ...BODY] }) },
  { name: "R284: 'Editorial' as a line of its own", rec: RIVERS, want: X("other-kind"), file: () => pdf({ lines: ["Editorial", T, A, `doi:${D}`, ...BODY] }) },
  { name: "R284: another paper citing the record, with its labelled DOI, at about character 1,500", rec: RIVERS, want: X("title-absent"), file: () => pdf({ lines: ["Mountain Pastures and Seasonal Work", "Carl Young", ...BODY, ...filler(13), `As ${A} showed in ${T} (doi:${D}), memory follows water.`] }) },
  { name: "R284: a citing paper with its own embedded title, the record's DOI and title on page 1", rec: RIVERS, want: X("title-absent"), file: () => pdf({ title: "Mountain Pastures and Seasonal Work", author: "Carl Young", lines: ["Mountain Pastures and Seasonal Work", "Carl Young", `This paper extends ${T} by ${A} (doi:${D}) to the high pastures.`, ...BODY] }) },
  { name: "R284: an embedded title that is longer than the record's, with no subtitle mark", rec: NO_DOI, want: X("title-absent"), file: () => pdf({ title: `${T} of the North`, author: A, lines: [T, A, ...BODY] }) },
];

/** The cases that MUST match. */
const MUST: Row[] = [
  // R292 4: "Journal of Upland Studies" directly above is a four-word line, and this record names no container (was a match by DOI). With the container: the next row.
  { name: "the work itself: its DOI labelled on the first page, its title and its author", rec: RIVERS, want: X("other-kind"), file: () => pdf({ lines: ["Journal of Upland Studies", T, A, `https://doi.org/${D}`, ...BODY] }) },
  // R292 4: as the row above (was a match).
  { name: "no DOI in the file: the title as a block of one line, the author below", rec: RIVERS, want: X("other-kind"), file: () => pdf({ lines: ["Journal of Upland Studies", T, A, ...BODY] }) },
  { name: "the title as a block of two lines", rec: RIVERS, want: M("title"), file: () => pdf({ lines: ["Rivers and Memory", "in Upland Villages", A, ...BODY] }) },
  { name: "the title as a block of three lines", rec: RIVERS, want: M("title"), file: () => pdf({ lines: ["Rivers and", "Memory in Upland", "Villages", A, ...BODY] }) },
  { name: "the title hyphenated across a line", rec: NO_DOI, want: M("title"), file: () => pdf({ lines: ["Rivers and Memory in Up-", "land Villages", A, ...BODY] }) },
  { name: "a record with no DOI", rec: NO_DOI, want: M("title"), file: () => pdf({ title: T, author: A, lines: [T, A, ...BODY] }) },
  { name: "a record titled 'A Reply to My Critics' whose file says so", rec: { title: "A Reply to My Critics", creators: RIVERS.creators }, want: M("title"), file: () => pdf({ lines: ["A Reply to My Critics", A, ...BODY] }) },
  // R292 4: the journal's name directly above, the record naming no container (was a match by DOI). With the container: below.
  { name: "a paper in 'American Sociological Review' (the journal's name is not a sign)", rec: RIVERS, want: X("other-kind"), file: () => pdf({ lines: ["American Sociological Review", T, A, `doi:${D}`, ...BODY] }) },
  { name: "a short title ('Capital') with its DOI, title and author", rec: CAPITAL_DOI, want: M("title") /* R292 7: a DOI is never evidence (was by "doi") */, file: () => pdf({ lines: ["CAPITAL", "Wendel Brakkenridge", `doi:${CAPITAL_DOI.doi}`, ...BODY] }) },
  { name: "a two-word title as a block with the author", rec: { title: "Upland Memory", creators: RIVERS.creators }, want: M("title"), file: () => pdf({ lines: ["Upland Memory", A, ...BODY] }) },
  { name: "the record's DOI in another case, with its title and author", rec: RIVERS, want: M("title") /* R292 7: a DOI is never evidence (was by "doi") */, file: () => pdf({ lines: [T, A, "DOI 10.5555/AO.F11.RIVERS", ...BODY] }) },
  { name: "the record's DOI with a trailing full stop", rec: RIVERS, want: M("title") /* R292 7: a DOI is never evidence (was by "doi") */, file: () => pdf({ lines: [T, A, `Cite as doi:${D}.`, ...BODY] }) },
  { name: "a volume number the record's title holds", rec: { title: "Collected Letters, Volume 2", creators: RIVERS.creators }, want: M("title"), file: () => pdf({ title: "Collected Letters, Volume 2", author: A, lines: ["Collected Letters, Volume 2", A, ...BODY] }) },
  { name: "an EPUB whose title and creator are the record's, its text the title and author", rec: NO_DOI, want: M("title"), file: () => epub({ title: T, creator: A, body: `<h1>${T}</h1><p>${A}</p>${BODY.map((l) => `<p>${l}</p>`).join("")}` }) },
  // Rows of my own.
  { name: "[own] the record's DOI broken across a line, with its title and author", rec: RIVERS, want: M("title") /* R292 7: a DOI is never evidence (was by "doi") */, file: () => pdf({ lines: [T, A, "doi:10.5555/ao.f11.", "rivers", ...BODY] }) },
  { name: "[own] the record's DOI first, a reference's DOI after it", rec: RIVERS, want: M("title") /* R292 7: a DOI is never evidence (was by "doi") */, file: () => pdf({ lines: [T, A, `doi:${D}`, "See also doi:10.5555/ao.f11.someone-else", ...BODY] }) },
  { name: "[own] a journal header with 'Vol. 12, No. 3' above the title (not a version of the work)", rec: RIVERS, want: M("title") /* R292 7: a DOI is never evidence (was by "doi") */, file: () => pdf({ lines: ["Journal of Upland Studies, Vol. 12, No. 3", T, A, `doi:${D}`, ...BODY] }) },
  { name: "[own] a title with its subtitle as a two-line block", rec: { title: "Rivers and Memory: Upland Villages", creators: RIVERS.creators }, want: M("title"), file: () => pdf({ lines: ["Rivers and Memory:", "Upland Villages", A, ...BODY] }) },
  // R292 3: the author must stand on the line directly below the block; the metadata is not evidence (was a match).
  { name: "[own] the author only in the file's author metadata", rec: NO_DOI, want: X("title-absent"), file: () => pdf({ author: A, lines: [T, ...BODY] }) },
  // R292 2: no missing word, with a DOI or without (was a match by DOI: the 90% rule is gone).
  { name: "[own] 9 of 10 title words in order, with the record's DOI and the author", rec: { title: "Rivers Memory Upland Villages Floods Droughts Parishes Registers Maps Families", creators: RIVERS.creators, doi: D }, want: X("title-absent"), file: () => pdf({ lines: ["Rivers Memory Upland Villages Floods Droughts Parishes Registers Families", A, `doi:${D}`, ...BODY] }) },
  // R292 2 and 8: no block; the embedded title is never evidence (was a match).
  { name: "[own] an embedded title that is exactly the record's, the title in a sentence of the text, the author after it", rec: NO_DOI, want: X("title-absent"), file: () => pdf({ title: T, lines: [`This is ${T} by Amara Okafor, a study.`, ...BODY] }) },
  // R292 4: the journal's name directly above, the record naming no container (was a match by DOI). With the container: below.
  { name: "R284: a paper whose first page names the journal 'Review of Economic Studies'", rec: RIVERS, want: X("other-kind"), file: () => pdf({ lines: ["The Review of Economic Studies", T, A, `doi:${D}`, ...BODY] }) },
  // R292 4: "Editorial Board: see the journal's site" is a six-word line directly above the block (was a match by DOI).
  { name: "R284: a first page with an 'Editorial Board' line", rec: RIVERS, want: X("other-kind"), file: () => pdf({ lines: ["Editorial Board: see the journal's site", T, A, `doi:${D}`, ...BODY] }) },
  // R292 3: the citation line directly below the block (numbers, "pp.") is not a line of names (was a match by DOI).
  { name: "R284: 'Vol. 12, No. 3, pp. 1–20' under the title", rec: RIVERS, want: X("title-absent"), file: () => pdf({ lines: [T, "Vol. 12, No. 3, pp. 1–20", A, `doi:${D}`, ...BODY] }) },
  { name: "R284: a long journal header before the title, the title still within 800 characters", rec: RIVERS, want: M("title") /* R292 7: a DOI is never evidence (was by "doi") */, file: () => pdf({ lines: ["Journal of Upland Studies, published by the Society for Upland Studies, Upland Press", ...filler(5), T, A, `doi:${D}`, ...BODY] }) },
  { name: "R284: the work with a junk embedded title 'Microsoft Word - final_v3.doc' (EPUB)", rec: RIVERS, want: M("title") /* R292 7: a DOI is never evidence (was by "doi") */, file: () => epub({ title: "Microsoft Word - final_v3.doc", creator: A, body: `<h1>${T}</h1><p>${A}</p><p>doi:${D}</p>${BODY.map((l) => `<p>${l}</p>`).join("")}` }) },
  { name: "R284: the work with a junk embedded title 'untitled' (PDF)", rec: RIVERS, want: M("title") /* R292 7: a DOI is never evidence (was by "doi") */, file: () => pdf({ title: "untitled", lines: [T, A, `doi:${D}`, ...BODY] }) },
  { name: "R284: the work with an embedded title that is a file name ('… final draft.pdf', EPUB), no DOI", rec: NO_DOI, want: M("title"), file: () => epub({ title: "okafor chapter three final draft.pdf", creator: A, body: `<h1>${T}</h1><p>${A}</p>${BODY.map((l) => `<p>${l}</p>`).join("")}` }) },
  { name: "R284: an embedded title that is the record's title and a subtitle", rec: NO_DOI, want: M("title"), file: () => pdf({ title: `${T}: Water and Belonging`, author: A, lines: [T, A, ...BODY] }) },
  { name: "R284: an embedded title that is the record's main title (the record's title holds a subtitle)", rec: { title: `${T}: Water and Belonging`, creators: RIVERS.creators }, want: M("title"), file: () => pdf({ title: T, author: A, lines: [`${T}:`, "Water and Belonging", A, ...BODY] }) },
  { name: "[own] the record's DOI in an EPUB's metadata, its title and author in the text", rec: RIVERS, want: M("title") /* R292 7: a DOI is never evidence (was by "doi") */, file: () => epub({ title: T, creator: A, doi: D, body: `<h1>${T}</h1><p>${A}</p>${BODY.map((l) => `<p>${l}</p>`).join("")}` }) },
  // R292 4: the journal's name directly above the block is allowed when it is the record's container title.
  { name: "R292: the work itself under the journal's name, the record naming that journal as its container", rec: { ...RIVERS, container: "Journal of Upland Studies" }, want: M("title"), file: () => pdf({ lines: ["Journal of Upland Studies", T, A, `https://doi.org/${D}`, ...BODY] }) },
  { name: "R292: 'American Sociological Review' above, the record's container", rec: { ...RIVERS, container: "American Sociological Review" }, want: M("title"), file: () => pdf({ lines: ["American Sociological Review", T, A, `doi:${D}`, ...BODY] }) },
  { name: "R292: 'The Review of Economic Studies' above, the record's container 'Review of Economic Studies'", rec: { ...RIVERS, container: "Review of Economic Studies" }, want: M("title"), file: () => pdf({ lines: ["The Review of Economic Studies", T, A, `doi:${D}`, ...BODY] }) },
];

describe("the file check's table (R282, R284, R292): what the file holds → match or the reason", () => {
  it.each(MUST_NOT.map((r) => [r.name, r] as const))("must not match: %s", async (_name, row) => {
    const r = await checkFileAgainstRecord(await row.file(), row.rec);
    expect({ match: r.match, ...(r.match ? {} : { why: r.why }) }).toEqual(row.want);
  });
  it.each(MUST.map((r) => [r.name, r] as const))("right files (a match unless R292 says otherwise in the row): %s", async (_name, row) => {
    const r = await checkFileAgainstRecord(await row.file(), row.rec);
    expect({ match: r.match, ...(r.match ? { by: r.by } : { why: r.why }) }).toEqual(row.want);
  });
});

/**
 * R410 b (the review's I2): the file check reads the embedded title as it was found, not the import's filtered one, so a
 * downloaded file whose embedded title says it is a journal's front matter, index or table of contents (the record's
 * title and author on its first page, as such a file lists its articles) is another kind of document, not a match.
 */
describe("the embedded title as found is a sign of another kind of document (R410 b)", () => {
  it.each(["Front Matter", "Index", "Back Matter", "Table of Contents", "Contents"])("embedded title %j → other-kind", async (title) => {
    const r = await checkFileAgainstRecord(await pdf({ title, lines: [T, A, ...BODY] }), NO_DOI);
    expect({ match: r.match, ...(r.match ? {} : { why: r.why }) }).toEqual({ match: false, why: "other-kind" });
    expect(r.evidence.embeddedTitle).toBe(title);
  });
  it("an EPUB whose OPF title is 'Front Matter' → other-kind", async () => {
    const r = await checkFileAgainstRecord(await epub({ title: "Front Matter", creator: A, body: `<h1>${T}</h1><p>${A}</p>${BODY.map((l) => `<p>${l}</p>`).join("")}` }), NO_DOI);
    expect({ match: r.match, ...(r.match ? {} : { why: r.why }) }).toEqual({ match: false, why: "other-kind" });
  });
});

/**
 * R422: the rule for another document's title (clause 8) reads the import's FILTERED embedded title, so a string that is
 * no title (a production code, "Original Article") is not another document's title and the file is judged by its text,
 * as a file with no embedded title is; the kind and version signs and the evidence shown read the title as found.
 */
describe("another document's title reads the filtered embedded title (R422)", () => {
  const why = (r: Awaited<ReturnType<typeof checkFileAgainstRecord>>) => ({ match: r.match, ...(r.match ? { by: r.by } : { why: r.why }) });
  it("with no embedded title, the record's title and author on page 1 → a match (the baseline)", async () => {
    expect(why(await checkFileAgainstRecord(await pdf({ lines: [T, A, ...BODY] }), NO_DOI))).toEqual({ match: true, by: "title" });
  });
  it.each(["S0003598X20000800jra 900..915", "Original Article"])("embedded title %j → a match, as with no embedded title; the evidence shows it as found", async (title) => {
    const r = await checkFileAgainstRecord(await pdf({ title, lines: [T, A, ...BODY] }), NO_DOI);
    expect(why(r)).toEqual({ match: true, by: "title" });
    expect(r.evidence.embeddedTitle).toBe(title);
  });
  it("an embedded real title of another work is still another document's", async () => {
    const rec: FileCheckRecord = { title: "Rivers of the Central Plains", creators: RIVERS.creators };
    const r = await checkFileAgainstRecord(await pdf({ title: "A History of Modern India", lines: [rec.title, A, ...BODY] }), rec);
    expect(why(r)).toEqual({ match: false, why: "title-absent" });
    // Without it, the same file matches: the embedded title is what refuses it.
    expect(why(await checkFileAgainstRecord(await pdf({ lines: [rec.title, A, ...BODY] }), rec))).toEqual({ match: true, by: "title" });
  });
});

/**
 * R425 a (the second review's M4): the kind and version signs read EVERY embedded title the file carries. A PDF's XMP
 * title "untitled" does not hide an Info title "Front Matter".
 */
describe("every embedded title as found is read for the kind and version signs (R425 a)", () => {
  /** A PDF with an XMP dc:title and an Info Title, the given lines on page 1. */
  async function pdfXmp(o: { xmpTitle: string; info: string; lines: string[] }): Promise<string> {
    const { PDFDocument, PDFName, StandardFonts } = await import("pdf-lib");
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle(o.info);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    o.lines.forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 22, size: 11, font }));
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${o.xmpTitle}</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>`;
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(doc.context.stream(Buffer.from(xmp, "utf8"), { Type: "Metadata", Subtype: "XML" })));
    const p = join(tmp, `x${++n}.pdf`);
    await writeFile(p, Buffer.from(await doc.save({ useObjectStreams: false })));
    return p;
  }
  const why = (r: Awaited<ReturnType<typeof checkFileAgainstRecord>>) => ({ match: r.match, ...(r.match ? { by: r.by } : { why: r.why }) });
  it("XMP 'untitled' and Info 'Front Matter' → other-kind; the evidence shows the first title as found", async () => {
    const r = await checkFileAgainstRecord(await pdfXmp({ xmpTitle: "untitled", info: "Front Matter", lines: [T, A, ...BODY] }), NO_DOI);
    expect(why(r)).toEqual({ match: false, why: "other-kind" });
    expect(r.evidence.embeddedTitle).toBe("untitled");
  });
  it("XMP 'Front Matter' and Info a real title → other-kind", async () => {
    const r = await checkFileAgainstRecord(await pdfXmp({ xmpTitle: "Front Matter", info: T, lines: [T, A, ...BODY] }), NO_DOI);
    expect(why(r)).toEqual({ match: false, why: "other-kind" });
  });
  it("a right download with XMP junk and Info junk still matches by its text", async () => {
    const r = await checkFileAgainstRecord(await pdfXmp({ xmpTitle: "untitled", info: "S0003598X20000800jra 900..915", lines: [T, A, ...BODY] }), NO_DOI);
    expect(why(r)).toEqual({ match: true, by: "title" });
  });
  it("Info 'Capital, Volume 2' behind an XMP 'untitled' is a sign of another version", async () => {
    const r = await checkFileAgainstRecord(await pdfXmp({ xmpTitle: "untitled", info: "Capital, Volume 2", lines: ["CAPITAL", "Wendel Brakkenridge", ...BODY] }), CAPITAL);
    expect(why(r)).toEqual({ match: false, why: "other-version" });
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

  it("names the DOI the file presents that is not the record's; only the first 2,000 characters are looked at", async () => {
    const p = await pdf({ lines: ["doi:10.5555/ao.f11.someone-else", T, A, ...BODY] });
    const r = await checkFileAgainstRecord(p, RIVERS);
    expect(r).toMatchObject({ match: false, why: "other-doi" });
    expect(r.evidence.fileDoi).toBe("10.5555/ao.f11.someone-else");
    expect(FILE_CHECK_TEXT_CHARS).toBe(2000);
  });
});
