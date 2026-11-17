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
import { PARTICIPANT_CODE_MISSING_NOTE, exportRefman, type RefmanFormat } from "./refman-export.js";
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
      // The withheld key is replaced by one the writer makes, holding no name.
      expect(r.text, format).toContain("ref1");
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
