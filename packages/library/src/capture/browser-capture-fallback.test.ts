/**
 * R391 f (review M6): if the classifier ever gave no address, browser capture stores the cleaned
 * address, never the address as given. The classifier is stubbed to give an empty canonical address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tinyPng } from "../../../../tests/fixtures/generate.mjs";
import { OPEN_GOV, auditEvents, makeKit, makeProject, type Kit } from "../export/test-kit.js";

vi.mock("./platforms.js", async (orig) => {
  const real = await orig<typeof import("./platforms.js")>();
  return { ...real, classifyUrl: (u: string) => ({ ...real.classifyUrl(u), canonicalUrl: "" }) };
});

const { captureBrowserPage } = await import("./browser-capture.js");

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-browser-fallback-");
});
afterEach(async () => {
  await kit.close();
});

describe("browser capture's fallback address is the cleaned one (R391 f)", () => {
  it("no user name, password, path session id or token is stored", async () => {
    const open = await makeProject(kit, OPEN_GOV.replace("downloader]", "downloader, browser_capture]"));
    const url = "https://ana:hunter2@portal.example.org/case/7;jsessionid=JSESS?id=7&access_token=SECRETTOKEN#frag";
    const r = await captureBrowserPage(kit.repo, open.id, { url, screenshotPng: tinyPng().toString("base64") });
    const sf = await kit.repo.getSource(open.id, r.sourceId);
    expect(sf.source.identifiers.url).toBe("https://portal.example.org/case/7?id=7");
    expect(sf.source.provenance.originalUrl).toBe("https://portal.example.org/case/7?id=7");
    const all = JSON.stringify(sf) + JSON.stringify(await auditEvents(kit, open));
    for (const bad of ["ana", "hunter2", "JSESS", "SECRETTOKEN", "frag"]) expect(all, bad).not.toContain(bad);
  });
});
