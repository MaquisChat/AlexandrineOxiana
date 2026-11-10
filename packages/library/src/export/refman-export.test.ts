import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BIBLIO_FIELDS, biblioOf, type Biblio, type BiblioField, type Creator, type Project, type Provenance, type SourceDraft, type SourceType } from "@ao/core";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import { PolicyDeniedError } from "../repo/errors.js";
import type { Repo } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import type { ImportSourceAdapter, ScanItem } from "../import/bulk/scan.js";
import { bibtexAdapter, cslJsonAdapter, parseBibtexEntries, risAdapter } from "../import/refman.js";
import { DEIDENTIFIED_NOTE, escapeBibtex, exportRefman, risLine, writeRefmanExport, type RefmanFormat } from "./refman-export.js";

const FAST = 2 ** 10;
let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;

const deps = (): Deps => ({
  clock: () => new Date(),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
});

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
captureMethods: [manual_upload, refman_import]
`;
const DEID_GOV = `identifiability:
  containsIdentifiable: true
  deidentifiedExportsOnly: true
  pseudonymizeFileNames: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
captureMethods: [manual_upload, refman_import]
`;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-export-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester" });
});

afterEach(async () => {
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

async function project(gov = GOV): Promise<Project> {
  return (await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: gov, encryption: { enabled: false } })).project;
}

const mt = (value: string) => ({ variants: [{ lang: "und", kind: "original" as const, value }] });

interface Ref {
  type: SourceType;
  title: string;
  creators: Creator[];
  issued?: string;
  container?: string;
  publisher?: string;
  identifiers?: SourceDraft["identifiers"];
  citationKey: string;
  identifiable?: boolean;
  biblio?: Biblio;
}

async function addSource(p: Project, r: Ref): Promise<string> {
  const draft: SourceDraft = {
    projectIds: [p.id],
    type: r.type,
    title: mt(r.title),
    creators: r.creators,
    ...(r.container ? { container: mt(r.container) } : {}),
    ...(r.publisher ? { publisher: r.publisher } : {}),
    ...(r.issued ? { issued: r.issued } : {}),
    ...(r.biblio ?? {}),
    identifiers: r.identifiers ?? {},
    citationKey: r.citationKey,
    caseAttributes: {},
    availability: { status: "available" },
    collectionIds: [],
    tagIds: [],
    participantIds: [],
  };
  const provenance: Provenance = {
    captureMethod: "refman_import",
    capturedAt: new Date().toISOString(),
    tool: { name: "test", version: "1" },
    fileHashes: {},
    legal: { status: "unknown", basis: "test basis" },
    identifiable: r.identifiable ?? false,
  };
  return (await repo.createSource(p.id, draft, [], { provenance })).source.id;
}

const REFS: Ref[] = [
  {
    type: "article-journal",
    title: "Feeding the City: Informal Markets in Lagos",
    creators: [
      { family: "Okafor", given: "Ngozi", role: "author" },
      { family: "van der Berg", given: "Jan Willem", role: "author" },
      { family: "Smith", given: "Ann", role: "editor" },
    ],
    issued: "2024-03-15",
    container: "Urban Studies",
    publisher: "Sage",
    identifiers: { doi: "10.5555/ao.urban.2024.017", issn: "0042-0980", url: "https://example.org/a?x=1&y=2" },
    citationKey: "okafor2024feeding",
    biblio: { volume: "61", issue: "4", page: "777-799" },
  },
  {
    type: "book",
    title: "Street Food and the State",
    creators: [{ family: "Adebayo", given: "Tunde", role: "author" }, { family: "Müller", given: "Jörg", role: "translator" }],
    issued: "2019",
    publisher: "Cambridge University Press",
    identifiers: { isbn: ["9780262033848"] },
    citationKey: "adebayo2019street",
    biblio: { edition: "2", numberOfPages: "312", publisherPlace: "Cambridge", collectionTitle: "African Studies", collectionNumber: "141" },
  },
  {
    type: "chapter",
    title: "Markets, Mobility & Memory",
    creators: [{ family: "Ìdòwú", given: "Ọlá", role: "author" }],
    issued: "2021-06",
    container: "Handbook of Urban Africa",
    citationKey: "idowu2021markets",
    biblio: { page: "45-67", publisherPlace: "London" },
  },
  {
    type: "report",
    title: "Trader Survey 2022",
    creators: [{ family: "Bello", given: "Amina", role: "author" }],
    issued: "2022",
    publisher: "Lagos Institute",
    citationKey: "bello2022trader",
    biblio: { number: "WP-17" },
  },
];

const adapters: Record<RefmanFormat, (p: string) => ImportSourceAdapter> = { bibtex: bibtexAdapter, ris: risAdapter, "csl-json": cslJsonAdapter };
const ext: Record<RefmanFormat, string> = { bibtex: "bib", ris: "ris", "csl-json": "json" };

async function readBack(format: RefmanFormat, text: string): Promise<ScanItem[]> {
  const path = join(tmp, `back.${ext[format]}`);
  await writeFile(path, text);
  const out: ScanItem[] = [];
  for await (const i of adapters[format](path).scan(new AbortController().signal)) out.push(i);
  return out;
}

/** The bibliographic fields each format carries (R87): RIS has no series number or page count. */
const BIBLIO_IN: Record<RefmanFormat, readonly BiblioField[]> = {
  bibtex: ["volume", "issue", "page", "edition", "numberOfPages", "publisherPlace", "collectionTitle", "collectionNumber", "number"],
  ris: ["volume", "issue", "page", "edition", "publisherPlace", "collectionTitle"],
  "csl-json": BIBLIO_FIELDS,
};
const biblioIn = (format: RefmanFormat, b: Biblio | undefined) => Object.fromEntries(BIBLIO_IN[format].flatMap((k) => (b?.[k] ? [[k, b[k]]] : [])));

/** The fields an export carries, as our adapters read them. */
const fieldsOf = (m: ScanItem["referenceMetadata"]) => ({
  type: m?.type,
  title: m?.title?.variants[0]?.value,
  creators: m?.creators,
  issued: m?.issued,
  container: m?.container?.variants[0]?.value,
  publisher: m?.publisher,
  identifiers: m?.identifiers ?? {},
  citationKey: m?.citationKey,
});
const expected = (r: Ref) => ({
  type: r.type,
  title: r.title,
  creators: r.creators,
  issued: r.issued,
  container: r.container,
  publisher: r.publisher,
  identifiers: r.identifiers ?? {},
  citationKey: r.citationKey,
});

describe("escaping", () => {
  it("BibTeX: braces, % & $ # _ { } ~ ^ \\ and -- survive our parser exactly", async () => {
    const nasty = 'Braces {nested} and 50% of $5 & #1_x ~ ^ \\ back -- dash --- "quoted" Ünïcödé @home';
    expect(escapeBibtex("{%}")).toBe("\\textbraceleft{}\\%\\textbraceright{}");
    const p = await project();
    const id = await addSource(p, { type: "article-journal", title: nasty, creators: [{ family: "O'Brien {Jr}", given: "Mary & Ann", role: "author" }], citationKey: "obrien" });
    const { text } = await exportRefman(repo, p.id, [id], "bibtex");
    // Balanced braces in every value; nothing unescaped.
    expect(text).not.toMatch(/[^\\]%/u);
    const [back] = await readBack("bibtex", text);
    expect(back!.referenceMetadata!.title!.variants[0]!.value).toBe(nasty);
    expect(back!.referenceMetadata!.creators).toEqual([{ family: "O'Brien {Jr}", given: "Mary & Ann", role: "author" }]);
    expect(back!.referenceMetadata!.citationKey).toBe("obrien");
  });

  it("BibTeX: brace depth is 0 at the end of every entry, and an @misc(...) injection yields exactly one entry", async () => {
    const p = await project();
    const injection = "x}, title = {pwned}}\n@misc(evil, title = {y}) {{{";
    const id = await addSource(p, {
      type: "article-journal",
      title: injection,
      creators: [{ family: "Brace } and {", given: "{Open", role: "author" }],
      container: "}}}",
      citationKey: "inj",
    });
    const id2 = await addSource(p, { ...REFS[0]!, citationKey: "second" });
    const { text } = await exportRefman(repo, p.id, [id, id2], "bibtex");
    // A plain brace-counting reader (no escape rules at all): depth returns to 0 after each entry.
    const entries: string[] = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "@" && depth === 0) start = i;
      if (c === "{") depth++;
      if (c === "}") {
        depth--;
        expect(depth).toBeGreaterThanOrEqual(0);
        if (depth === 0 && start >= 0) {
          entries.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
    expect(depth).toBe(0);
    expect(entries).toHaveLength(2);
    expect([...parseBibtexEntries(text)].map((e) => e.key)).toEqual(["inj", "second"]);
    const [back] = await readBack("bibtex", text);
    expect(back!.referenceMetadata!.title!.variants[0]!.value).toBe(injection.replace("\n", " "));
    expect(back!.referenceMetadata!.creators).toEqual([{ family: "Brace } and {", given: "{Open", role: "author" }]);
  });

  it("RIS: a value with an embedded newline and 'ER  -' cannot end the record or inject tags", async () => {
    expect(risLine("TI", "a\nER  - b\r\nTY  - JOUR")).toBe("TI  - a ER - b TY - JOUR");
    const p = await project();
    const id = await addSource(p, { type: "article-journal", title: "Line one\nER  - injected\nTY  - BOOK\nTI  - Fake", creators: [{ family: "Doe", given: "Jane", role: "author" }], citationKey: "doe" });
    const { text } = await exportRefman(repo, p.id, [id], "ris");
    expect(text.split("\n").filter((l) => l.startsWith("ER  -"))).toHaveLength(1);
    expect(text.split("\n").filter((l) => l.startsWith("TY  -"))).toHaveLength(1);
    const back = await readBack("ris", text);
    expect(back).toHaveLength(1);
    expect(back[0]!.referenceMetadata!.type).toBe("article-journal");
    expect(back[0]!.referenceMetadata!.title!.variants[0]!.value).toBe("Line one ER - injected TY - BOOK TI - Fake");
  });

  it("BibTeX pages: an en dash is written as -- and read back as an en dash; number is the issue of an article and the series number of a book", async () => {
    const p = await project();
    const a = await addSource(p, { ...REFS[0]!, citationKey: "a1", biblio: { volume: "61", issue: "4", page: "777–799" } });
    const b = await addSource(p, { ...REFS[1]!, citationKey: "b1" });
    const { text } = await exportRefman(repo, p.id, [a, b], "bibtex");
    expect(text).toContain("pages = {777--799}");
    expect(text).toMatch(/@article\{a1,[^@]*number = \{4\}/u);
    expect(text).toMatch(/@book\{b1,[^@]*number = \{141\}/u);
    const back = await readBack("bibtex", text);
    expect(back[0]!.referenceMetadata).toMatchObject({ volume: "61", issue: "4", page: "777–799" });
    expect(back[1]!.referenceMetadata).toMatchObject({ collectionTitle: "African Studies", collectionNumber: "141" });
    expect(back[1]!.referenceMetadata!.issue).toBeUndefined();
  });

  it("R88 minor: RIS splits a page range at an en dash or -- before a hyphen (A-1–A-9, S12--S19)", async () => {
    const p = await project();
    const a = await addSource(p, { ...REFS[0]!, citationKey: "r1", biblio: { page: "A-1–A-9" } });
    const b = await addSource(p, { ...REFS[0]!, citationKey: "r2", biblio: { page: "S12--S19" } });
    const { text } = await exportRefman(repo, p.id, [a, b], "ris");
    expect(text).toContain("SP  - A-1\nEP  - A-9");
    expect(text).toContain("SP  - S12\nEP  - S19");
  });

  it("R88 minor: a report's number is its BibTeX number (a techreport), not a series number", async () => {
    const p = await project();
    const id = await addSource(p, REFS[3]!);
    const { text } = await exportRefman(repo, p.id, [id], "bibtex");
    expect(text).toMatch(/@techreport\{bello2022trader,[^@]*number = \{WP-17\}/u);
    expect((await readBack("bibtex", text))[0]!.referenceMetadata).toMatchObject({ number: "WP-17" });
    expect((await readBack("bibtex", text))[0]!.referenceMetadata!.collectionNumber).toBeUndefined();
  });

  it("CSL-JSON is standard JSON (quotes, backslashes, control characters, U+2028)", async () => {
    const p = await project();
    const title = 'Quote " back \\ tab\t line sep';
    const id = await addSource(p, { type: "article-journal", title, creators: [], citationKey: "k" });
    const { text } = await exportRefman(repo, p.id, [id], "csl-json");
    const parsed = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(parsed[0]).toMatchObject({ id: "k", "citation-key": "k", type: "article-journal", title });
  });
});

describe("round trips through our adapters", () => {
  for (const format of ["bibtex", "ris", "csl-json"] as RefmanFormat[]) {
    it(`${format}: keys and fields are identical after export and import`, async () => {
      const p = await project();
      const ids: string[] = [];
      for (const r of REFS) ids.push(await addSource(p, r));
      const { text, exported, excluded } = await exportRefman(repo, p.id, ids, format);
      expect(exported).toBe(REFS.length);
      expect(excluded).toEqual([]);
      const back = await readBack(format, text);
      expect(back.map((i) => i.referenceMetadata?.citationKey)).toEqual(REFS.map((r) => r.citationKey));
      expect(back.map((i) => fieldsOf(i.referenceMetadata))).toEqual(REFS.map(expected));
      // R87: volume, issue, pages, edition, place, series … survive (what the format can hold).
      expect(back.map((i) => biblioOf(i.referenceMetadata))).toEqual(REFS.map((r) => biblioIn(format, r.biblio)));
    });
  }

  it("by default no file paths, notes, annotations or provenance are exported", async () => {
    const p = await project();
    const id = await addSource(p, REFS[0]!);
    for (const format of ["bibtex", "ris", "csl-json"] as RefmanFormat[]) {
      const { text } = await exportRefman(repo, p.id, [id], format);
      expect(text).not.toMatch(/\bfile\b|L1  -|refman_import|capturedAt|annotation|"note"/u);
      expect(text).not.toContain(lib.root);
    }
  });
});

describe("governance", () => {
  it("deidentified-only: identifiable sources are left out with a note, and the export is audited", async () => {
    const p = await project(DEID_GOV);
    const ok = await addSource(p, { ...REFS[0]!, identifiable: false });
    const ident = await addSource(p, { ...REFS[1]!, identifiable: true });
    const out = join(tmp, "out.bib");
    const r = await writeRefmanExport(repo, p.id, [ok, ident], "bibtex", out);
    expect(r.exported).toBe(1);
    expect(r.excluded).toEqual([{ sourceId: ident, reason: DEIDENTIFIED_NOTE }]);
    expect(r.notes.join(" ")).toMatch(/1 source was left out/u);
    const text = await readFile(out, "utf8");
    expect(text).toContain("okafor2024feeding");
    expect(text).not.toContain("adebayo2019street");
    const audit = (await Promise.all((await readdir(join(lib.root, p.folder, "audit"))).map((f) => readFile(join(lib.root, p.folder, "audit", f), "utf8")))).join("");
    expect(audit).toContain('"action":"export.refman"');
    expect(audit).not.toContain(out);
  });

  it("a governance denial refuses the export (audited) and writes nothing", async () => {
    const p = await project();
    const id = await addSource(p, REFS[0]!);
    await writeFile(join(lib.root, p.folder, "governance.yaml"), "identifiability: [not, valid\n");
    const out = join(tmp, "denied.ris");
    await expect(writeRefmanExport(repo, p.id, [id], "ris", out)).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(stat(out)).rejects.toThrow();
    const audit = (await Promise.all((await readdir(join(lib.root, p.folder, "audit"))).map((f) => readFile(join(lib.root, p.folder, "audit", f), "utf8")))).join("");
    expect(audit).toMatch(/"action":"export".*"result":"deny"/u);
  });

  it("the export is audited only after the file was written", async () => {
    const p = await project();
    const id = await addSource(p, REFS[0]!);
    await expect(writeRefmanExport(repo, p.id, [id], "bibtex", join(tmp, "no-such-folder", "x.bib"))).rejects.toThrow();
    const audit = (await Promise.all((await readdir(join(lib.root, p.folder, "audit"))).map((f) => readFile(join(lib.root, p.folder, "audit", f), "utf8")))).join("");
    expect(audit).not.toContain('"action":"export.refman"');
  });

  it("writes atomically: an existing file is replaced whole, and no temp file is left", async () => {
    const p = await project();
    const id = await addSource(p, REFS[0]!);
    const out = join(tmp, "refs.json");
    await writeFile(out, "old contents");
    await writeRefmanExport(repo, p.id, [id], "csl-json", out);
    expect(JSON.parse(await readFile(out, "utf8"))).toHaveLength(1);
    expect((await readdir(tmp)).filter((n) => n.startsWith("refs.json") && n !== "refs.json")).toEqual([]);
  });

  it("duplicate or unusable citation keys are made valid and unique, with a note", async () => {
    const p = await project();
    const a = await addSource(p, { ...REFS[0]!, citationKey: "same key" });
    const b = await addSource(p, { ...REFS[1]!, citationKey: "same_key" });
    const r = await exportRefman(repo, p.id, [a, b], "bibtex");
    const keys = (await readBack("bibtex", r.text)).map((i) => i.referenceMetadata?.citationKey);
    expect(new Set(keys).size).toBe(2);
    expect(r.notes.join(" ")).toMatch(/citation key/u);
  });
});
