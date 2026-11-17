/**
 * R415 d (FR-A11 review 2 M3): browser capture tests its legal basis with core's one `blank()`, so an
 * invisible basis (a zero-width space) is none — neither the request's nor the project's default is stored.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tinyPng } from "../../../../tests/fixtures/generate.mjs";
import { OPEN_GOV, makeKit, makeProject, type Kit } from "../export/test-kit.js";
import { captureBrowserPage } from "./browser-capture.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-browser-legal-");
});
afterEach(async () => {
  await kit.close();
});

const GOV = OPEN_GOV.replace("downloader]", "downloader, browser_capture]");

describe("browser capture: a blank legal basis is none (R415 d)", () => {
  it("a zero-width-space basis in the request is not stored", async () => {
    const open = await makeProject(kit, GOV);
    const r = await captureBrowserPage(kit.repo, open.id, { url: "https://example.org/a", screenshotPng: tinyPng().toString("base64"), legalBasis: "​" });
    const sf = await kit.repo.getSource(open.id, r.sourceId);
    expect(sf.source.provenance.legal).toEqual({ status: "unknown" });
  });
  it("a zero-width-space project default is not stored; a real one is, trimmed", async () => {
    const blankDefault = await makeProject(kit, GOV.replace("requireLegalBasis: false", 'requireLegalBasis: false\n  defaultLegalBasis: { social-media: "\\u200b" }'));
    const r = await captureBrowserPage(kit.repo, blankDefault.id, { url: "https://example.org/b", screenshotPng: tinyPng().toString("base64") });
    expect((await kit.repo.getSource(blankDefault.id, r.sourceId)).source.provenance.legal).toEqual({ status: "unknown" });
    const r2 = await captureBrowserPage(kit.repo, blankDefault.id, { url: "https://example.org/c", screenshotPng: tinyPng().toString("base64"), legalBasis: "  public task  " });
    expect((await kit.repo.getSource(blankDefault.id, r2.sourceId)).source.provenance.legal).toEqual({ status: "unknown", basis: "public task" });
  });
});
