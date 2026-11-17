/**
 * R379 (FR-A14, WB4 I2): the reference exports (BibTeX, RIS, CSL-JSON) and the open-format export's `sources.bib` and
 * `sources.csl.json` apply the participant rules of R88 the bibliography applies: participants as their codes, titles
 * and other text scrubbed of their names, no citation key copied, a source failing closed left out and counted.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@ao/core";
import { exportBibliography } from "./bibliography.js";
import { exportProjectOpenFormats } from "./project-export.js";
import { PARTICIPANT_CODE_MISSING_NOTE, PARTICIPANT_NO_LIST_NOTE, exportRefman, type RefmanFormat } from "./refman-export.js";
import { OPEN_GOV, PSEUDO_GOV, addSource, makeKit, makeProject, type Kit } from "./test-kit.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-refpart-");
});
afterEach(async () => {
  await kit.close();
});

const FORMATS: RefmanFormat[] = ["bibtex", "ris", "csl-json"];

/** The reviewer's probe: an identifiable social post by @maria.cocina, citation key mariacocina2026, in a pseudonymising project. */
async function probe(): Promise<{ p: Project; post: string; lit: string }> {
  const p = await makeProject(kit, PSEUDO_GOV, true);
  const post = await addSource(kit, p, {
    type: "social-post",
    title: "Cocinando hoy con @maria.cocina",
    creators: [{ literal: "@maria.cocina", handle: "@maria.cocina", role: "uploader" }],
    issued: "2026-03-14",
    citationKey: "mariacocina2026",
    identifiers: { url: "https://www.instagram.com/maria.cocina/p/abc/", platform: "instagram" },
    identifiable: true,
  });
  const lit = await addSource(kit, p, {
    type: "book",
    title: "A published book",
    creators: [{ family: "Adams", given: "Ann", role: "author" }],
    issued: "2001",
    citationKey: "adams2001published",
  });
  return { p, post: post.source.id, lit: lit.source.id };
}

describe("R379 (FR-A14, I2): R88's participant rules reach the reference exports", () => {
  it("the reviewer's probe: BibTeX, RIS and CSL-JSON hold P-001 and nothing of the name or its key; literature keeps its key", async () => {
    const { p, post, lit } = await probe();
    for (const format of FORMATS) {
      const r = await exportRefman(kit.repo, p.id, [post, lit], format);
      expect(r.exported, format).toBe(2);
      expect(r.text, format).toContain("P-001");
      expect(r.text.toLowerCase(), format).not.toContain("maria");
      expect(r.text.toLowerCase(), format).not.toContain("mariacocina2026");
      // The withheld key is replaced by one the writer makes from the source's id, holding no name (R390 e, M1).
      expect(r.text, format).toContain(`ref-${post.slice(-8)}`);
      expect(r.text, format).toContain("adams2001published");
      expect(r.text, format).toContain("Adams");
    }
    // The bibliography of the same source prints the same code.
    const bib = await exportBibliography(kit.repo, p.id, { sourceIds: [post] }, "apa", "text", join(kit.tmp, "bib"));
    expect(bib.content).toContain("P-001");
  });

  it("the open-format export's sources.bib and sources.csl.json hold P-001 and nothing of the name or its key", async () => {
    const { p } = await probe();
    const dest = join(kit.tmp, "out");
    await mkdir(dest, { recursive: true });
    const r = await exportProjectOpenFormats(kit.repo, p.id, dest);
    for (const f of ["sources.bib", "sources.csl.json"]) {
      const text = await readFile(join(r.path, f), "utf8");
      expect(text, f).toContain("P-001");
      expect(text.toLowerCase(), f).not.toContain("maria");
      expect(text.toLowerCase(), f).not.toContain("mariacocina2026");
    }
  });

  it("a participant without a code where codes are required: the source is left out, named by its id and counted", async () => {
    const { p, post, lit } = await probe();
    await kit.repo.updateSource(p.id, post, {
      creators: [
        { literal: "@maria.cocina", handle: "@maria.cocina", role: "uploader" },
        { family: "Ruiz", given: "Tomasa", role: "author" },
      ],
    });
    for (const format of FORMATS) {
      const r = await exportRefman(kit.repo, p.id, [post, lit], format);
      expect(r.exported, format).toBe(1);
      expect(r.excluded, format).toEqual([{ sourceId: post, reason: PARTICIPANT_CODE_MISSING_NOTE }]);
      expect(r.notes.join(" "), format).toMatch(/1 source was left out because a participant in it has no participant code/u);
      expect(r.text.toLowerCase(), format).not.toContain("maria");
      expect(r.text.toLowerCase(), format).not.toContain("ruiz");
      expect(r.text, format).toContain("adams2001published");
    }
    const dest = join(kit.tmp, "out");
    await mkdir(dest, { recursive: true });
    const open = await exportProjectOpenFormats(kit.repo, p.id, dest);
    expect(open.notes.join(" ")).toMatch(/1 source is not in sources\.bib and sources\.csl\.json because a participant in it has no participant code/u);
    for (const f of ["sources.bib", "sources.csl.json"]) {
      const text = (await readFile(join(open.path, f), "utf8")).toLowerCase();
      expect(text, f).not.toContain("ruiz");
      expect(text, f).toContain("adams2001published");
    }
  });

  it("a project that does not pseudonymise exports its sources as they are (names and keys)", async () => {
    const p = await makeProject(kit, OPEN_GOV);
    const id = (
      await addSource(kit, p, {
        type: "social-post",
        title: "Cocinando hoy con @maria.cocina",
        creators: [{ literal: "@maria.cocina", handle: "@maria.cocina", role: "uploader" }],
        issued: "2026-03-14",
        citationKey: "mariacocina2026",
        identifiers: { url: "https://www.instagram.com/maria.cocina/p/abc/" },
      })
    ).source.id;
    const bib = await exportRefman(kit.repo, p.id, [id], "bibtex");
    expect(bib.text).toBe(
      [
        "% Exported by Alexandrine Oxiana (UTF-8)",
        "",
        "@misc{mariacocina2026,",
        "  title = {Cocinando hoy con @maria.cocina},",
        "  author = {{@maria.cocina}},",
        "  date = {2026-03-14},",
        "  year = {2026},",
        "  url = {https://www.instagram.com/maria.cocina/p/abc/},",
        "}",
        "",
      ].join("\n"),
    );
    const csl = JSON.parse((await exportRefman(kit.repo, p.id, [id], "csl-json")).text) as Array<Record<string, unknown>>;
    expect(csl[0]).toMatchObject({ id: "mariacocina2026", "citation-key": "mariacocina2026", author: [{ literal: "@maria.cocina" }] });
  });
});

/**
 * R390 (a): in a project with participants' names to replace, EVERY text the reference export writes goes through the
 * name rule — whether or not `toCslItem` emits that field for that kind of source — and the source's own key is withheld
 * when it names a participant. The project's map knows "@maria.cocina" (P-001) from an identifiable post whose own text
 * holds nothing else of the name, so "cocina" can be asserted absent from the whole output.
 */
async function r390Project(): Promise<{ p: Project; post: string; repost: string; video: string; book: string }> {
  const p = await makeProject(kit, PSEUDO_GOV, true);
  const post = await addSource(kit, p, {
    type: "social-post",
    title: "A post",
    creators: [{ literal: "@maria.cocina", handle: "@maria.cocina", role: "uploader" }],
    issued: "2026-03-14",
    identifiers: { platform: "instagram" },
    identifiable: true,
  });
  const repost = await addSource(kit, p, {
    type: "social-post",
    title: "Brand post",
    creators: [{ literal: "BrandCo", role: "uploader" }],
    container: "Repost from Maria Cocina",
    citationKey: "brandco2026",
    identifiers: { platform: "instagram" },
  });
  const video = await addSource(kit, p, {
    type: "video",
    title: "Brand video",
    creators: [{ literal: "BrandCo", role: "channel" }],
    citationKey: "brandvideo",
    identifiers: { platform: "youtube" },
  });
  await kit.repo.updateSource(p.id, video.source.id, { publisher: "Maria Cocina" });
  const book = await addSource(kit, p, {
    type: "book",
    title: "Field notes",
    creators: [{ family: "Adams", given: "Ann", role: "author" }],
    issued: "2001",
    citationKey: "maria.cocina-notes",
  });
  return { p, post: post.source.id, repost: repost.source.id, video: video.source.id, book: book.source.id };
}

describe("R390 (a): every text the reference export writes goes through the name rule", () => {
  it("the reviewer's probes: a repost's container, a video's publisher and a book's own key hold the code, never the name", async () => {
    const { p, repost, video, book } = await r390Project();
    for (const format of FORMATS) {
      const r = await exportRefman(kit.repo, p.id, [repost, video, book], format);
      expect(r.exported, format).toBe(3);
      const low = r.text.toLowerCase();
      expect(low, format).not.toContain("maria");
      expect(low, format).not.toContain("cocina");
      // The source's own container and publisher are kept, scrubbed — not replaced by the platform's name.
      expect(r.text, format).toContain("Repost from P-001");
      expect(r.text, format).not.toContain("YouTube");
      expect(r.text, format).toContain("Adams");
    }
    const ris = (await exportRefman(kit.repo, p.id, [repost, video, book], "ris")).text;
    expect(ris).toContain("T2  - Repost from P-001");
    expect(ris).toContain("PB  - P-001");
    // Creators keep their roles (BrandCo stays the author of the repost and of the video).
    expect(ris.match(/^AU {2}- BrandCo$/gmu)).toHaveLength(2);
  });

  it("the open-format export's sources.bib and sources.csl.json hold the code and never the name", async () => {
    const { p } = await r390Project();
    const dest = join(kit.tmp, "out");
    await mkdir(dest, { recursive: true });
    const r = await exportProjectOpenFormats(kit.repo, p.id, dest);
    for (const f of ["sources.bib", "sources.csl.json"]) {
      const text = await readFile(join(r.path, f), "utf8");
      expect(text, f).toContain("Repost from P-001");
      expect(text.toLowerCase(), f).not.toContain("maria");
      expect(text.toLowerCase(), f).not.toContain("cocina");
    }
  });

  it("every bibliographic field, the identifiers and the address: scrubbed, or withheld when they name a participant", async () => {
    const { p, book } = await r390Project();
    await kit.repo.updateSource(p.id, book, {
      publisherPlace: "Casa Maria Cocina",
      collectionTitle: "Maria Cocina series",
      edition: "Maria Cocina edition",
      genre: "Notes of Maria Cocina",
      medium: "Maria Cocina tapes",
      identifiers: { doi: "10.1234/maria.cocina", url: "https://example.org/maria-cocina/notes", isbn: ["978-mariacocina"], issn: "maria-cocina", arxiv: "maria.cocina" },
    });
    for (const format of FORMATS) {
      const r = await exportRefman(kit.repo, p.id, [book], format);
      expect(r.text.toLowerCase(), format).not.toContain("maria");
      expect(r.text.toLowerCase(), format).not.toContain("cocina");
      expect(r.text, format).toContain("P-001 series");
    }
  });

  it("a source no rule touches is written exactly as the same source in a project without participants", async () => {
    const { p } = await r390Project();
    const plain = await makeProject(kit, OPEN_GOV);
    const spec = {
      type: "book" as const,
      title: "Rivers -- & {braces} 100%",
      creators: [{ family: "Smith", given: "Jane", role: "author" as const }, { family: "Ode", given: "Ola", role: "editor" as const }],
      issued: "2001-02",
      container: "Series of rivers",
      citationKey: "smith2001rivers",
      identifiers: { doi: "10.1/x y", url: "https://example.org/a b" },
    };
    const a = (await addSource(kit, p, spec)).source.id;
    const b = (await addSource(kit, plain, spec)).source.id;
    for (const format of FORMATS) {
      const ra = await exportRefman(kit.repo, p.id, [a], format);
      const rb = await exportRefman(kit.repo, plain.id, [b], format);
      expect(ra.text, format).toBe(rb.text);
      expect(ra.notes, format).toEqual(rb.notes);
    }
  });
});

describe("R390 (b): with includeTags, each tag's name goes through the name rule on every entry", () => {
  it("the reviewer's probe: the tag 'maria.cocina interviews' is written as 'P-001 interviews', on a coded and an untouched source", async () => {
    const { p, post, book } = await r390Project();
    const plainBook = (await addSource(kit, p, { type: "book", title: "Other", creators: [{ family: "Lee", given: "Ann", role: "author" }], citationKey: "lee" })).source.id;
    const tag = await kit.repo.createTag(p.id, "maria.cocina interviews");
    for (const id of [post, book, plainBook]) await kit.repo.updateSource(p.id, id, { tagIds: [tag.id] });
    for (const format of FORMATS) {
      const r = await exportRefman(kit.repo, p.id, [post, book, plainBook], format, { includeTags: true });
      expect(r.text.toLowerCase(), format).not.toContain("maria");
      expect(r.text.toLowerCase(), format).not.toContain("cocina");
      expect(r.text.split("P-001 interviews").length - 1, format).toBe(3);
    }
    const ris = (await exportRefman(kit.repo, p.id, [post, book, plainBook], "ris", { includeTags: true })).text;
    expect(ris.match(/^KW {2}- P-001 interviews$/gmu)).toHaveLength(3);
    // The untouched source keeps its own key.
    expect(ris).toContain("ID  - lee");
  });
});

describe("R390 (d): a source involving a participant in a project that keeps no list of names is left out, with the true reason", () => {
  it("the reviewer's probe: OPEN_GOV, unencrypted, P-001 (a code, no details) linked to an interview → left out with the new sentences", async () => {
    const p = await makeProject(kit, OPEN_GOV);
    const part = await kit.repo.createParticipant(p.id, {});
    const interview = (await addSource(kit, p, { type: "interview", title: "Interview 1", creators: [{ family: "Doe", given: "Ira", role: "interviewer" }], citationKey: "int1" })).source.id;
    await kit.repo.linkSourceToFieldwork(p.id, interview, { participantIds: [part.id] });
    const lit = (await addSource(kit, p, { type: "book", title: "A book", creators: [{ family: "Adams", given: "Ann", role: "author" }], citationKey: "adams" })).source.id;
    expect(PARTICIPANT_NO_LIST_NOTE).toBe("This source involves a participant, and this project keeps no list of participants' names, so it cannot be exported.");
    for (const format of FORMATS) {
      const r = await exportRefman(kit.repo, p.id, [interview, lit], format);
      expect(r.exported, format).toBe(1);
      expect(r.excluded, format).toEqual([{ sourceId: interview, reason: PARTICIPANT_NO_LIST_NOTE }]);
      expect(r.notes, format).toContain(
        "1 source was left out because it involves a participant and this project keeps no list of participants' names (it is not encrypted), so the app cannot tell which names to replace. Cite them by hand, or keep such sources in an encrypted project.",
      );
      expect(r.notes.join(" "), format).not.toContain("no participant code");
    }
    const second = (await addSource(kit, p, { type: "interview", title: "Interview 2", creators: [{ family: "Doe", given: "Ira", role: "interviewer" }] })).source.id;
    await kit.repo.linkSourceToFieldwork(p.id, second, { participantIds: [part.id] });
    const two = await exportRefman(kit.repo, p.id, [interview, second, lit], "ris");
    expect(two.notes).toContain(
      "2 sources were left out because they involve a participant and this project keeps no list of participants' names (it is not encrypted), so the app cannot tell which names to replace. Cite them by hand, or keep such sources in an encrypted project.",
    );
    const dest = join(kit.tmp, "out");
    await mkdir(dest, { recursive: true });
    const open = await exportProjectOpenFormats(kit.repo, p.id, dest);
    expect(open.notes.join(" ")).toMatch(/2 sources are not in sources\.bib and sources\.csl\.json because they involve a participant and this project keeps no list of participants' names/u);
    expect(open.notes.join(" ")).not.toContain("no participant code");
  });
});

describe("R390 (e): a coded source's plain key is made from its own id; a note says names were replaced by codes", () => {
  it("M1: the key is ref- and eight characters of the source's id, the same from one export to the next and whatever else is exported", async () => {
    const { p, post, repost, video } = await r390Project();
    const keyOf = (text: string, id: string) => JSON.parse(text).find((o: { id: string }) => o.id.startsWith("ref-") && o.id.includes(id.slice(-8)))?.id as string | undefined;
    const all = await exportRefman(kit.repo, p.id, [post, repost, video], "csl-json");
    const alone = await exportRefman(kit.repo, p.id, [video], "csl-json");
    for (const id of [post, repost, video]) expect(keyOf(all.text, id)).toBe(`ref-${id.slice(-8).toLowerCase()}`);
    expect(keyOf(alone.text, video)).toBe(`ref-${video.slice(-8).toLowerCase()}`);
    // The note that a key was withheld stays.
    expect(all.notes.join(" ")).toMatch(/citation keys were not exported because the source involves a participant \(a key is often made from a name\); a plain key was used instead\./u);
  });

  it("M3: when any source was coded or scrubbed, the notes say so, exactly; an export the rules do not touch has no such note", async () => {
    const { p, post, repost, video, book } = await r390Project();
    const lee = (await addSource(kit, p, { type: "book", title: "Other", creators: [{ family: "Lee", given: "Ann", role: "author" }], citationKey: "lee" })).source.id;
    // The book's only change is its withheld key (its own note): no name in it was replaced by a code.
    const many = await exportRefman(kit.repo, p.id, [post, repost, video, book, lee], "bibtex");
    expect(many.notes).toContain("In 3 sources participants' names were replaced by their codes.");
    const one = await exportRefman(kit.repo, p.id, [repost, lee], "ris");
    expect(one.notes).toContain("In 1 source participants' names were replaced by their codes.");
    const none = await exportRefman(kit.repo, p.id, [lee], "ris");
    expect(none.notes.join(" ")).not.toContain("replaced by their codes");
  });
});
