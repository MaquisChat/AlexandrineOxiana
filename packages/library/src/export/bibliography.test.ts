import { readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { IN_LIBRARY_TEXT } from "@ao/shared";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCustomStyle, bundleAvailable } from "../citation/custom-styles.js";
import { InvalidInputError, PolicyDeniedError } from "../repo/errors.js";
import { citeSources, exportBibliography, WITHHELD_NOTE } from "./bibliography.js";
import { DEID_GOV, OPEN_GOV, PSEUDO_GOV, addSource, auditEvents, makeKit, makeProject, scratchFile, type Kit } from "./test-kit.js";

const HAVE_BUNDLE = bundleAvailable();
if (!HAVE_BUNDLE && process.env.CI === "true") throw new Error("CSL bundle missing: run `pnpm fetch-csl` (scripts/fetch-csl.mjs)");

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-bib-");
});
afterEach(async () => {
  await kit.close();
});

const person = (family: string, given: string) => ({ family, given, role: "author" as const });

describe.skipIf(!HAVE_BUNDLE)("exportBibliography", () => {
  it("APA bibliography of a collection of 3 is in alphabetical order and written to Exports/ with the dated name (0600)", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Market Study");
    const coll = await kit.repo.createCollection(p.id, "Chapter 2");
    await addSource(kit, p, { title: "Zebra crossings", creators: [person("Zimmer", "Ute")], issued: "2019", container: "Journal of Roads", collectionIds: [coll.id] });
    await addSource(kit, p, { title: "Apples and pears", creators: [person("Adams", "Ann")], issued: "2021", container: "Fruit Review", collectionIds: [coll.id] });
    await addSource(kit, p, { title: "Mountain paths", creators: [person("Müller", "Max")], issued: "2020", container: "Alpine Studies", collectionIds: [coll.id] });
    await addSource(kit, p, { title: "Not in the collection", creators: [person("Baker", "Bo")], issued: "2018" });

    const r = await exportBibliography(kit.repo, p.id, { collectionId: coll.id }, "apa", "html");
    const iA = r.content.indexOf("Adams");
    const iM = r.content.indexOf("Müller");
    const iZ = r.content.indexOf("Zimmer");
    expect(iA).toBeGreaterThan(-1);
    expect(iA).toBeLessThan(iM);
    expect(iM).toBeLessThan(iZ);
    expect(r.content).not.toContain("Baker");
    expect(r.path).toBe(join(kit.lib.root, "Exports", "Market Study - bibliography - apa - modified 2026-11-10 0930.html"));
    expect(await readFile(r.path!, "utf8")).toBe(r.content);
    if (process.platform !== "win32") expect((await stat(r.path!)).mode & 0o777).toBe(0o600);
    expect(r.withheld).toBe(0);
    // No temp files left behind.
    expect(await readdir(join(kit.lib.root, "Exports"))).toEqual(["Market Study - bibliography - apa - modified 2026-11-10 0930.html"]);
  });

  it("RTF output is an RTF document ({\\rtf1 …}); text has one entry per line; a tag selects too", async () => {
    const p = await makeProject(kit);
    const tag = await kit.repo.createTag(p.id, "core");
    await addSource(kit, p, { title: "Tagged one", creators: [person("Okafor", "Ngozi")], issued: "2020", tagIds: [tag.id] });
    await addSource(kit, p, { title: "Tagged two", creators: [person("Berg", "Jan")], issued: "2021", tagIds: [tag.id] });
    const rtf = await exportBibliography(kit.repo, p.id, { tagId: tag.id }, "apa", "rtf");
    expect(rtf.content.startsWith("{\\rtf1")).toBe(true);
    expect(rtf.content.trimEnd().endsWith("}")).toBe(true);
    expect(rtf.path!.endsWith(".rtf")).toBe(true);
    kit.clock.now = new Date("2026-11-10T09:31:00.000Z");
    const text = await exportBibliography(kit.repo, p.id, { tagId: tag.id }, "apa", "text");
    expect(text.content.split("\n").filter((l) => l.trim())).toHaveLength(2);
    expect(text.path!.endsWith(" - modified 2026-11-10 0931.txt")).toBe(true);
  });

  it("deidentified-only: an identifiable source is left out and the result says 1 source withheld by project policy", async () => {
    const p = await makeProject(kit, DEID_GOV);
    const a = await addSource(kit, p, { title: "Published paper", creators: [person("Adams", "Ann")], issued: "2021" });
    const b = await addSource(kit, p, { title: "Interview with Rosa", creators: [person("Diaz", "Rosa")], issued: "2022", identifiable: true });
    const r = await exportBibliography(kit.repo, p.id, { sourceIds: [a.source.id, b.source.id] }, "apa", "text");
    expect(r.content).toContain("Adams");
    expect(r.content).not.toContain("Diaz");
    expect(r.content).not.toContain("Interview with Rosa");
    expect(r.withheld).toBe(1);
    expect(WITHHELD_NOTE(1)).toBe("1 source withheld by project policy");
    expect(r.notes).toContain("1 source withheld by project policy");
    expect(r.content).toContain("1 source withheld by project policy");
    const html = await exportBibliography(kit.repo, p.id, { sourceIds: [a.source.id, b.source.id] }, "apa", "html");
    expect(html.content).toContain("1 source withheld by project policy");
  });

  it("is audited (export.bibliography: style, format, counts) without any path or title", async () => {
    const p = await makeProject(kit, DEID_GOV, false, "Audit Me");
    const a = await addSource(kit, p, { title: "Secret-ish title", creators: [person("Adams", "Ann")], issued: "2021" });
    const b = await addSource(kit, p, { title: "Identifiable", identifiable: true });
    await exportBibliography(kit.repo, p.id, { sourceIds: [a.source.id, b.source.id] }, "apa", "html");
    const ev = (await auditEvents(kit, p)).filter((e) => e.action === "export.bibliography");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details).toMatchObject({ style: "apa", format: "html", exported: 1, withheld: 1 });
    const json = JSON.stringify(ev[0]);
    expect(json).not.toContain("Exports");
    expect(json).not.toContain("Audit Me");
    expect(json).not.toContain("Secret-ish");
  });

  it("a deny refuses the export: nothing is written, the deny is audited", async () => {
    const p = await makeProject(kit);
    const a = await addSource(kit, p, { title: "x" });
    // Break the governance file: fail closed.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(kit.lib.root, p.folder, "governance.yaml"), "identifiability: [not, a, mapping]\n");
    await expect(exportBibliography(kit.repo, p.id, { sourceIds: [a.source.id] }, "apa", "html")).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(await readdir(join(kit.lib.root, "Exports"))).toEqual([]);
    expect((await auditEvents(kit, p)).some((e) => e.action === "export" && e.decision?.result === "deny")).toBe(true);
  });
});

describe.skipIf(!HAVE_BUNDLE)("citeSources (copy as citation)", () => {
  it("one in-text citation with the anchor's locator; audited as export.citation", async () => {
    const p = await makeProject(kit);
    const pdf = await scratchFile(kit, "paper.pdf", "%PDF-1.4 test");
    const a = await addSource(kit, p, {
      title: "Feeding the City",
      creators: [person("Okafor", "Ngozi")],
      issued: "2020",
      files: [{ path: pdf, role: "original", handling: "copy" }],
    });
    const b = await addSource(kit, p, { title: "Other", creators: [person("Berg", "Jan")], issued: "2021" });
    const asset = a.assets[0]!;
    const anchor = { kind: "pdf" as const, id: "11111111-1111-4111-8111-111111111111", assetId: asset.id, page: 12, rects: [{ x: 0, y: 0, w: 1, h: 1 }] };
    const text = await citeSources(kit.repo, p.id, [{ sourceId: a.source.id, anchor }, { sourceId: b.source.id }], "apa", "text");
    expect(text).toBe("(Berg, 2021; Okafor, 2020, p. 12)");
    const html = await citeSources(kit.repo, p.id, [{ sourceId: a.source.id }], "apa", "html");
    expect(html).toContain("Okafor");
    const ev = (await auditEvents(kit, p)).filter((e) => e.action === "export.citation");
    expect(ev).toHaveLength(2);
    expect(ev[0]!.details).toMatchObject({ style: "apa", format: "text", exported: 2, withheld: 0 });
  });

  it("deidentified-only: the identifiable source is left out and the citation says so", async () => {
    const p = await makeProject(kit, DEID_GOV);
    const a = await addSource(kit, p, { title: "Paper", creators: [person("Adams", "Ann")], issued: "2021" });
    const b = await addSource(kit, p, { title: "Interview", creators: [person("Diaz", "Rosa")], issued: "2022", identifiable: true });
    const text = await citeSources(kit.repo, p.id, [{ sourceId: a.source.id }, { sourceId: b.source.id }], "apa", "text");
    expect(text).toContain("Adams");
    expect(text).not.toContain("Diaz");
    expect(text).toContain("[1 source withheld by project policy]");
    const only = await citeSources(kit.repo, p.id, [{ sourceId: b.source.id }], "apa", "text");
    expect(only).toBe("[1 source withheld by project policy]");
  });

  it("pseudonymizing project: an identifiable source's creator is cited by participant code (governance-derived rules)", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true);
    const sf = await addSource(kit, p, {
      type: "social-post",
      title: "Cocinando hoy",
      creators: [{ literal: "@maria.cocina", handle: "@maria.cocina", role: "uploader" }],
      issued: "2026-03-14",
      identifiable: true,
    });
    const lit = await addSource(kit, p, { title: "A published book", type: "book", creators: [person("Adams", "Ann")], issued: "2001" });
    const text = await citeSources(kit.repo, p.id, [{ sourceId: sf.source.id }, { sourceId: lit.source.id }], "apa", "text");
    expect(text).toContain("P-001");
    expect(text).toContain("Adams");
    expect(text.toLowerCase()).not.toContain("maria");
    const bib = await exportBibliography(kit.repo, p.id, { sourceIds: [sf.source.id, lit.source.id] }, "apa", "html");
    expect(bib.content).toContain("P-001");
    expect(bib.content.toLowerCase()).not.toContain("maria");
  });

  it("FR-A10 (R378 a): a source's folder name and its bibliography entry agree for a participant written without spaces and one with accents", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true);
    const wang = await addSource(kit, p, { type: "book", title: "王小明访谈录", creators: [{ literal: "王小明", role: "interviewee" }], issued: "2025", identifiable: true });
    const lucia = await addSource(kit, p, {
      type: "book", // (a book: the styles give a recorded interview no reference-list entry)
      title: "Entrevista a Lucia Fernandez",
      creators: [{ given: "Lucía", family: "Fernández", role: "interviewee" }],
      issued: "2025",
      identifiable: true,
    });
    const codeOf = (folder: string) => /P-\d{3}/u.exec(folder)?.[0];
    const wangCode = codeOf(wang.source.folder);
    const luciaCode = codeOf(lucia.source.folder);
    expect(wangCode).toBeDefined();
    expect(luciaCode).toBeDefined();
    // The folder: the name replaced inside the title too, accents or not.
    expect(wang.source.folder).not.toContain("王小明");
    expect(wang.source.folder).toContain(`${wangCode}访谈录`);
    expect(lucia.source.folder.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()).not.toMatch(/lucia|fernandez/u);
    expect(lucia.source.folder).toContain(`Entrevista a ${luciaCode}`);
    // The bibliography: the same codes, the same titles.
    const bib = await exportBibliography(kit.repo, p.id, { sourceIds: [wang.source.id, lucia.source.id] }, "apa", "text");
    expect(bib.content).not.toContain("王小明");
    expect(bib.content.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()).not.toMatch(/lucia|fernandez/u);
    expect(bib.content).toContain(`${wangCode}访谈录`);
    expect(bib.content).toContain(`Entrevista a ${luciaCode}`);
  });

  it("R387 (d): a participant named only in the fieldwork details is coded in the folder name and the bibliography alike", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true);
    const part = await kit.repo.createParticipant(p.id, { details: { fullName: "Lucía Fernández Ruiz" }, legalBasis: "consent" });
    // A news story ABOUT her, by another author.
    const story = await addSource(kit, p, {
      type: "book",
      title: "Lucía Fernández Ruiz habla; entrevista a Lucia Fernandez Ruiz",
      creators: [person("Chen", "Wei")],
      issued: "2025",
      identifiable: true,
    });
    const plain = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    expect(story.source.folder).toContain(`${part.code} habla`);
    expect(plain(story.source.folder)).not.toMatch(/lucia|fernandez|ruiz/u);
    const bib = await exportBibliography(kit.repo, p.id, { sourceIds: [story.source.id] }, "apa", "text");
    expect(bib.content).toContain(`${part.code} habla`);
    expect(plain(bib.content)).not.toMatch(/lucia|fernandez|ruiz/u);
  });

  it("R387 (e): a creator with a family name of two words: part of the name is never left beside the code, in the folder or the bibliography", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true);
    const sf = await addSource(kit, p, {
      type: "book",
      title: "Entrevista a Lucía Fernández y Ruiz habla",
      creators: [{ given: "Lucía", family: "Fernández Ruiz", role: "interviewee" }],
      issued: "2025",
      identifiable: true,
    });
    const plain = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    const code = /P-\d{3}/u.exec(sf.source.folder)![0];
    expect(sf.source.folder).toContain(`Entrevista a ${code} y ${code} habla`);
    expect(plain(sf.source.folder)).not.toMatch(/lucia|fernandez|ruiz/u);
    const bib = await exportBibliography(kit.repo, p.id, { sourceIds: [sf.source.id] }, "apa", "text");
    expect(bib.content).toContain(`Entrevista a ${code} y ${code} habla`);
    expect(plain(bib.content)).not.toMatch(/lucia|fernandez|ruiz/u);
  });

  it("R403 (b), changed from R387 (M6): a creator written without accents is a participant of her own (identity is strict)", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true);
    const a = await addSource(kit, p, { type: "book", title: "Primera", creators: [{ given: "Lucía", family: "Fernández", role: "interviewee" }], issued: "2025", identifiable: true });
    const b = await addSource(kit, p, { type: "book", title: "Segunda", creators: [{ given: "LUCIA", family: "Fernandez", role: "interviewee" }], issued: "2025", identifiable: true });
    const fw = await kit.repo.getFieldwork(p.id);
    expect(fw.participants).toHaveLength(2);
    expect(a.source.participantIds).toHaveLength(1);
    expect(b.source.participantIds).toHaveLength(1);
    expect(b.source.participantIds[0]).not.toBe(a.source.participantIds[0]);
  });

  it("a custom style renders through the sandbox", async () => {
    const p = await makeProject(kit);
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="en-US">
  <info><title>Lab Style</title><id>http://www.zotero.org/styles/lab-style-29</id><updated>2026-11-01T00:00:00+00:00</updated></info>
  <citation><layout prefix="[" suffix="]" delimiter="; "><names variable="author"><name form="short"/></names><date variable="issued" prefix=" "><date-part name="year"/></date></layout></citation>
  <bibliography><layout><names variable="author" suffix=". "><name/></names><text variable="title" font-style="italic"/></layout></bibliography>
</style>`;
    const id = await addCustomStyle(kit.repo, p.id, xml);
    const a = await addSource(kit, p, { title: "Lab notes", type: "book", creators: [person("Diaz", "Rosa")], issued: "2020" });
    expect(await citeSources(kit.repo, p.id, [{ sourceId: a.source.id }], id, "text")).toBe("[Diaz 2020]");
    const r = await exportBibliography(kit.repo, p.id, { sourceIds: [a.source.id] }, id, "text");
    expect(r.content.trim()).toBe("Rosa Diaz. Lab notes");
  });
});

describe("R390 (c): the bibliography's destination folder is never inside the library", () => {
  const exported = async (p: { id: string; folder: string } & Parameters<typeof auditEvents>[1]) =>
    (await auditEvents(kit, p)).filter((e) => e.action === "export.bibliography").length;

  it("the reviewer's probe: <project>/sources/zz-new in an encrypted project is refused before anything is made; nothing audited as an export", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true);
    const sf = await addSource(kit, p, { title: "A paper", creators: [person("Adams", "Ann")], issued: "2020" });
    const dest = join(kit.lib.root, p.folder, "sources", "zz-new");
    await expect(exportBibliography(kit.repo, p.id, { sourceIds: [sf.source.id] }, "apa", "text", dest)).rejects.toThrow(new InvalidInputError(IN_LIBRARY_TEXT.exportFile));
    await expect(stat(dest)).rejects.toThrow();
    expect(await exported(p)).toBe(0);
  });

  it("a link outside the library that leads into it is refused; so are Backups, the root and a way out of Exports with '..'", async () => {
    const p = await makeProject(kit, OPEN_GOV);
    const sf = await addSource(kit, p, { title: "A paper", creators: [person("Adams", "Ann")], issued: "2020" });
    const link = join(kit.tmp, "into-project");
    await symlink(join(kit.lib.root, p.folder), link);
    for (const dest of [join(link, "zz-new"), link, join(kit.lib.root, "Backups"), kit.lib.root, `${join(kit.lib.root, "Exports")}/../Projects`]) {
      await expect(exportBibliography(kit.repo, p.id, { sourceIds: [sf.source.id] }, "apa", "text", dest), dest).rejects.toThrow(new InvalidInputError(IN_LIBRARY_TEXT.exportFile));
    }
    await expect(stat(join(kit.lib.root, p.folder, "zz-new"))).rejects.toThrow();
    expect(await exported(p)).toBe(0);
  });

  it.skipIf(!HAVE_BUNDLE)("R408 (c): the library's own Exports folder, named outright, a new folder in it, and one before Exports exists are written to", async () => {
    const p = await makeProject(kit, OPEN_GOV);
    const sf = await addSource(kit, p, { title: "A paper", creators: [person("Adams", "Ann")], issued: "2020" });
    for (const dest of [join(kit.lib.root, "Exports"), join(kit.lib.root, "Exports", "sub")]) {
      const r = await exportBibliography(kit.repo, p.id, { sourceIds: [sf.source.id] }, "apa", "text", dest);
      expect(r.path!.startsWith(dest + "/")).toBe(true);
      expect(await readFile(r.path!, "utf8")).toContain("Adams");
    }
    // With no Exports folder yet, its nearest existing parent is the library's root: a new folder in it is made.
    await rm(join(kit.lib.root, "Exports"), { recursive: true, force: true });
    const fresh = join(kit.lib.root, "Exports", "new", "deeper");
    const r = await exportBibliography(kit.repo, p.id, { sourceIds: [sf.source.id] }, "apa", "text", fresh);
    expect(r.path!.startsWith(fresh + "/")).toBe(true);
    expect(await exported(p)).toBe(3);
  });

  it("R408 (c): a link named Exports that leads into a project's folder is refused; nothing is made there", async () => {
    const p = await makeProject(kit, OPEN_GOV);
    const sf = await addSource(kit, p, { title: "A paper", creators: [person("Adams", "Ann")], issued: "2020" });
    await rm(join(kit.lib.root, "Exports"), { recursive: true, force: true });
    await symlink(join(kit.lib.root, p.folder), join(kit.lib.root, "Exports"));
    await expect(exportBibliography(kit.repo, p.id, { sourceIds: [sf.source.id] }, "apa", "text", join(kit.lib.root, "Exports", "zz"))).rejects.toThrow(new InvalidInputError(IN_LIBRARY_TEXT.exportFile));
    await expect(stat(join(kit.lib.root, p.folder, "zz"))).rejects.toThrow();
    expect(await exported(p)).toBe(0);
  });

  it.skipIf(!HAVE_BUNDLE)("a destination outside the library still works", async () => {
    const p = await makeProject(kit, OPEN_GOV);
    const sf = await addSource(kit, p, { title: "A paper", creators: [person("Adams", "Ann")], issued: "2020" });
    const dest = join(kit.tmp, "outside", "bibs");
    const r = await exportBibliography(kit.repo, p.id, { sourceIds: [sf.source.id] }, "apa", "text", dest);
    expect(r.path!.startsWith(dest)).toBe(true);
    expect(await readFile(r.path!, "utf8")).toContain("Adams");
    expect(await exported(p)).toBe(1);
  });
});

describe("R403 (b): who is the same participant is decided by a strict key (I1 of the FR-A10 second review)", () => {
  type C = { given?: string; family?: string; literal?: string; handle?: string };
  /** Adds one source per creator, in turn, to an encrypted project that pseudonymises; the participants and each source's link. */
  const addInTurn = async (creators: C[]) => {
    const p = await makeProject(kit, PSEUDO_GOV, true);
    const links: string[][] = [];
    for (const [i, c] of creators.entries()) {
      const sf = await addSource(kit, p, { type: "book", title: `Fuente ${i + 1}`, creators: [{ ...c, role: "interviewee" }], issued: "2025", identifiable: true });
      links.push(sf.source.participantIds);
    }
    return { participants: (await kit.repo.getFieldwork(p.id)).participants, links };
  };

  it.each<[string, C, C]>([
    ["Lê Thị Hương / Lê Thị Hường", { literal: "Lê Thị Hương" }, { literal: "Lê Thị Hường" }],
    ["Ana Peña / Ana Pena", { given: "Ana", family: "Peña" }, { given: "Ana", family: "Pena" }],
    ["@maria / María", { handle: "@maria" }, { literal: "María" }],
    ["ハナコ / バナコ", { literal: "ハナコ" }, { literal: "バナコ" }],
    ["@maria.cocina / Maria Cocina", { handle: "@maria.cocina" }, { given: "Maria", family: "Cocina" }],
  ])("%s: two participants, each source linked to its own", async (_label, first, second) => {
    const { participants, links } = await addInTurn([first, second]);
    expect(participants).toHaveLength(2);
    expect(links[0]).toHaveLength(1);
    expect(links[1]).toHaveLength(1);
    expect(links[0]![0]).toBe(participants[0]!.id);
    expect(links[1]![0]).toBe(participants[1]!.id);
    expect(participants[0]!.code).not.toBe(participants[1]!.code);
  });

  it.each<[string, C, C]>([
    ["case only", { given: "LUCIA", family: "FERNANDEZ" }, { given: "Lucia", family: "Fernandez" }],
    ["two spaces / one space", { literal: "Lucía  Fernández" }, { literal: "Lucía Fernández" }],
    ["Hangul written apart / together", { literal: "김 민수" }, { literal: "김민수" }],
    ["Han written apart / together", { literal: "山田 太郎" }, { literal: "山田太郎" }],
  ])("%s: one participant", async (_label, first, second) => {
    const { participants, links } = await addInTurn([first, second]);
    expect(participants).toHaveLength(1);
    expect(links[1]).toEqual(links[0]);
  });
});

describe.skipIf(!HAVE_BUNDLE)("R403 (c): a single word of a compound family name stands for the name only when it could be a name by itself (I2 of the FR-A10 second review)", () => {
  it.each([
    [{ given: "Juan", family: "de la Cruz" }, "Historia de la ciudad y la Cruz Roja", "Historia de la ciudad y la CODE Roja"],
    [{ given: "Jan", family: "van der Berg" }, "Der Berg ruft van Gogh", "Der CODE ruft van Gogh"],
    [{ given: "Lucía", family: "Fernández Ruiz" }, "Fernández habla y Ruiz calla", "CODE habla y CODE calla"],
  ])("%j with %j: the folder name and the bibliography agree, particles kept", async (c, title, expected) => {
    const p = await makeProject(kit, PSEUDO_GOV, true);
    const sf = await addSource(kit, p, { type: "book", title, creators: [{ ...c, role: "interviewee" }], issued: "2025", identifiable: true });
    const code = /P-\d{3}/u.exec(sf.source.folder)![0];
    const want = expected.replaceAll("CODE", code);
    expect(sf.source.folder).toContain(want);
    const bib = await exportBibliography(kit.repo, p.id, { sourceIds: [sf.source.id] }, "apa", "text");
    expect(bib.content).toContain(want);
  });
});

describe.skipIf(!HAVE_BUNDLE)("R416: two participants whose names fold alike each carry their own code", () => {
  it("Ana Peña and Ana Pena: each folder name and each bibliography entry carries its OWN code", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true);
    const a = await addSource(kit, p, { type: "book", title: "Entrevista a Ana Peña", creators: [{ given: "Ana", family: "Peña", role: "interviewee" }], issued: "2025", identifiable: true });
    const b = await addSource(kit, p, { type: "book", title: "Entrevista a Ana Pena", creators: [{ given: "Ana", family: "Pena", role: "interviewee" }], issued: "2025", identifiable: true });
    const fw = await kit.repo.getFieldwork(p.id);
    const codeOf = (pid: string) => fw.participants.find((x) => x.id === pid)!.code;
    const ca = codeOf(a.source.participantIds[0]!);
    const cb = codeOf(b.source.participantIds[0]!);
    expect(ca).not.toBe(cb);
    expect(a.source.folder).toContain(`${ca} - Entrevista a ${ca}`);
    expect(b.source.folder).toContain(`${cb} - Entrevista a ${cb}`);
    const bibA = await exportBibliography(kit.repo, p.id, { sourceIds: [a.source.id] }, "apa", "text");
    const bibB = await exportBibliography(kit.repo, p.id, { sourceIds: [b.source.id] }, "apa", "text");
    expect(bibA.content).toContain(`Entrevista a ${ca}`);
    expect(bibA.content).not.toContain(cb);
    expect(bibB.content).toContain(`Entrevista a ${cb}`);
    expect(bibB.content).not.toContain(ca);
  });
});

describe.skipIf(!HAVE_BUNDLE)("R420 (a): a participant's whole name inside a creator who is not a participant", () => {
  it("the printed entry shows 'Friends of P-001', never the name", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true);
    const part = await kit.repo.createParticipant(p.id, { details: { fullName: "Maria Cocina", handle: "@maria.cocina" }, legalBasis: "consent" });
    const page = await addSource(kit, p, { type: "webpage", title: "Recetas de la abuela", creators: [{ literal: "Friends of Maria Cocina", role: "author" }], issued: "2025" });
    for (const style of ["apa", "chicago-author-date"]) {
      const bib = await exportBibliography(kit.repo, p.id, { sourceIds: [page.source.id] }, style, "text");
      expect(bib.content).toContain(`Friends of ${part.code}`);
      expect(bib.content.toLowerCase()).not.toContain("cocina");
    }
  });
});
