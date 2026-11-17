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

async function withZotero(embedded: string) {
  const path = await pdf(`${Math.random().toString(36).slice(2)}.pdf`, { title: embedded });
  return resolveItem({ path, mime: "application/pdf", referenceMetadata: zotero(), referenceSource: { kind: "zotero" } }, ctx);
}

const titleEvidence = (r: Awaited<ReturnType<typeof resolveItem>>) => r.fieldEvidence.filter((e) => e.field === "/title");

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

  it.each([
    ["the title without its subtitle", "Subsistence and persistence"],
    ["a running head (the subtitle alone)", "Agriculture in the Central Plains of China"],
    ["a title cut off by a length limit", "Subsistence and persistence: agriculture in the Central Plains of China throu"],
    ["case, accents and punctuation", "SUBSISTENCE AND PERSISTENCE — Agriculture in the Céntral Plains of China through the Neolithic to Bronze Age Transition."],
  ])("an embedded title that is %s agrees", async (_what, embedded) => {
    const r = await withZotero(embedded);
    expect(primary(r.draft.title)).toBe(ZOTERO_TITLE);
    expect(r.titleConflict).toBe(false);
    expect(r.verification.fields["/title"]?.status).not.toBe("conflict");
    expect(r.verification.overall).not.toBe("needs-review");
    expect(r.confidence).toBeGreaterThanOrEqual(AUTO_ACCEPT_THRESHOLD);
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
