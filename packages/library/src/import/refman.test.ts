import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@ao/core";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { buildCalibreLibrary } from "../../tests/fixtures/refman/calibre.mjs";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { shutdownExtractors } from "../extract/index.js";
import { IndexHandle } from "../index/db.js";
import { createIndexSink } from "../index/sink.js";
import { createLibrary, type Library } from "../library.js";
import { HttpClient } from "../lookup/index.js";
import type { Repo } from "../repo/repo.js";
import { projectCollectionsAndTags } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import { approvedFolders } from "./approved-folders.js";
import { adapterFor, createBulkImport, folderAdapter, type ImportSourceAdapter, type ScanContext, type ScanItem } from "./bulk/index.js";
import { CALIBRE_FILE_NOTE, MAX_CALIBRE_DB_BYTES, calibreAdapter, copyCalibreDb } from "./calibre.js";
import { FILE_NOTES, MAX_EXPORT_BYTES, MAX_FIELD_CHARS, bibtexAdapter, cslJsonAdapter, risAdapter } from "./refman.js";
import { zoteroRdfAdapter } from "./zotero-rdf.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/refman");
const MB = 1024 * 1024;

let tmp: string;
let exp: string;
let work: string;
let ctx: ScanContext;
let pdfs: Record<string, Buffer>;

async function collect(a: ImportSourceAdapter, c: ScanContext | undefined = ctx, signal = new AbortController().signal): Promise<ScanItem[]> {
  const out: ScanItem[] = [];
  for await (const i of a.scan(signal, c)) out.push(i);
  return out;
}

const title = (i: ScanItem | undefined) => i?.referenceMetadata?.title?.variants[0]?.value;
const byTitle = (items: ScanItem[], t: string) => items.find((i) => title(i) === t);
const OKAFOR = "Feeding the City: Informal Markets in Lagos";
const OKAFOR_CREATORS = [
  { family: "Okafor", given: "Ngozi", role: "author" },
  { family: "Müller", given: "Jan", role: "author" },
];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-refman-"));
  exp = join(tmp, "export");
  cpSync(FIX, exp, { recursive: true });
  work = join(tmp, "Lib", ".tmp", "batch-test");
  ctx = {
    workDir: async () => {
      await mkdir(work, { recursive: true, mode: 0o700 });
      return work;
    },
  };
  pdfs = {
    "files/okafor2024feeding.pdf": await buildPdf({ extra: "okafor" }),
    "files/adebayo2019markets.pdf": await buildPdf({ extra: "adebayo" }),
    "files/adebayo-notes.pdf": await buildPdf({ extra: "adebayo notes" }),
    "files/13/okafor2024feeding.pdf": await buildPdf({ extra: "okafor rdf" }),
    "files/15/adebayo2019markets.pdf": await buildPdf({ extra: "adebayo rdf" }),
  };
  for (const [rel, bytes] of Object.entries(pdfs)) {
    await mkdir(dirname(join(exp, rel)), { recursive: true });
    await writeFile(join(exp, rel), bytes);
  }
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

afterAll(async () => {
  await shutdownExtractors();
});

/** Runs `fn` and returns how long it took, in ms. */
async function timed(fn: () => Promise<unknown>): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

async function writeExport(name: string, text: string): Promise<string> {
  const p = join(exp, name);
  await writeFile(p, text);
  return p;
}

describe("bibtexAdapter", () => {
  it("yields every entry with titles, creators, citation keys and resolved files", async () => {
    const items = await collect(bibtexAdapter(join(exp, "sample.bib")));
    expect(items).toHaveLength(4);
    expect(items.map(title)).toEqual([OKAFOR, "Markets and Memory", "A Chapter Whose File Is Gone", "Metadata Only"]);

    const ok = items[0]!;
    expect(ok.unreadable).toBeUndefined();
    expect(ok.referenceMetadata?.creators).toEqual(OKAFOR_CREATORS);
    expect(ok.referenceMetadata?.type).toBe("article-journal");
    expect(ok.referenceMetadata?.container?.variants[0]?.value).toBe("Journal of Urban Studies"); // @string macro
    expect(ok.referenceMetadata?.issued).toBe("2024");
    expect(ok.referenceMetadata?.identifiers?.doi).toBe("10.5555/ao.urban.2024.017");
    expect(ok.referenceMetadata?.citationKey).toBe("okafor2024feeding");
    expect(ok.externalKeys).toEqual({ citekey: "okafor2024feeding" });
    expect(ok.tags).toEqual(["food systems", "Lagos"]);
    expect(ok.files).toEqual([{ path: join(exp, "files/okafor2024feeding.pdf"), mime: "application/pdf", bytes: pdfs["files/okafor2024feeding.pdf"]!.length }]);
    expect(ok.key).toContain("okafor2024feeding");

    const book = items[1]!;
    expect(book.referenceMetadata?.type).toBe("book");
    expect(book.referenceMetadata?.creators).toEqual([{ family: "Adebayo", given: "Tunde", role: "author" }]);
    expect(book.referenceMetadata?.identifiers?.isbn).toEqual(["9780262033848"]);
    expect(book.referenceMetadata?.publisher).toBe("Ibadan University Press");
    // ";"-separated Zotero/JabRef file list
    expect(book.files.map((f) => f.path)).toEqual([join(exp, "files/adebayo2019markets.pdf"), join(exp, "files/adebayo-notes.pdf")]);

    expect(items[3]!.referenceMetadata?.creators).toEqual([{ literal: "World Health Organization", role: "author" }]);
    expect(items[3]!.files).toEqual([]);
    expect(items[3]!.unreadable).toBeUndefined();
  });

  it("a missing linked file keeps the reference (metadata only) with a file note, not a crash", async () => {
    const items = await collect(bibtexAdapter(join(exp, "sample.bib")));
    const gone = items[2]!;
    expect(gone.key).toContain("doe2020missing");
    expect(gone.files).toEqual([]);
    expect(gone.unreadable).toBeUndefined();
    expect(gone.fileNotes).toEqual([FILE_NOTES.missing]);
    expect(title(gone)).toBe("A Chapter Whose File Is Gone");
    expect(gone.referenceMetadata?.citationKey).toBe("doe2020missing");
  });

  it("keys are stable across scans, unique, and differ for another export file", async () => {
    const a = (await collect(bibtexAdapter(join(exp, "sample.bib")))).map((i) => i.key);
    const b = (await collect(bibtexAdapter(join(exp, "sample.bib")))).map((i) => i.key);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    await mkdir(join(tmp, "other"));
    cpSync(join(exp, "sample.bib"), join(tmp, "other", "sample.bib"));
    const c = (await collect(bibtexAdapter(join(tmp, "other", "sample.bib")))).map((i) => i.key);
    expect(c.some((k) => a.includes(k))).toBe(false);
  });

  it("resolves absolute file paths, Windows-escaped JabRef paths and file: URLs; duplicate and missing keys stay unique", async () => {
    const abs = join(exp, "files/okafor2024feeding.pdf");
    const p = await writeExport(
      "abs.bib",
      [
        `@article{a1, title={Absolute}, file={${abs}}}`,
        `@article{a1, title={Same Key}, file={PDF:${abs.replaceAll(":", "\\:")}:PDF}}`,
        `@article{, title={No Key}, file={${pathToFileURL(abs).href}}}`,
        `@article{w1, title={Windows}, file={:C\\:\\\\Users\\\\x\\\\paper.pdf:PDF}}`,
      ].join("\n"),
    );
    const items = await collect(bibtexAdapter(p));
    expect(items.map(title)).toEqual(["Absolute", "Same Key", "No Key", "Windows"]);
    expect(items[0]!.files.map((f) => f.path)).toEqual([abs]);
    expect(items[1]!.files.map((f) => f.path)).toEqual([abs]);
    expect(items[2]!.files.map((f) => f.path)).toEqual([abs]);
    expect(items[3]!.unreadable).toBeUndefined();
    expect(items[3]!.fileNotes).toEqual([FILE_NOTES.missing]);
    expect(new Set(items.map((i) => i.key)).size).toBe(4);
  });

  it("an entry with one present and one missing file keeps the present one and notes the other", async () => {
    const p = await writeExport("partial.bib", "@article{p, title={Partial}, file={A:files/okafor2024feeding.pdf:PDF;B:files/nope.pdf:PDF}}");
    const [i] = await collect(bibtexAdapter(p));
    expect(i!.unreadable).toBeUndefined();
    expect(i!.files.map((f) => f.path)).toEqual([join(exp, "files/okafor2024feeding.pdf")]);
    expect(i!.fileNotes).toEqual([FILE_NOTES.missing]);
  });

  it.skipIf(process.platform === "win32")("only regular files are attached: directories and FIFOs get a file note", async () => {
    execFileSync("mkfifo", [join(exp, "files", "pipe.pdf")]);
    await symlink(join(exp, "files", "pipe.pdf"), join(exp, "files", "link-to-pipe.pdf"));
    const p = await writeExport(
      "special.bib",
      ["@misc{dir, title={Dir}, file={files}}", "@misc{fifo, title={Fifo}, file={files/pipe.pdf}}", "@misc{lnk, title={Link}, file={files/link-to-pipe.pdf}}"].join("\n"),
    );
    const items = await collect(bibtexAdapter(p));
    expect(items).toHaveLength(3);
    for (const i of items) {
      expect(i.files).toEqual([]);
      expect(i.unreadable).toBeUndefined();
      expect(i.fileNotes).toEqual([FILE_NOTES.notRegular]);
    }
  });

  it("recovers after an unterminated entry and caps every field at 64 KB", async () => {
    const long = "x".repeat(MAX_FIELD_CHARS * 3);
    const p = await writeExport("bad.bib", `@article{broken, title={Never closed\n@book{fine, title={Fine Book}, note={${long}}, abstract={${long}}}\n@misc{big, title={${long}}}\n`);
    const items = await collect(bibtexAdapter(p));
    expect(items.map((i) => i.key.split("#").pop())).toEqual(["broken", "fine", "big"]);
    expect(title(items[1])).toBe("Fine Book");
    expect(title(items[2])!.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
  });

  it("decodes LaTeX accents and commands", async () => {
    const p = await writeExport("tex.bib", "@article{t, title={Caf{\\'e} \\emph{na\\\"{i}ve} \\& {\\ss}tra{\\ss}e --- {\\o}re}, author={{\\v{S}}koda, {\\AA}sa and von Beethoven, Ludwig and Jean de la Fontaine}}");
    const [i] = await collect(bibtexAdapter(p));
    expect(title(i)).toBe("Café naïve & ßtraße — øre");
    expect(i!.referenceMetadata?.creators).toEqual([
      { family: "Škoda", given: "Åsa", role: "author" },
      { family: "von Beethoven", given: "Ludwig", role: "author" },
      { family: "de la Fontaine", given: "Jean", role: "author" },
    ]);
  });

  it("an export over 100 MB, or one that is not a file, is one unreadable item", async () => {
    const p = join(exp, "huge.bib");
    const fh = await open(p, "w");
    await fh.truncate(MAX_EXPORT_BYTES + 1); // sparse
    await fh.close();
    const items = await collect(bibtexAdapter(p));
    expect(items).toHaveLength(1);
    expect(items[0]!.unreadable).toMatch(/too large/);
    const dirItems = await collect(bibtexAdapter(join(exp, "files")));
    expect(dirItems).toHaveLength(1);
    expect(dirItems[0]!.unreadable).toMatch(/could not be read/);
  });
});

describe("risAdapter", () => {
  it("yields every record with titles, creators, citation keys and resolved files", async () => {
    const items = await collect(risAdapter(join(exp, "sample.ris")));
    expect(items.map(title)).toEqual([OKAFOR, "Markets and Memory", "A Chapter Whose File Is Gone"]);
    const ok = items[0]!;
    expect(ok.referenceMetadata?.creators).toEqual(OKAFOR_CREATORS);
    expect(ok.referenceMetadata?.citationKey).toBe("okafor2024feeding");
    expect(ok.externalKeys).toEqual({ citekey: "okafor2024feeding" });
    expect(ok.referenceMetadata?.identifiers?.doi).toBe("10.5555/ao.urban.2024.017");
    expect(ok.referenceMetadata?.container?.variants[0]?.value).toBe("Journal of Urban Studies");
    expect(ok.tags).toEqual(["food systems", "Lagos"]);
    expect(ok.files.map((f) => f.path)).toEqual([join(exp, "files/okafor2024feeding.pdf")]);
    expect(items[1]!.referenceMetadata?.identifiers).toMatchObject({ isbn: ["9780262033848"], url: "https://example.org/markets" });
    expect(items[1]!.files.map((f) => f.path)).toEqual([join(exp, "files/adebayo2019markets.pdf")]);
    expect(items[2]!.referenceMetadata?.type).toBe("chapter");
    expect(items[2]!.unreadable).toBeUndefined();
    expect(items[2]!.fileNotes).toEqual([FILE_NOTES.missing]);
  });

  it("reads file: URLs and continuation lines", async () => {
    const abs = join(exp, "files/okafor2024feeding.pdf");
    const p = await writeExport("u.ris", `TY  - JOUR\r\nTI  - A title that\r\n  goes on\r\nL1  - ${pathToFileURL(abs).href}\r\nL2  - https://example.org/x.pdf\r\nER  - \r\n`);
    const [i] = await collect(risAdapter(p));
    expect(title(i)).toBe("A title that goes on");
    expect(i!.files.map((f) => f.path)).toEqual([abs]);
  });
});

describe("cslJsonAdapter", () => {
  it("yields every item with titles, creators, citation keys and resolved files", async () => {
    const items = await collect(cslJsonAdapter(join(exp, "sample.json")));
    expect(items.map(title)).toEqual([OKAFOR, "Markets and Memory", "A Chapter Whose File Is Gone"]);
    const ok = items[0]!;
    expect(ok.referenceMetadata?.creators).toEqual(OKAFOR_CREATORS);
    expect(ok.referenceMetadata?.issued).toBe("2024-03");
    expect(ok.referenceMetadata?.citationKey).toBe("okafor2024feeding");
    expect(ok.externalKeys).toEqual({ citekey: "okafor2024feeding" });
    expect(ok.tags).toEqual(["food systems", "Lagos"]);
    expect(ok.files.map((f) => f.path)).toEqual([join(exp, "files/okafor2024feeding.pdf")]);
    expect(items[1]!.referenceMetadata?.issued).toBe("2019");
    expect(items[1]!.files.map((f) => f.path)).toEqual([join(exp, "files/adebayo2019markets.pdf")]);
    expect(items[2]!.referenceMetadata?.issued).toBe("2020");
    expect(items[2]!.unreadable).toBeUndefined();
    expect(items[2]!.fileNotes).toEqual([FILE_NOTES.missing]);
  });

  it("an export that is not valid CSL-JSON is one unreadable item", async () => {
    const items = await collect(cslJsonAdapter(await writeExport("bad.json", "{ not json")));
    expect(items).toHaveLength(1);
    expect(items[0]!.unreadable).toMatch(/could not be read/);
  });
});

describe("zoteroRdfAdapter", () => {
  it("maps articles, books and book sections with attachments, tags and collections", async () => {
    const items = await collect(zoteroRdfAdapter(join(exp, "sample.rdf")));
    expect(items.map(title)).toEqual([OKAFOR, "Markets and Memory", "A Chapter Whose File Is Gone"]);

    const ok = items[0]!;
    expect(ok.referenceMetadata?.type).toBe("article-journal");
    expect(ok.referenceMetadata?.creators).toEqual(OKAFOR_CREATORS);
    expect(ok.referenceMetadata?.issued).toBe("2024-03");
    expect(ok.referenceMetadata?.container?.variants[0]?.value).toBe("Journal of Urban Studies");
    expect(ok.referenceMetadata?.identifiers).toMatchObject({ doi: "10.5555/ao.urban.2024.017", issn: "1234-5678" });
    expect(ok.referenceMetadata?.citationKey).toBe("okafor2024feeding");
    expect(ok.externalKeys).toMatchObject({ citekey: "okafor2024feeding" });
    expect(ok.tags).toEqual(["food systems", "Lagos"]);
    expect(ok.folderPath).toEqual(["Urban", "Food"]);
    expect(ok.files.map((f) => f.path)).toEqual([join(exp, "files/13/okafor2024feeding.pdf")]);

    const book = items[1]!;
    expect(book.referenceMetadata?.type).toBe("book");
    expect(book.referenceMetadata?.creators).toEqual([{ family: "Adebayo", given: "Tunde", role: "author" }]);
    expect(book.referenceMetadata?.publisher).toBe("Ibadan University Press");
    expect(book.referenceMetadata?.identifiers?.isbn).toEqual(["9780262033848"]);
    expect(book.folderPath).toEqual(["Urban"]);
    expect(book.files.map((f) => f.path)).toEqual([join(exp, "files/15/adebayo2019markets.pdf")]);

    const chap = items[2]!;
    expect(chap.referenceMetadata?.type).toBe("chapter");
    expect(chap.referenceMetadata?.container?.variants[0]?.value).toBe("Collected Essays");
    expect(chap.referenceMetadata?.creators).toEqual([
      { family: "Doe", given: "Jane", role: "author" },
      { family: "Roe", given: "Richard", role: "editor" },
    ]);
    expect(chap.folderPath ?? []).toEqual([]);
    expect(chap.unreadable).toBeUndefined();
    expect(chap.fileNotes).toEqual([FILE_NOTES.missing]);
    expect(new Set(items.map((i) => i.key)).size).toBe(3);
  });

  it("a stand-alone attachment is its own item", async () => {
    const text = (await readFile(join(exp, "sample.rdf"), "utf8")).replace(
      "</rdf:RDF>",
      `<z:Attachment rdf:about="#item_99"><z:itemType>attachment</z:itemType><rdf:resource rdf:resource="files/okafor2024feeding.pdf"/><dc:title>Loose PDF</dc:title></z:Attachment></rdf:RDF>`,
    );
    const items = await collect(zoteroRdfAdapter(await writeExport("loose.rdf", text)));
    expect(items.map(title)).toContain("Loose PDF");
    expect(byTitle(items, "Loose PDF")!.files.map((f) => f.path)).toEqual([join(exp, "files/okafor2024feeding.pdf")]);
  });

  it("refuses a DOCTYPE or ENTITY declaration before parsing (no entity expansion)", async () => {
    const base = await readFile(join(exp, "sample.rdf"), "utf8");
    const bomb = base.replace(
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<?xml version="1.0"?>\n<!DOCTYPE rdf:RDF [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>',
    ).replace("<dc:title>Markets and Memory</dc:title>", "<dc:title>&c;</dc:title>");
    for (const text of [bomb, base.replace("<rdf:RDF", '<!doctype rdf:RDF SYSTEM "file:///etc/passwd">\n<rdf:RDF'), base.replace("<rdf:RDF", "<!ENTITY x 'y'>\n<rdf:RDF")]) {
      const items = await collect(zoteroRdfAdapter(await writeExport("bomb.rdf", text)));
      expect(items).toHaveLength(1);
      expect(items[0]!.files).toEqual([]);
      expect(items[0]!.unreadable).toMatch(/document type or entity declaration/);
    }
  });

  it("an export that is not well-formed XML is one unreadable item", async () => {
    const items = await collect(zoteroRdfAdapter(await writeExport("bad.rdf", "<rdf:RDF><bib:Book>")));
    expect(items).toHaveLength(1);
    expect(items[0]!.unreadable).toMatch(/could not be read/);
  });
});

describe("calibreAdapter", () => {
  let calibre: ReturnType<typeof buildCalibreLibrary>;
  beforeEach(async () => {
    calibre = buildCalibreLibrary(join(tmp, "Calibre Library"), { pdf: pdfs["files/okafor2024feeding.pdf"]!, epub: pdfs["files/adebayo-notes.pdf"]! });
  });
  const sha = async (p: string) => createHash("sha256").update(await readFile(p)).digest("hex");

  it("joins books, authors, identifiers, tags and format files; refuses paths outside the library", async () => {
    const before = await sha(calibre.db);
    const items = await collect(calibreAdapter(calibre.dir));
    expect(items).toHaveLength(6);
    expect(items.map(title)).toEqual(["Feeding the City", "Markets and Memory", "Outside the Library", "Absolute Path", "Sneaky Name", "Lost Format"]);

    const ok = items[0]!;
    expect(ok.unreadable).toBeUndefined();
    expect(ok.referenceMetadata?.type).toBe("book");
    expect(ok.referenceMetadata?.creators).toEqual(OKAFOR_CREATORS);
    expect(ok.referenceMetadata?.issued).toBe("2024-03-01");
    expect(ok.referenceMetadata?.identifiers).toMatchObject({ isbn: ["9780262033848"], doi: "10.5555/ao.urban.2024.017" });
    expect(ok.tags).toEqual(["food systems", "Lagos"]);
    expect(ok.externalKeys).toEqual({ "calibre-book": "1", "calibre-uuid": "11111111-1111-4111-8111-111111111111" });
    expect(ok.files.map((f) => f.path).sort()).toEqual([calibre.okaforEpub, calibre.okaforPdf].sort());
    expect(ok.key).toMatch(/#book-1$/);

    expect(items[1]!.files).toEqual([]);
    expect(items[1]!.unreadable).toBeUndefined();
    expect(items[1]!.referenceMetadata?.issued).toBe("2019-01-01");
    expect(items[2]!.referenceMetadata?.issued).toBeUndefined(); // Calibre's "undefined" date
    for (const i of items.slice(2, 5)) {
      // Traversal: the format file is skipped with a note; the book's metadata still imports.
      expect(i.files).toEqual([]);
      expect(i.unreadable).toBeUndefined();
      expect(i.fileNotes).toEqual([CALIBRE_FILE_NOTE]);
      expect(i.referenceMetadata?.title).toBeDefined();
    }
    expect(items[5]!.unreadable).toBeUndefined();
    expect(items[5]!.fileNotes).toEqual([FILE_NOTES.missing]);

    // Original untouched; the private copy is gone.
    expect(await sha(calibre.db)).toBe(before);
    expect(await readdir(work)).toEqual([]);
    // Stable keys.
    expect((await collect(calibreAdapter(calibre.dir))).map((i) => i.key)).toEqual(items.map((i) => i.key));
  });

  it("copies metadata.db into a private (0700) folder under the work folder", async () => {
    const copy = await copyCalibreDb(calibre.dir, await ctx.workDir());
    try {
      expect(dirname(copy.path).startsWith(work)).toBe(true);
      if (process.platform !== "win32") expect((await stat(dirname(copy.path))).mode & 0o777).toBe(0o700);
      expect(await sha(copy.path)).toBe(await sha(calibre.db));
    } finally {
      await copy.remove();
    }
    expect(await readdir(work)).toEqual([]);
  });

  it("deletes the copy when the scan is cancelled", async () => {
    const ac = new AbortController();
    const it = calibreAdapter(calibre.dir).scan(ac.signal, ctx)[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    ac.abort();
    await expect(it.next()).rejects.toThrow();
    expect(await readdir(work)).toEqual([]);
  });

  it("a missing or damaged metadata.db, or no work folder, is one unreadable item and leaves nothing behind", async () => {
    await writeFile(calibre.db, "not a database");
    const damaged = await collect(calibreAdapter(calibre.dir));
    expect(damaged).toHaveLength(1);
    expect(damaged[0]!.unreadable).toMatch(/Calibre library could not be read/);
    expect(await readdir(work)).toEqual([]);
    await rm(calibre.db);
    expect((await collect(calibreAdapter(calibre.dir)))[0]!.unreadable).toMatch(/Calibre library could not be read/);
    expect((await collect(calibreAdapter(calibre.dir), undefined))[0]!.unreadable).toMatch(/Calibre library could not be read/);
  });
});

describe("review round 1: parser budgets and edge cases (R68)", () => {
  const heapGrowth = async (fn: () => Promise<unknown>) => {
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed)), 5);
    try {
      await fn();
    } finally {
      clearInterval(timer);
    }
    return Math.max(peak, process.memoryUsage().heapUsed) - before;
  };

  it("C1: a @string doubling chain and repeated big macros make the file unreadable without exhausting memory", async () => {
    const chain = ['@string{a0 = "' + "x".repeat(1000) + '"}'];
    for (let i = 1; i <= 7; i++) chain.push(`@string{a${i} = a${i - 1} # a${i - 1}}`);
    chain.push("@string{big = a7 # a7 # a7 # a7 # a7 # a7 # a7 # a7}");
    for (let k = 0; k < 20_000; k++) chain.push(`@string{c${k} = big # "y"}`);
    chain.push("@article{k, title={After}}");
    const p = await writeExport("chain.bib", chain.join("\n"));
    let items: ScanItem[] = [];
    const grew = await heapGrowth(async () => {
      items = await collect(bibtexAdapter(p));
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.unreadable).toMatch(/too large to import safely/);
    expect(grew).toBeLessThan(200 * MB);
  });

  it("C1: an entry with very many (unknown) fields expanding a big macro is skipped field by field, without exhausting memory", async () => {
    const parts = ['@string{big = "' + "x".repeat(60_000) + '"}', "@misc{k, title={Many Fields}"];
    for (let i = 0; i < 100_000; i++) parts.push(`, f${i} = big`);
    parts.push("}");
    const p = await writeExport("fields.bib", parts.join(""));
    let items: ScanItem[] = [];
    const grew = await heapGrowth(async () => {
      items = await collect(bibtexAdapter(p));
    });
    expect(items.map(title)).toEqual(["Many Fields"]);
    expect(grew).toBeLessThan(200 * MB);
  });

  it("C1: known fields expanding big macros in many entries exceed the per-file budget: unreadable", async () => {
    const parts = ['@string{big = "' + "x".repeat(60_000) + '"}'];
    for (let i = 0; i < 1000; i++) parts.push(`@misc{k${i}, title = big, note = big, abstract = big, url = big, publisher = big}`);
    const items = await collect(bibtexAdapter(await writeExport("budget.bib", parts.join("\n"))));
    expect(items).toHaveLength(1);
    expect(items[0]!.unreadable).toMatch(/too large to import safely/);
  });

  it("BibTeX recovery copes with a backslash before a newline and with lone CR line endings", async () => {
    const bs = await writeExport("bs.bib", "@article{a, title={Ends in a backslash \\\n@article{b, title={Next}}\n");
    expect((await collect(bibtexAdapter(bs))).map(title)).toEqual(["Ends in a backslash", "Next"]);
    const cr = await writeExport("cr.bib", "@article{a, title={Unclosed\r@article{b, title={Second}}\r@article{c,\r  title={Third}\r}\r");
    expect((await collect(bibtexAdapter(cr))).map(title)).toEqual(["Unclosed", "Second", "Third"]);
  });

  it("RIS handles lone CR line endings", async () => {
    const p = await writeExport("cr.ris", "TY  - JOUR\rTI  - First\rER  - \rTY  - BOOK\rTI  - Second\rER  - \r");
    expect((await collect(risAdapter(p))).map(title)).toEqual(["First", "Second"]);
  });

  it("decodes UTF-16 with a BOM; text that cannot be decoded, or yields no references, is unreadable", async () => {
    const bib = "@article{u, title={Ünïcode Title}}\n";
    const le = join(exp, "le.bib");
    await writeFile(le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(bib, "utf16le")]));
    expect((await collect(bibtexAdapter(le))).map(title)).toEqual(["Ünïcode Title"]);
    const be = join(exp, "be.ris");
    const beBody = Buffer.from("TY  - JOUR\nTI  - Big Endian\nER  - \n", "utf16le").swap16();
    await writeFile(be, Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]));
    expect((await collect(risAdapter(be))).map(title)).toEqual(["Big Endian"]);
    const bad = join(exp, "bad.bib");
    await writeFile(bad, Buffer.from([0x40, 0x61, 0x7b, 0x6b, 0x2c, 0x74, 0x3d, 0x7b, 0xc3, 0x28, 0x7d, 0x7d]));
    const badItems = await collect(bibtexAdapter(bad));
    expect(badItems).toHaveLength(1);
    expect(badItems[0]!.unreadable).toMatch(/not in a text encoding/);
    // UTF-16 without a BOM looks like text with NULs: no references found, never silently 0 items.
    const nobom = join(exp, "nobom.bib");
    await writeFile(nobom, Buffer.from("@article{a, title={Plain ASCII}}\n", "utf16le"));
    const none = await collect(bibtexAdapter(nobom));
    expect(none).toHaveLength(1);
    expect(none[0]!.unreadable).toMatch(/no references/);
  });

  it("file fields: colon in a path, Windows backslashes in CSL, Mendeley's form, file://server and %2F", async () => {
    await writeFile(join(exp, "files", "a:b.pdf"), pdfs["files/okafor2024feeding.pdf"]!);
    const abs = join(exp, "files/okafor2024feeding.pdf");
    const bib = await writeExport(
      "colon.bib",
      [
        "@misc{colon, title={Colon}, file={files/a:b.pdf}}",
        `@misc{mendeley, title={Mendeley}, file={:${abs.slice(1)}:pdf}}`,
        "@misc{server, title={Server}, file={file://server/share/x.pdf}}",
        "@misc{enc, title={Encoded}, file={file:///tmp/a%2Fb.pdf}}",
      ].join("\n"),
    );
    const items = await collect(bibtexAdapter(bib));
    expect(items[0]!.files.map((f) => f.path)).toEqual([join(exp, "files", "a:b.pdf")]);
    expect(items[1]!.files.map((f) => f.path)).toEqual([abs]);
    expect(items[2]!.fileNotes).toEqual([FILE_NOTES.location]);
    expect(items[3]!.fileNotes).toEqual([FILE_NOTES.location]);
    const csl = await writeExport("win.json", JSON.stringify([{ id: "w", title: "Win", file: "files\\okafor2024feeding.pdf" }]));
    expect((await collect(cslJsonAdapter(csl)))[0]!.files.map((f) => f.path)).toEqual([abs]);
  });

  it("CSL file arrays respect MAX_FILES across every string", async () => {
    const files = Array.from({ length: 30 }, (_, i) => `files/m${i}a.pdf;files/m${i}b.pdf`);
    const [i] = await collect(cslJsonAdapter(await writeExport("many.json", JSON.stringify([{ id: "m", title: "Many", file: files }]))));
    expect(i!.fileNotes).toHaveLength(50);
  });

  it("RDF: a very long rdf:about is hashed into the key; LCC/DDC/UDC subjects are not tags", async () => {
    const about = `#${"x".repeat(1000)}`;
    const text = (await readFile(join(exp, "sample.rdf"), "utf8"))
      .replace('rdf:about="#item_20"', `rdf:about="${about}"`)
      .replace("<dc:subject>food systems</dc:subject>", "<dc:subject>food systems</dc:subject><dc:subject><dcterms:LCC><rdf:value>HD9000</rdf:value></dcterms:LCC></dc:subject><dc:subject><dcterms:DDC><rdf:value>338.1</rdf:value></dcterms:DDC></dc:subject><dc:subject><dcterms:UDC><rdf:value>63</rdf:value></dcterms:UDC></dc:subject>");
    const items = await collect(zoteroRdfAdapter(await writeExport("long.rdf", text)));
    expect(items[0]!.tags).toEqual(["food systems", "Lagos"]);
    const chap = byTitle(items, "A Chapter Whose File Is Gone")!;
    expect(chap.key.length).toBeLessThan(200);
    expect(chap.key).not.toContain("xxxxxxxx");
  });

  it("empty records are skipped in every format and the count is reported", async () => {
    const notes: string[] = [];
    const c: ScanContext = { workDir: ctx.workDir, note: (t) => notes.push(t) };
    const bib = await writeExport("empty.bib", "@misc{e1, note={nothing}}\n@misc{e2}\n@misc{ok, title={Kept}}\n");
    expect((await collect(bibtexAdapter(bib), c)).map(title)).toEqual(["Kept"]);
    const ris = await writeExport("empty.ris", "TY  - JOUR\nN1  - nothing\nER  - \nTY  - JOUR\nTI  - Kept\nER  - \n");
    expect((await collect(risAdapter(ris), c)).map(title)).toEqual(["Kept"]);
    const csl = await writeExport("empty.json", JSON.stringify([{ id: "e" }, { id: "k", title: "Kept" }]));
    expect((await collect(cslJsonAdapter(csl), c)).map(title)).toEqual(["Kept"]);
    const rdf = (await readFile(join(exp, "sample.rdf"), "utf8")).replace("</rdf:RDF>", '<bib:Book rdf:about="#empty"><z:itemType>book</z:itemType></bib:Book></rdf:RDF>');
    expect(await collect(zoteroRdfAdapter(await writeExport("empty.rdf", rdf)), c)).toHaveLength(3);
    expect(notes).toEqual([
      "2 references had no title, creators, identifiers or files and were skipped.",
      "1 reference had no title, creators, identifiers or files and was skipped.",
      "1 reference had no title, creators, identifiers or files and was skipped.",
      "1 reference had no title, creators, identifiers or files and was skipped.",
    ]);
  });
});

describe("review round 1: Calibre reads (R68 I1)", () => {
  let calibre: ReturnType<typeof buildCalibreLibrary>;
  beforeEach(async () => {
    calibre = buildCalibreLibrary(join(tmp, "Calibre Library"), { pdf: pdfs["files/okafor2024feeding.pdf"]! });
  });

  it("a view in place of a table (e.g. a recursive CTE named books) is refused promptly", async () => {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(calibre.db);
    db.exec("ALTER TABLE books RENAME TO books_real; CREATE VIEW books AS WITH RECURSIVE r(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM r) SELECT id, 'x' AS title, '' AS path, NULL AS pubdate, NULL AS uuid FROM r;");
    db.close();
    const t = performance.now();
    const items = await collect(calibreAdapter(calibre.dir));
    expect(performance.now() - t).toBeLessThan(2000);
    expect(items).toHaveLength(1);
    expect(items[0]!.unreadable).toMatch(/Calibre library could not be read/);
    expect(await readdir(work)).toEqual([]);
  });

  it("a metadata.db over 1 GB is refused before it is copied", async () => {
    const fh = await open(calibre.db, "r+");
    await fh.truncate(MAX_CALIBRE_DB_BYTES + 1); // sparse
    await fh.close();
    const items = await collect(calibreAdapter(calibre.dir));
    expect(items).toHaveLength(1);
    expect(items[0]!.unreadable).toMatch(/too large/);
    expect(await readdir(work)).toEqual([]);
  });
});

describe("adversarial inputs: linear parsing (1 MB each, < 1 s)", () => {
  const N = MB;
  const LIMIT = 1000;
  const bib: Record<string, string> = {
    "open braces": `@article{k, title={${"{".repeat(N)}}}`,
    "closed braces": `@article{k, title={${"{a}".repeat(N / 3)}}}`,
    "at signs": "@".repeat(N),
    "unterminated entries": "@a{".repeat(N / 3),
    "unterminated entries on lines": "@a{k, t={\n".repeat(N / 10),
    "accents": `@article{k, title={${'\\"'.repeat(N / 2)}}}`,
    "commands": `@article{k, title={${"\\emph{".repeat(N / 7)}}}`,
    "names": `@article{k, author={${"a and ".repeat(N / 6)}}}`,
    "commas in a name": `@article{k, author={${",".repeat(N)}}}`,
    "concatenation": `@article{k, title=${"a # ".repeat(N / 4)}"x"}`,
    "quotes": `@article{k, title="${"{".repeat(N)}"}`,
    "file separators": `@article{k, file={${";:\\".repeat(N / 3)}}}`,
    "string macros": "@string{a = b}".repeat(N / 14) + "@article{k, title=a}",
    "many entries": "@misc{k, title={x}}\n".repeat(N / 20),
    "spaces": `@article{k, title={${" ".repeat(N)}x}}`,
  };
  for (const [name, text] of Object.entries(bib)) {
    it(`BibTeX: ${name}`, async () => {
      const p = await writeExport("adv.bib", text);
      expect(await timed(() => collect(bibtexAdapter(p)))).toBeLessThan(LIMIT);
    });
  }
  const ris: Record<string, string> = {
    "one long line": `TY  - JOUR\nTI  - ${"x".repeat(N)}\nER  - \n`,
    "many authors": "TY  - JOUR\n" + "AU  - Doe, J.\n".repeat(N / 14) + "ER  - \n",
    "continuations": "TY  - JOUR\nTI  - x\n" + "  more\n".repeat(N / 7) + "ER  - \n",
    "many records": "TY  - JOUR\nTI  - x\nER  - \n".repeat(N / 25),
    "dashes": `TY  - JOUR\nTI  - ${"  - ".repeat(N / 4)}\nER  - \n`,
    "no newlines": "TY  - ".repeat(N / 6),
    "commas in a name": `TY  - JOUR\nAU  - ${",".repeat(N)}\nER  - \n`,
  };
  for (const [name, text] of Object.entries(ris)) {
    it(`RIS: ${name}`, async () => {
      const p = await writeExport("adv.ris", text);
      expect(await timed(() => collect(risAdapter(p)))).toBeLessThan(LIMIT);
    });
  }
  const csl: Record<string, string> = {
    "deep nesting": "[".repeat(N),
    "long title": JSON.stringify([{ id: "k", title: "x".repeat(N) }]),
    "many items": JSON.stringify(Array.from({ length: N / 40 }, (_, i) => ({ id: `k${i}`, title: "t" }))),
    "many authors": JSON.stringify([{ id: "k", title: "t", author: Array.from({ length: N / 20 }, () => ({ family: "D" })) }]),
    "file separators": JSON.stringify([{ id: "k", title: "t", file: ";:\\".repeat(N / 3) }]),
  };
  for (const [name, text] of Object.entries(csl)) {
    it(`CSL-JSON: ${name}`, async () => {
      const p = await writeExport("adv.json", text);
      expect(await timed(() => collect(cslJsonAdapter(p)))).toBeLessThan(LIMIT);
    });
  }
  const H = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:bib="http://purl.org/net/biblio#">';
  const rdf: Record<string, string> = {
    "less-than signs": H + "<".repeat(N) + "</rdf:RDF>",
    "unclosed start tags": H + "<a".repeat(N / 2),
    "deep nesting": H + "<a>".repeat(N / 3) + "</rdf:RDF>",
    "deep nesting, closed": H + "<a>".repeat(N / 8) + "</a>".repeat(N / 8) + "</rdf:RDF>",
    "unclosed comments": H + "<!--".repeat(N / 4),
    "unclosed attribute values": H + '<a b="'.repeat(N / 6),
    "many attributes": H + "<a " + Array.from({ length: N / 8 }, (_, i) => `a${i}="1"`).join(" ") + "/></rdf:RDF>",
    "many items": H + '<bib:Book rdf:about="#x"><dc:title>t</dc:title></bib:Book>'.repeat(N / 60) + "</rdf:RDF>",
    "entity references": H + "<dc:title>" + "&amp;".repeat(N / 5) + "</dc:title></rdf:RDF>",
    "long text": H + "<dc:title>" + "x".repeat(N) + "</dc:title></rdf:RDF>",
  };
  for (const [name, text] of Object.entries(rdf)) {
    it(`Zotero RDF: ${name}`, async () => {
      const p = await writeExport("adv.rdf", text);
      expect(await timed(() => collect(zoteroRdfAdapter(p)))).toBeLessThan(LIMIT);
    });
  }
});

describe("through the Bulk Import engine", () => {
  const FAST = 2 ** 10;
  const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [refman_import, calibre_import, manual_upload]
processing:
  metadata_lookup: []
`;
  let lib: Library;
  let ring: KeyRing;
  let repo: Repo;
  let handle: IndexHandle;
  let agent: MockAgent;

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

  beforeEach(async () => {
    ring = new KeyRing();
    lib = await createLibrary(join(tmp, "Library"), "Lib", deps());
    handle = new IndexHandle(lib.root);
    repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
    agent = new MockAgent();
    agent.disableNetConnect();
  });
  afterEach(async () => {
    await agent.close();
    handle.close();
    await lib.close();
    ring.clear();
  });

  const project = async (): Promise<Project> =>
    (await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: GOV, encryption: { enabled: false } })).project;
  const bulkImport = () => createBulkImport({ repo, http: new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 }), index: handle });

  it("a BibTeX export creates sources with refman_import provenance, citation keys, tags and files", async () => {
    const p = await project();
    const bulk = bulkImport();
    const bibPath = join(exp, "sample.bib");
    const h = await bulk.startBatch(p.id, bibtexAdapter(bibPath));
    const r = await h.done;
    expect(r.state).toBe("finished");
    expect(r.counts.items).toBe(4);
    expect(r.counts.failed).toBe(0); // the entry whose file is missing is imported metadata-only
    expect(r.counts.created + r.counts.needsReview).toBe(4);

    const sfs = await Promise.all(repo.listSourceIds(p.id).map((id) => repo.getSource(p.id, id)));
    const ok = sfs.find((sf) => sf.source.citationKey === "okafor2024feeding")!;
    expect(ok).toBeDefined();
    expect(ok.source.provenance.captureMethod).toBe("refman_import");
    expect(ok.source.provenance.externalKeys?.citekey).toBe("okafor2024feeding");
    const itemKey = ok.source.provenance.externalKeys?.["import-item"];
    expect(itemKey).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.source.creators.map((c) => c.family)).toEqual(["Okafor", "Müller"]);
    expect(ok.source.identifiers.doi).toBe("10.5555/ao.urban.2024.017");
    expect(ok.assets).toHaveLength(1);
    const { tags } = await projectCollectionsAndTags(repo, p.id);
    expect(tags.filter((t) => ok.source.tagIds.includes(t.id)).map((t) => t.name).sort()).toEqual(["Lagos", "food systems"]);
    const book = sfs.find((sf) => sf.source.citationKey === "adebayo2019markets")!;
    expect(book.assets).toHaveLength(2);
    expect(sfs.find((sf) => sf.source.citationKey === "who2021report")!.assets).toHaveLength(0);
    const gone = sfs.find((sf) => sf.source.citationKey === "doe2020missing")!;
    expect(gone.assets).toHaveLength(0);
    expect(gone.source.creators.map((c) => c.family)).toEqual(["Doe"]);

    // The report lists the missing file per item, never its path.
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.fileNotes).toEqual([{ item: expect.stringContaining("doe2020missing"), note: "attached file not found" }]);
    expect(JSON.stringify(report)).not.toContain("missing.pdf");
    expect(JSON.stringify(report)).not.toContain(exp);
    const md = await readFile(join(lib.root, p.folder, "imports", "batch-0001", "report.md"), "utf8");
    expect(md).toMatch(/doe2020missing.*: attached file not found/);

    // The item key (export path + citation key) never reaches the library in clear.
    const sourceJson = await readFile(join(lib.root, ok.source.folder, "source.json"), "utf8");
    expect(sourceJson).not.toContain(exp);
    expect(sourceJson).not.toContain("sample.bib");

    // Resume finds the adapter from the record.
    expect(adapterFor("bibtex", bibPath)?.kind).toBe("bibtex");
  });

  it("an identifiable project stores RIS under 'refman-import' and Zotero RDF under 'zotero-import' (zotero_import provenance)", async () => {
    const gdpr = async () =>
      (await repo.createProject({
        name: `GDPR${Math.random().toString(36).slice(2, 7)}`,
        governanceYaml: `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
consent:
  requireLegalBasis: true
  defaultLegalBasis:
    refman-import: "legitimate interest; bibliographic records"
    zotero-import: "legitimate interest; Zotero library"
encryption:
  atRest: optional
captureMethods: [refman_import, zotero_import]
processing:
  metadata_lookup: []
`,
        encryption: { enabled: false },
      })).project;
    const bulk = bulkImport();
    for (const adapter of [risAdapter(join(exp, "sample.ris")), zoteroRdfAdapter(join(exp, "sample.rdf"))]) {
      const p = await gdpr();
      const r = await (await bulk.startBatch(p.id, adapter)).done;
      expect(r.state).toBe("finished");
      expect(r.counts.failed).toBe(0); // the missing file: metadata only
      const sfs = await Promise.all(repo.listSourceIds(p.id).map((id) => repo.getSource(p.id, id)));
      expect(sfs).toHaveLength(3);
      const rdf = adapter.kind === "zotero-rdf";
      for (const sf of sfs) {
        expect(sf.source.provenance.captureMethod).toBe(rdf ? "zotero_import" : "refman_import");
        expect(sf.source.provenance.legal.basis).toBe(rdf ? "legitimate interest; Zotero library" : "legitimate interest; bibliographic records");
      }
      if (adapter.kind === "zotero-rdf") {
        // RDF collections arrive through the engine as nested collections.
        const { collections } = await projectCollectionsAndTags(repo, p.id);
        const urban = collections.find((c) => c.name === "Urban" && !c.parentId);
        expect(urban).toBeDefined();
        expect(collections.find((c) => c.name === "Food")?.parentId).toBe(urban!.id);
      }
    }
  });

  it("a Calibre library creates sources with calibre_import provenance", async () => {
    const calibre = buildCalibreLibrary(join(tmp, "Calibre Library"), { pdf: pdfs["files/okafor2024feeding.pdf"]! });
    const p = await project();
    const h = await bulkImport().startBatch(p.id, calibreAdapter(calibre.dir));
    const r = await h.done;
    expect(r.counts.items).toBe(6);
    expect(r.counts.failed).toBe(0);
    const sfs = await Promise.all(repo.listSourceIds(p.id).map((id) => repo.getSource(p.id, id)));
    expect(sfs).toHaveLength(6);
    // The traversal books import metadata-only; nothing outside the library was read.
    const outside = sfs.find((sf) => sf.source.title.variants[0]?.value === "Outside the Library")!;
    expect(outside.assets).toHaveLength(0);
    const report = await bulkImport().batchReport(p.id, h.batchId);
    expect(report.fileNotes.filter((n) => n.note === "attached file is outside the Calibre library")).toHaveLength(3);
    expect(report.fileNotes.filter((n) => n.note === "attached file not found")).toHaveLength(1);
    expect(sfs.every((sf) => sf.source.provenance.captureMethod === "calibre_import")).toBe(true);
    expect(await readdir(join(lib.root, ".tmp")).then((ns) => ns.filter((n) => n.startsWith("batch-")))).toEqual([]);
  });

  it("I2: an unsupported or vanished file is dropped with a note; the rest of the item imports", async () => {
    await writeFile(join(exp, "files", "snapshot.html"), "<html><body>Snapshot</body></html>");
    const p = await project();
    const bulk = bulkImport();
    const bib = await writeExport("snap.bib", "@article{snap, title={With Snapshot}, author={Doe, J.}, file={PDF:files/okafor2024feeding.pdf:application/pdf;Snapshot:files/snapshot.html:text/html}}");
    const vanished: ImportSourceAdapter = {
      kind: "bibtex",
      location: join(exp, "gone.bib"),
      roots: [exp],
      async *scan() {
        yield { key: "gone.bib@000000000000#gone", files: [{ path: join(exp, "files", "vanished.pdf"), mime: "application/pdf", bytes: 10 }], referenceMetadata: { title: { variants: [{ lang: "und", kind: "original", value: "Vanished File" }] }, citationKey: "gone" } };
      },
    };
    const h1 = await bulk.startBatch(p.id, bibtexAdapter(bib));
    expect((await h1.done).counts.failed).toBe(0);
    const h2 = await bulk.startBatch(p.id, vanished);
    expect((await h2.done).counts.failed).toBe(0);
    const sfs = await Promise.all(repo.listSourceIds(p.id).map((id) => repo.getSource(p.id, id)));
    const snap = sfs.find((sf) => sf.source.citationKey === "snap")!;
    expect(snap.assets.map((a) => a.mime)).toEqual(["application/pdf"]);
    expect(sfs.find((sf) => sf.source.citationKey === "gone")!.assets).toEqual([]);
    expect((await bulk.batchReport(p.id, h1.batchId)).fileNotes.map((n) => n.note)).toEqual(["attached file type not supported"]);
    expect((await bulk.batchReport(p.id, h2.batchId)).fileNotes.map((n) => n.note)).toEqual(["attached file no longer present"]);
  });

  it("two references linking the same file: the second imports metadata-only with a note", async () => {
    const p = await project();
    const bulk = bulkImport();
    const bib = await writeExport(
      "same.bib",
      "@article{first, title={First Reference}, author={Doe, J.}, file={files/okafor2024feeding.pdf}}\n@article{second, title={Second Reference}, author={Roe, R.}, file={files/okafor2024feeding.pdf}}\n",
    );
    const h = await bulk.startBatch(p.id, bibtexAdapter(bib));
    const r = await h.done;
    expect(r.counts.created + r.counts.needsReview).toBe(2);
    const sfs = await Promise.all(repo.listSourceIds(p.id).map((id) => repo.getSource(p.id, id)));
    expect(sfs.find((sf) => sf.source.citationKey === "first")!.assets).toHaveLength(1);
    expect(sfs.find((sf) => sf.source.citationKey === "second")!.assets).toHaveLength(0);
    expect((await bulk.batchReport(p.id, h.batchId)).fileNotes).toEqual([{ item: expect.stringMatching(/^second \([0-9a-f]{8}\)$/), note: "same file as another item in this batch" }]);
  });

  it("report labels are the citation key (or 'item N') with an 8-hex HMAC; skipped empty records are a report note", async () => {
    const p = await project();
    const bulk = bulkImport();
    const bib = await writeExport("labels.bib", "@misc{, title={No Key}, file={files/nope.pdf}}\n@misc{e, note={empty}}\n@misc{keyed, title={Keyed}, file={files/nope2.pdf}}\n");
    const dry = await bulk.dryRun(p.id, bibtexAdapter(bib));
    expect(dry.notes).toEqual(["1 reference had no title, creators, identifiers or files and was skipped."]);
    const h = await bulk.startBatch(p.id, bibtexAdapter(bib));
    await h.done;
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.fileNotes.map((n) => n.item)).toEqual([expect.stringMatching(/^item 1 \([0-9a-f]{8}\)$/), expect.stringMatching(/^keyed \([0-9a-f]{8}\)$/)]);
    expect(report.notes).toContain("1 reference had no title, creators, identifiers or files and was skipped.");
    const json = await readFile(join(lib.root, p.folder, "imports", "batch-0001", "report.json"), "utf8");
    const md = await readFile(join(lib.root, p.folder, "imports", "batch-0001", "report.md"), "utf8");
    for (const t of [json, md]) {
      expect(t).not.toContain("labels.bib");
      expect(t).not.toMatch(/@[0-9a-f]{12}#/);
    }
  });

  describe("R67: files outside the expected folders need approval", () => {
    let outside: string;
    let outsidePdf: string;
    let bib: string;
    beforeEach(async () => {
      outside = join(tmp, "outside");
      await mkdir(outside, { recursive: true });
      outsidePdf = join(outside, "x.pdf");
      await writeFile(outsidePdf, await buildPdf({ extra: "outside" }));
      bib = await writeExport("out.bib", "@article{outref, title={Outside Reference}, author={Doe, J.}, file={../outside/x.pdf}}\n");
    });
    const sourceOf = async (p: Project, key: string) =>
      (await Promise.all(repo.listSourceIds(p.id).map((id) => repo.getSource(p.id, id)))).find((sf) => sf.source.citationKey === key)!;

    it("dryRun lists the file with its folder", async () => {
      const p = await project();
      const s = await bulkImport().dryRun(p.id, bibtexAdapter(bib));
      expect(s.outsideFiles).toEqual([{ item: expect.stringContaining("outref"), folder: await realpath(outside) }]);
    });

    it("without approval the item imports metadata-only with a note", async () => {
      const p = await project();
      const bulk = bulkImport();
      const h = await bulk.startBatch(p.id, bibtexAdapter(bib));
      expect((await h.done).counts.failed).toBe(0);
      expect((await sourceOf(p, "outref")).assets).toEqual([]);
      expect((await bulk.batchReport(p.id, h.batchId)).fileNotes.map((n) => n.note)).toEqual(["attached file is outside the export's folder and was not approved"]);
    });

    it("an approved folder or file is attached; the batch record keeps no plaintext path", async () => {
      const p = await project();
      const bulk = bulkImport();
      const h = await bulk.startBatch(p.id, bibtexAdapter(bib), { approveOutside: { folders: [outside] } });
      await h.done;
      expect((await sourceOf(p, "outref")).assets).toHaveLength(1);
      const batchJson = await readFile(join(lib.root, p.folder, "imports", "batch-0001", "batch.json"), "utf8");
      expect(batchJson).not.toContain(outside);
      expect(batchJson).not.toContain("approveOutside");
      const p2 = await project();
      await (await bulk.startBatch(p2.id, bibtexAdapter(bib), { approveOutside: { files: [outsidePdf] } })).done;
      expect((await sourceOf(p2, "outref")).assets).toHaveLength(1);
    });

    it("rememberFolders adds the folder to the library's approved folders (audited); later batches attach without asking", async () => {
      const p = await project();
      const bulk = bulkImport();
      await (await bulk.startBatch(p.id, bibtexAdapter(bib), { approveOutside: { rememberFolders: [outside] } })).done;
      expect(await approvedFolders(lib)).toEqual([await realpath(outside)]);
      const p2 = await project();
      expect((await bulk.dryRun(p2.id, bibtexAdapter(bib))).outsideFiles).toEqual([]);
      await (await bulk.startBatch(p2.id, bibtexAdapter(bib))).done;
      expect((await sourceOf(p2, "outref")).assets).toHaveLength(1);
      const audit = (await readdir(join(lib.root, p.folder, "audit"))).map((f) => join(lib.root, p.folder, "audit", f));
      const lines = (await Promise.all(audit.map((f) => readFile(f, "utf8")))).join("\n");
      expect(lines).toContain("import.approve-folders");
      expect(lines).not.toContain(outside);
    });

    it.skipIf(process.platform === "win32")("a symlink inside the export's folder pointing outside is treated as outside", async () => {
      await symlink(outsidePdf, join(exp, "files", "link.pdf"));
      const linkBib = await writeExport("link.bib", "@article{linkref, title={Linked Reference}, author={Doe, J.}, file={files/link.pdf}}\n");
      const p = await project();
      const bulk = bulkImport();
      expect((await bulk.dryRun(p.id, bibtexAdapter(linkBib))).outsideFiles).toEqual([{ item: expect.stringContaining("linkref"), folder: await realpath(outside) }]);
      await (await bulk.startBatch(p.id, bibtexAdapter(linkBib))).done;
      expect((await sourceOf(p, "linkref")).assets).toEqual([]);
    });

    it.skipIf(process.platform === "win32")("a symlink inside a scanned folder pointing outside is listed, and attached only when approved", async () => {
      const scanned = join(tmp, "Scanned");
      await mkdir(scanned);
      await writeFile(join(scanned, "inside.pdf"), await buildPdf({ extra: "inside" }));
      await symlink(outsidePdf, join(scanned, "link.pdf"));
      const p = await project();
      const bulk = bulkImport();
      expect((await bulk.dryRun(p.id, folderAdapter(scanned))).outsideFiles).toEqual([{ item: "link.pdf", folder: await realpath(outside) }]);
      const r = await (await bulk.startBatch(p.id, folderAdapter(scanned))).done;
      expect(r.counts.failed).toBe(1);
      expect(repo.listSourceIds(p.id)).toHaveLength(1);
      const p2 = await project();
      const r2 = await (await bulk.startBatch(p2.id, folderAdapter(scanned), { approveOutside: { folders: [outside] } })).done;
      expect(r2.counts.failed).toBe(0);
      expect(repo.listSourceIds(p2.id)).toHaveLength(2);
    });
  });

  it("a merge adds the item's missing tags, and undo takes them off again (a tag still in use is kept)", async () => {
    const p = await project();
    const bulk = bulkImport();
    // Batch 1: the article without keywords, and another source tagged "Lagos".
    const first = await writeExport(
      "first.bib",
      [
        "@article{okafor2024feeding, title={Feeding the City: Informal Markets in Lagos}, author={Okafor, Ngozi}, year={2024}, doi={10.5555/ao.urban.2024.017}}",
        "@misc{other2020, title={Another Study}, author={Roe, R.}, year={2020}, keywords={Lagos}}",
      ].join("\n"),
    );
    const b1 = await (await bulk.startBatch(p.id, bibtexAdapter(first))).done;
    expect(b1.counts.failed).toBe(0);
    const okId = (await Promise.all(repo.listSourceIds(p.id).map((id) => repo.getSource(p.id, id)))).find((sf) => sf.source.citationKey === "okafor2024feeding")!.source.id;
    const otherId = repo.listSourceIds(p.id).find((id) => id !== okId)!;
    expect((await repo.getSource(p.id, okId)).source.tagIds).toEqual([]);

    // Batch 2: the full export, merged: "food systems" (new) and "Lagos" (existing) are added to the article.
    const h2 = await bulk.startBatch(p.id, bibtexAdapter(join(exp, "sample.bib")), { duplicates: "merge" });
    const b2 = await h2.done;
    expect(b2.counts.merged).toBe(1);
    const tagName = async (ids: string[]) => {
      const { tags } = await projectCollectionsAndTags(repo, p.id);
      return ids.map((id) => tags.find((t) => t.id === id)?.name).sort();
    };
    expect(await tagName((await repo.getSource(p.id, okId)).source.tagIds)).toEqual(["Lagos", "food systems"]);
    const foodId = (await projectCollectionsAndTags(repo, p.id)).tags.find((t) => t.name === "food systems")!.id;

    // The user puts the batch's new tag on a source outside batch 2: undo must keep that tag.
    await repo.setMembership(p.id, otherId, { tagIds: [...(await repo.getSource(p.id, otherId)).source.tagIds, foodId] });

    const u = await bulk.undoBatch(p.id, h2.batchId);
    expect(u.revertedMerges).toBe(1);
    expect((await repo.getSource(p.id, okId)).source.tagIds).toEqual([]);
    const { tags } = await projectCollectionsAndTags(repo, p.id);
    expect(tags.map((t) => t.name).sort()).toEqual(["Lagos", "food systems"]);
    expect(u.kept).toContainEqual(expect.objectContaining({ kind: "tag", id: foodId }));
  });
});
