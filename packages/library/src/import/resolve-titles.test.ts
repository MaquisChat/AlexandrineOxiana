/**
 * R394 (a, c) through resolveItem: an embedded title that does not look like a title is neither the item's title, nor
 * evidence, nor a conflict; an embedded title that is only a part of the reference manager's title agrees with it; an
 * embedded title of another work stays a conflict. No lookups (lookup: null), nothing reaches the network.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { primary, type SourceDraft } from "@ao/core";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { shutdownExtractors } from "../extract/index.js";
import { AUTO_ACCEPT_THRESHOLD, resolveItem } from "./resolve.js";

const ZOTERO_TITLE = "Subsistence and persistence: agriculture in the Central Plains of China through the Neolithic to Bronze Age transition";
const ctx = { projectId: "p", patterns: [], lookup: null };

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-r394-"));
});
afterAll(async () => {
  await shutdownExtractors();
  await rm(tmp, { recursive: true, force: true });
});

async function pdf(name: string, o: { title?: string; author?: string }): Promise<string> {
  const p = join(tmp, name);
  await writeFile(p, await buildPdf({ ...o, lines: ["Antiquity 94 (2020)", "Some text on the first page of the article."] }));
  return p;
}

const zotero = (title = ZOTERO_TITLE): Partial<SourceDraft> => ({
  type: "article-journal",
  title: { variants: [{ lang: "en", kind: "original", value: title }] },
  creators: [{ family: "Lopez", given: "Maria", role: "author" }],
  issued: "2020",
  container: { variants: [{ lang: "en", kind: "original", value: "Antiquity" }] },
});

async function withZotero(embedded: string, reference = ZOTERO_TITLE) {
  const path = await pdf(`${Math.random().toString(36).slice(2)}.pdf`, { title: embedded });
  return resolveItem({ path, mime: "application/pdf", referenceMetadata: zotero(reference), referenceSource: { kind: "zotero" } }, ctx);
}

type Resolved = Awaited<ReturnType<typeof resolveItem>>;
const titleEvidence = (r: Resolved) => r.fieldEvidence.filter((e) => e.field === "/title");

function expectAgrees(r: Resolved, reference = ZOTERO_TITLE) {
  expect(primary(r.draft.title)).toBe(reference);
  expect(r.titleConflict).toBe(false);
  expect(r.verification.fields["/title"]?.status).not.toBe("conflict");
  expect(r.verification.overall).not.toBe("needs-review");
  expect(r.confidence).toBeGreaterThanOrEqual(AUTO_ACCEPT_THRESHOLD);
}

describe("R394 with a Zotero record", () => {
  it("the owner's case: a production code as the embedded title is no conflict; the title is Zotero's and nothing sends it to review", async () => {
    const r = await withZotero("S0003598X20000800jra 900..915");
    expect(primary(r.draft.title)).toBe(ZOTERO_TITLE);
    expect(r.titleConflict).toBe(false);
    expect(r.verification.fields["/title"]?.status).not.toBe("conflict");
    expect(r.verification.overall).not.toBe("needs-review");
    expect(r.confidence).toBeGreaterThanOrEqual(AUTO_ACCEPT_THRESHOLD);
    // Not evidence, and nothing mentions it.
    expect(titleEvidence(r).map((e) => e.source.kind)).toEqual(["zotero"]);
    expect(JSON.stringify(r)).not.toContain("S0003598X20000800jra");
  });

  /** R410 a: each way of agreeing has its own example, which agrees through that way only. */
  it("equal after folding case, accents, punctuation and white space: agrees, and is recorded as corroborating the title", async () => {
    const r = await withZotero("SUBSISTENCE AND PERSISTENCE — Agriculture in the Céntral Plains of China through the Neolithic to Bronze Age Transition.");
    expectAgrees(r);
    expect(titleEvidence(r).map((e) => e.source.kind).sort()).toEqual(["embedded", "zotero"]);
  });

  it("a similarity at or above the import's threshold (0.9), not equal: agrees, and is recorded (before the record-lacks-its-subtitle way, which would not record it)", async () => {
    // Similarity 0.94: the reference title with a short subtitle of its own.
    const r = await withZotero(`${ZOTERO_TITLE}: A Study`);
    expectAgrees(r);
    expect(titleEvidence(r).map((e) => e.source.kind).sort()).toEqual(["embedded", "zotero"]);
  });

  it.each([
    // The prefix ends at a word and the reference continues with its subtitle (": "): two real words only, so only this way agrees.
    ["the title without its subtitle (':')", ZOTERO_TITLE, "Subsistence and persistence"],
    ["the title without its subtitle (' - ')", "Rivers of Memory - Upland Villages in the Andes", "Rivers of Memory"],
    ["the title without its subtitle ('?')", "Markets Fail? Credit in Upland Villages", "Markets Fail"],
    // A run of whole words inside the reference title, with three or more words that are not small words.
    ["a running head (three real words inside the title)", ZOTERO_TITLE, "Agriculture in the Central Plains of China"],
    ["a title cut off by a length limit (at a word)", ZOTERO_TITLE, "Subsistence and persistence: agriculture in the Central Plains of China"],
    // The record lacks the subtitle the file's title carries.
    ["the record lacking the subtitle", "Subsistence and persistence", ZOTERO_TITLE],
  ])("an embedded title that is %s agrees; it is not recorded (R406 a)", async (_what, reference, embedded) => {
    const r = await withZotero(embedded, reference);
    expectAgrees(r, reference);
    expect(titleEvidence(r).map((e) => e.source.kind)).toEqual(["zotero"]);
  });

  /** R410 a, the review's I1 table: titles of different works stay a conflict (the wrong file may be attached). */
  it.each([
    ["A History of Modern Iran", "A History of Modern India"],
    ["Capital, Volume I", "Capital, Volume II"],
    ["Capital, Volume II", "Capital, Volume I"],
    ["Gender and Power in Rural China", "Gender and Power in Rural India"],
    ["Social Capital and Civic Engagement in Italy", "Social Capital and Civic Engagement in Germany"],
    ["The Politics of Memory in Postwar Europe", "The Politics of Water in Postwar Europe"],
    ["A Theory of Justice", "A Theory of Justice for Animals"],
    ["A Theory of Justice for Animals", "A Theory of Justice"],
    ["The Politics of Memory in Postwar Europe", "The Politics of"],
    // A cut inside a word is not a run of whole words.
    [ZOTERO_TITLE, "Subsistence and persistence: agriculture in the Central Plains of China throu"],
    // A prefix whose rest is no subtitle, with fewer than three real words.
    ["Markets and Memory in Lagos", "Markets and Memory"],
  ])("reference %j, embedded %j: a conflict, the title still the reference's", async (reference, embedded) => {
    const r = await withZotero(embedded, reference);
    expect(primary(r.draft.title)).toBe(reference);
    expect(r.verification.fields["/title"]?.status).toBe("conflict");
    expect(r.verification.overall).toBe("needs-review");
    expect(titleEvidence(r).map((e) => e.source.kind).sort()).toEqual(["embedded", "zotero"]);
  });

  it("an embedded title of another work stays a conflict (the wrong file may be attached): the title is still Zotero's", async () => {
    const r = await withZotero("Rivers and Memory in Upland Villages");
    expect(primary(r.draft.title)).toBe(ZOTERO_TITLE);
    expect(r.verification.fields["/title"]?.status).toBe("conflict");
    expect(r.verification.overall).toBe("needs-review");
    expect(r.confidence).toBeLessThan(AUTO_ACCEPT_THRESHOLD);
  });

  it("a part of two words or fewer is not enough to agree on its own", async () => {
    const r = await withZotero("Bronze Age");
    expect(r.verification.fields["/title"]?.status).toBe("conflict");
  });
});

describe("R394 with no reference record", () => {
  it("a junk embedded title leaves the title to the later steps (here the file's name), and is not evidence", async () => {
    const path = await pdf("Field Notes on Market Days.pdf", { title: "JQE-2020-0041.R1", author: "Administrator" });
    const r = await resolveItem({ path, mime: "application/pdf" }, ctx);
    expect(primary(r.draft.title)).toBe("Field Notes on Market Days");
    expect(titleEvidence(r).every((e) => e.source.kind === "filename")).toBe(true);
    expect(r.draft.creators).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("JQE-2020");
    expect(JSON.stringify(r)).not.toContain("Administrator");
  });

  it("a good embedded title is used as today", async () => {
    const path = await pdf("scan_0042.pdf", { title: "Rivers and Memory in Upland Villages", author: "Maria Lopez" });
    const r = await resolveItem({ path, mime: "application/pdf" }, ctx);
    expect(primary(r.draft.title)).toBe("Rivers and Memory in Upland Villages");
    expect(r.evidence).toMatchObject({ method: "embedded", hasTitle: true, hasCreator: true });
    expect(titleEvidence(r)[0]).toMatchObject({ value: "Rivers and Memory in Upland Villages", source: { kind: "embedded" } });
    expect(r.draft.creators).toEqual([{ given: "Maria", family: "Lopez", role: "author" }]);
  });
});
