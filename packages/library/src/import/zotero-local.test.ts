import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project, SourceFile } from "@ao/core";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { NOTE_HTML, buildZoteroFixture } from "../../tests/fixtures/zotero/build-fixture.mjs";
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
import { adapterFor, createBulkImport, type ImportSourceAdapter, type ScanContext, type ScanItem } from "./bulk/index.js";
import { OUTSIDE_NOTE } from "./bulk/outside.js";
import { ENGINE_FILE_NOTES } from "./bulk/run.js";
import { IMAGE_PLACEHOLDER, MAX_NOTE_CHARS, noteToMarkdown } from "./note-html.js";
import { RDF_REASONS } from "./zotero-rdf.js";
import { ZOTERO_NOTES, ZOTERO_REASONS, zoteroAnnotation, zoteroCopyReason, zoteroLocalAdapter } from "./zotero-local.js";

const FAST = 2 ** 10;

let tmp: string;
let dataDir: string;
let linkedDir: string;
let work: string;
let ctx: ScanContext;
let fx: ReturnType<typeof buildZoteroFixture>;

const sha = async (p: string) => createHash("sha256").update(await readFile(p)).digest("hex");
const title = (i: ScanItem | undefined) => i?.referenceMetadata?.title?.variants[0]?.value;
const byKey = (items: ScanItem[], k: string) => items.find((i) => i.key === `zotero:${k}`);

async function collect(a: ImportSourceAdapter, c: ScanContext | undefined = ctx): Promise<ScanItem[]> {
  const out: ScanItem[] = [];
  for await (const i of a.scan(new AbortController().signal, c)) out.push(i);
  return out;
}

/** Changes the fixture's own zotero.sqlite the way Zotero would (as the user's program, not the importer). */
function zoteroEdit(fn: (db: Database.Database) => void): void {
  const db = new Database(fx.db);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function setTitle(db: Database.Database, itemId: number, value: string): void {
  const v = (db.prepare("SELECT max(valueID) AS m FROM itemDataValues").get() as { m: number }).m + 1;
  db.prepare("INSERT INTO itemDataValues (valueID, value) VALUES (?, ?)").run(v, value);
  db.prepare("UPDATE itemData SET valueID = ? WHERE itemID = ? AND fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'title')").run(v, itemId);
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-zotero-"));
  dataDir = join(tmp, "Zotero");
  linkedDir = join(tmp, "Elsewhere");
  fx = buildZoteroFixture(dataDir, {
    pdf: await buildPdf({ extra: "okafor zotero" }),
    linkedPdf: await buildPdf({ extra: "adebayo linked" }),
    trashedPdf: await buildPdf({ extra: "trashed" }),
    linkedDir,
  });
  work = join(tmp, "Lib", ".tmp", "batch-test");
  ctx = {
    workDir: async () => {
      await mkdir(work, { recursive: true, mode: 0o700 });
      return work;
    },
  };
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

afterAll(async () => {
  await shutdownExtractors();
});

describe("noteToMarkdown", () => {
  it("drops scripts, styles, iframes and event handlers; keeps links as text and URL; images become a placeholder", () => {
    const md = noteToMarkdown(NOTE_HTML);
    expect(md).toContain("# Reading notes");
    expect(md).toContain("Markets are **central**.");
    expect(md).toContain("the dataset (https://example.org/lagos)");
    expect(md).toContain(IMAGE_PLACEHOLDER);
    expect(md).toMatch(/- one\n- two/);
    for (const bad of ["alert", "script", "onclick", "javascript", "evil.example", "color:red", "data:image", "IMGKEY01", "<"]) expect(md).not.toContain(bad);
    expect(md).toContain("this."); // the javascript: link's text stays, without its URL
  });

  it("no script survives however it is written", () => {
    const inputs = [
      "<SCRIPT>alert(1)</SCRIPT>ok",
      "<script type=x>alert(1)</script >ok",
      "<scr<script>ipt>alert(1)</script>ok",
      '<svg><script>alert(1)</script></svg>ok',
      '<a href=" javascript:alert(1)">ok</a>',
      '<a href="JaVaScRiPt:alert(1)">ok</a>',
      '<a href="java&#115;cript:alert(1)">ok</a>',
      '<img src=x onerror="alert(1)">ok',
      "<p style=\"background:url(javascript:alert(1))\">ok</p>",
      "<!--<script>alert(1)</script>-->ok",
      "<math><mi xlink:href=\"javascript:alert(1)\">x</mi></math>ok",
      "<iframe srcdoc=\"<script>alert(1)</script>\"></iframe>ok",
      "<object data=\"javascript:alert(1)\"></object>ok",
      "ok<script>alert(1)", // unterminated
      "&lt;script&gt;alert(1)&lt;/script&gt;ok", // text that reads as a tag once decoded
      "&#60;img src=x onerror=alert(1)&#62;ok",
    ];
    for (const html of inputs) {
      const md = noteToMarkdown(html);
      // No tag a Markdown renderer could pass through (every "<" escaped), no script URL.
      expect(md, html).not.toMatch(/(?:^|[^\\])</u);
      expect(md, html).not.toMatch(/javascript:/iu);
      expect(md, html).toMatch(/ok/u);
    }
    // Elements that are dropped take their content with them.
    for (const html of inputs.slice(0, 4)) expect(noteToMarkdown(html), html).not.toMatch(/alert\(1\)(?!ok)|<script/iu);
  });

  it("caps a note at 1 MB", () => {
    const md = noteToMarkdown(`<p>${"word ".repeat(400_000)}</p>`);
    expect(md.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    expect(md.endsWith("(note truncated)")).toBe(true);
  });

  it("runs in linear time on adversarial nesting", { timeout: 60_000 }, () => {
    const shapes = [
      (n: number) => "<div>".repeat(n) + "x" + "</div>".repeat(n),
      (n: number) => "<b><i>x".repeat(n),
      (n: number) => '<a href="http://x">y'.repeat(n),
      (n: number) => "<p>hello world</p>".repeat(n),
      (n: number) => "<ol>" + "<li>item".repeat(n) + "</ol>",
      (n: number) => "  ".repeat(n * 4) + "x",
      (n: number) => "<ul><li>".repeat(n) + "x",
    ];
    // Best of three runs (other test files run alongside and can stall one run).
    const time = (s: string) => {
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t = performance.now();
        noteToMarkdown(s);
        best = Math.min(best, performance.now() - t);
      }
      return best;
    };
    for (const shape of shapes) {
      time(shape(2_000)); // warm up
      const small = Math.max(time(shape(8_000)), 5);
      const large = time(shape(32_000));
      // 4x the input: well under the 16x a quadratic conversion would take.
      expect(large, shape(2).slice(0, 40)).toBeLessThan(small * 9 + 50);
      expect(large).toBeLessThan(5_000);
    }
  });
});

describe("zoteroAnnotation", () => {
  const row = (type: number, position: string, extra: Record<string, unknown> = {}) => ({
    key: "ANNOX001",
    type,
    authorName: "",
    text: "t",
    comment: "c",
    color: "#ffd400",
    pageLabel: "2",
    position,
    dateAdded: "2024-05-03 09:00:00",
    ...extra,
  });
  it("maps highlight, underline, note, image and ink to annotations with PDF anchors (page = pageIndex + 1)", () => {
    const rects = JSON.stringify({ pageIndex: 4, rects: [[10, 20, 30, 50]] });
    expect(zoteroAnnotation(row(1, rects), "/f.pdf")).toMatchObject({ kind: "highlight", quote: "t", body: "c", anchor: { kind: "pdf", page: 5, rects: [{ x: 10, y: 20, w: 20, h: 30 }] }, file: "/f.pdf" });
    expect(zoteroAnnotation(row(5, rects), "/f.pdf")).toMatchObject({ kind: "underline", anchor: { page: 5 } });
    expect(zoteroAnnotation(row(2, rects), "/f.pdf")).toMatchObject({ kind: "note", body: "c" });
    expect(zoteroAnnotation(row(3, rects), "/f.pdf")).toMatchObject({ kind: "image", anchor: { page: 5 } });
    const ink = zoteroAnnotation(row(4, JSON.stringify({ pageIndex: 0, width: 2, paths: [[1, 2, 5, 9, 3, 4]] })), "/f.pdf");
    expect(ink).toMatchObject({ kind: "ink", anchor: { kind: "pdf", page: 1, rects: [{ x: 1, y: 2, w: 4, h: 7 }] } });
    expect(zoteroAnnotation(row(1, rects), "/f.pdf")?.createdAt).toBe("2024-05-03T09:00:00.000Z");
  });

  it("reads the position defensively: bad JSON, huge or odd values give an annotation without an anchor", () => {
    for (const p of ["{", "[]", "null", JSON.stringify({ pageIndex: -1, rects: [[1, 2, 3, 4]] }), JSON.stringify({ pageIndex: 1e12, rects: [[1, 2, 3, 4]] }), JSON.stringify({ pageIndex: 0, rects: [["a", 2, 3, 4]] }), JSON.stringify({ pageIndex: 0, rects: [] }), "x".repeat(70_000), JSON.stringify({ pageIndex: 0, rects: Array.from({ length: 5000 }, () => [1, 2, 3, 4]) })]) {
      const a = zoteroAnnotation(row(1, p), "/f.pdf");
      expect(a?.kind).toBe("highlight");
      expect(a?.anchor, p.slice(0, 30)).toBeUndefined();
    }
    expect(zoteroAnnotation(row(99, "{}"), "/f.pdf")).toBeUndefined(); // unknown kinds are skipped
  });
});

describe("zoteroLocalAdapter scan", () => {
  it("yields the user library's items (trash, deleted parents and other libraries skipped) with metadata, keys, files, notes and annotations", async () => {
    const before = { db: await sha(fx.db), bbt: await sha(fx.bbtDb!) };
    const adapter = zoteroLocalAdapter(dataDir);
    expect(adapter.kind).toBe("zotero-local");
    expect(adapter.roots).toEqual([join(dataDir, "storage")]);
    const items = await collect(adapter);
    expect(items.map((i) => i.key).sort()).toEqual(["zotero:AAAA1111", "zotero:BBBB2222", "zotero:CCCC3333", "zotero:DDDD4444", "zotero:EEEE5555"]);
    expect(items.every((i) => !i.unreadable)).toBe(true);

    const a = byKey(items, "AAAA1111")!;
    expect(title(a)).toBe("Feeding the City: Informal Markets in Lagos");
    expect(a.referenceMetadata).toMatchObject({
      type: "article-journal",
      issued: "2024-03",
      creators: [
        { family: "Okafor", given: "Ngozi", role: "author" },
        { family: "Müller", given: "Jan", role: "author" },
      ],
      identifiers: { doi: "10.5555/ao.urban.2024.017" },
      citationKey: "okaforFeedingCity2024", // Better BibTeX
    });
    expect(a.referenceMetadata?.container?.variants[0]?.value).toBe("Journal of Urban Studies");
    expect(a.referenceSource).toMatchObject({ kind: "zotero" });
    expect(a.folderPath).toEqual(["Urban", "Food"]);
    expect(a.tags?.sort()).toEqual(["Lagos", "food systems"]);
    expect(a.tagColors).toEqual({ "food systems": "#FF6666" });
    expect(a.externalKeys).toMatchObject({
      zoteroKey: "AAAA1111",
      zoteroVersion: "5",
      libraryId: "1",
      related: "BBBB2222",
      zoteroDateAdded: "2024-05-01T10:00:00.000Z",
      zoteroDateModified: "2024-05-02T11:00:00.000Z",
      citekey: "okaforFeedingCity2024",
    });
    expect(a.version?.id).toBe("1/AAAA1111");
    expect(a.files.map((f) => f.path)).toEqual([fx.storagePdf]); // the trashed attachment is left out
    const anns = a.annotations ?? [];
    const hl = anns.find((x) => x.key === "zotero:ANNO0001")!;
    expect(hl).toMatchObject({ kind: "highlight", quote: "informal markets", body: "key claim", file: fx.storagePdf, anchor: { kind: "pdf", page: 1, rects: [{ x: 100.5, y: 200, w: 199.5, h: 15.25 }] } });
    expect(anns.find((x) => x.key === "zotero:ANNO0002")).toMatchObject({ kind: "note", body: "check the numbers", anchor: { page: 3 } });
    const note = anns.find((x) => x.key === "zotero:NOTE0001")!;
    expect(note.kind).toBe("note");
    expect(note.anchor).toBeUndefined();
    expect(note.body).toContain("the dataset (https://example.org/lagos)");
    expect(note.body).not.toMatch(/alert|script/u);

    const b = byKey(items, "BBBB2222")!;
    expect(b.referenceMetadata).toMatchObject({ type: "book", citationKey: "adebayo2019markets", publisher: "MIT Press", identifiers: { isbn: ["9780262033848"] } });
    expect(b.folderPath).toEqual(["Urban"]);
    expect(b.files).toEqual([expect.objectContaining({ path: fx.linkedPdf, link: true })]);

    const c = byKey(items, "CCCC3333")!;
    expect(c.referenceMetadata?.creators).toEqual([{ literal: "World Health Organization", role: "author" }]);
    expect(c.referenceMetadata?.type).toBe("report");
    expect(c.referenceMetadata?.issued).toBe("2021-06-15");
    expect(c.referenceMetadata?.citationKey).toBeUndefined(); // generated when stored
    const d = byKey(items, "DDDD4444")!;
    expect(d.referenceMetadata?.type).toBe("chapter");
    expect(d.referenceMetadata?.creators).toEqual([
      { family: "Doe", given: "Jane", role: "author" },
      { family: "Roe", given: "Rita", role: "editor" },
    ]);
    expect(d.referenceMetadata?.container?.variants[0]?.value).toBe("Urban Informality");

    // Opened only as a copy: the originals are byte-identical and the copy is gone.
    expect(await sha(fx.db)).toBe(before.db);
    expect(await sha(fx.bbtDb!)).toBe(before.bbt);
    expect(await readdir(work)).toEqual([]);
    // Stable keys; resume finds the adapter.
    expect((await collect(zoteroLocalAdapter(dataDir))).map((i) => i.key)).toEqual(items.map((i) => i.key));
    expect(adapterFor("zotero-local", dataDir)?.kind).toBe("zotero-local");
  });

  it("without Better BibTeX, a Citation Key line in Extra still wins; another library can be chosen", async () => {
    await rm(fx.bbtDb!);
    const items = await collect(zoteroLocalAdapter(dataDir));
    expect(byKey(items, "AAAA1111")!.referenceMetadata?.citationKey).toBeUndefined();
    expect(byKey(items, "BBBB2222")!.referenceMetadata?.citationKey).toBe("adebayo2019markets");
    const group = await collect(zoteroLocalAdapter(dataDir, { libraryId: 2 }));
    expect(group.map((i) => i.key)).toEqual(["zotero:GGGG7777"]);
  });

  it("reads a consistent copy while Zotero is running (database and its -wal copied together)", async () => {
    // Zotero keeps a connection open; a change sits in the -wal, not yet in zotero.sqlite.
    const live = new Database(fx.db);
    try {
      live.pragma("journal_mode = WAL");
      live.pragma("wal_autocheckpoint = 0");
      setTitle(live, 3, "Water Access, Revised");
      const wal = `${fx.db}-wal`;
      expect((await stat(wal)).size).toBeGreaterThan(0);
      const before = { db: await sha(fx.db), wal: await sha(wal) };
      const items = await collect(zoteroLocalAdapter(dataDir));
      expect(title(byKey(items, "CCCC3333"))).toBe("Water Access, Revised");
      expect(await sha(fx.db)).toBe(before.db);
      expect(await sha(wal)).toBe(before.wal);
      expect(await readdir(work)).toEqual([]);
    } finally {
      live.close();
    }
  });

  it("refuses a database whose required tables are views or have generated columns", async () => {
    zoteroEdit((db) => {
      db.exec("ALTER TABLE items RENAME TO items_real; CREATE VIEW items AS SELECT * FROM items_real");
    });
    let items = await collect(zoteroLocalAdapter(dataDir));
    expect(items).toHaveLength(1);
    expect(items[0]!.unreadable).toBe(ZOTERO_REASONS.unreadable);

    await rm(dataDir, { recursive: true, force: true });
    fx = buildZoteroFixture(dataDir, { pdf: await buildPdf({ extra: "a" }), linkedPdf: await buildPdf({ extra: "b" }), linkedDir });
    zoteroEdit((db) => {
      db.exec(
        "ALTER TABLE itemDataValues RENAME TO v_old; CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, raw, value TEXT GENERATED ALWAYS AS (printf('%.*c', 100000000, 'x')) VIRTUAL)",
      );
    });
    items = await collect(zoteroLocalAdapter(dataDir));
    expect(items).toHaveLength(1);
    expect(items[0]!.unreadable).toBe(ZOTERO_REASONS.unreadable);
    expect(await readdir(work)).toEqual([]);
  });

  it("refuses a data folder whose databases are over the size cap", async () => {
    const items = await collect(zoteroLocalAdapter(dataDir, { maxCopyBytes: 1024 }));
    expect(items).toEqual([expect.objectContaining({ unreadable: ZOTERO_REASONS.tooLarge })]);
    expect(await readdir(work)).toEqual([]);
  });

  it("a folder without zotero.sqlite is one unreadable item", async () => {
    const items = await collect(zoteroLocalAdapter(join(tmp, "nowhere")));
    expect(items).toEqual([expect.objectContaining({ unreadable: ZOTERO_REASONS.unreadable })]);
  });
});

describe("R75: adapter review round 1", () => {
  it("I1: a torn copy is never read: the hot -journal is copied and rolled back (exclusive locking, spilled cache)", async () => {
    zoteroEdit((db) => {
      const ins = db.prepare("INSERT INTO itemDataValues (valueID, value) VALUES (?, ?)");
      db.transaction(() => {
        for (let i = 0; i < 5000; i++) ins.run(1000 + i, `filler value ${i} ${"x".repeat(200)}`);
      })();
    });
    const live = new Database(fx.db);
    try {
      live.pragma("locking_mode = EXCLUSIVE");
      live.pragma("cache_size = 10");
      live.exec("BEGIN");
      live.prepare("UPDATE itemDataValues SET value = value || ' TORN'").run(); // spills pages into zotero.sqlite
      expect((await stat(`${fx.db}-journal`)).size).toBeGreaterThan(0);
      const before = { db: await sha(fx.db), journal: await sha(`${fx.db}-journal`) };
      const items = await collect(zoteroLocalAdapter(dataDir));
      expect(items.every((i) => !i.unreadable)).toBe(true);
      expect(items.map(title).sort()).toEqual(["Feeding the City: Informal Markets in Lagos", "Markets and Memory", "Street Food and the State", "Street Vendors in Accra", "Water Access in Peri-Urban Areas"]);
      expect(JSON.stringify(items)).not.toContain("TORN");
      expect(await sha(fx.db)).toBe(before.db);
      expect(await sha(`${fx.db}-journal`)).toBe(before.journal);
      expect(await readdir(work)).toEqual([]);
    } finally {
      live.exec("ROLLBACK");
      live.close();
    }
  });

  it("I2: a virtual table is refused promptly whatever its SQL looks like", async () => {
    zoteroEdit((db) => db.exec("ALTER TABLE items RENAME TO items_real; CREATE /**/ VIRTUAL TABLE items USING fts5(key)"));
    const t = performance.now();
    const items = await collect(zoteroLocalAdapter(dataDir));
    expect(performance.now() - t).toBeLessThan(5_000);
    expect(items).toEqual([expect.objectContaining({ unreadable: ZOTERO_REASONS.unreadable })]);
  });

  it("I3: note link URLs cannot inject Markdown links or images", () => {
    const inputs = [
      '<a href="https://example.org/a)[x](javascript:alert(1))">t</a>',
      '<a href="https://example.org/b ![i](https://evil.example/p.png)">t</a>',
      '<a href="https://example.org/c*_<x>`!">t</a>',
    ];
    for (const html of inputs) {
      const md = noteToMarkdown(html);
      expect(md, html).not.toMatch(/\]\(|!\[/u);
      expect(md, html).toMatch(/^t \(https:\/\/example\.org\/[^\s()[\]<>*_!`]+\)$/u);
    }
    expect(noteToMarkdown(inputs[0]!)).toBe("t (https://example.org/a%29%5Bx%5D%28javascript:alert%281%29%29)");
  });

  it("links nested deeper than the kept depth keep their URL", () => {
    const md = noteToMarkdown("<div>".repeat(40) + '<a href="https://deep.example/x">deep</a> after');
    expect(md).toContain("deep (https://deep.example/x)");
    expect(md).toContain("after");
  });

  it("1 MB floods of '<', nested lists and table cells convert in under 2 s", { timeout: 60_000 }, () => {
    const MB1 = 1024 * 1024;
    for (const unit of ["<", "<ul><li>", "<td>x", "<tr><td>", "<li>", "<li>x", "<ul><li>x", "<p>x", "<b>x</b> "]) {
      const n = Math.floor(MB1 / unit.length);
      const html = unit.repeat(n);
      noteToMarkdown(html.slice(0, 10_000)); // warm up
      const t = performance.now();
      const md = noteToMarkdown(html);
      expect(performance.now() - t, unit).toBeLessThan(2_000);
      // Past the element cap the tags go but every bit of text stays.
      if (unit.includes("x")) expect(md.split("x").length - 1, unit).toBe(n);
    }
  });

  it("integer columns holding text are not trusted; an undated '0000' date falls back to its text", async () => {
    zoteroEdit((db) => {
      db.prepare("UPDATE items SET version = 'not a number' WHERE itemID = 2").run();
      const v = (db.prepare("SELECT max(valueID) AS m FROM itemDataValues").get() as { m: number }).m + 1;
      db.prepare("INSERT INTO itemDataValues (valueID, value) VALUES (?, '0000-00-00 Spring 2020')").run(v);
      db.prepare("UPDATE itemData SET valueID = ? WHERE itemID = 3 AND fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'date')").run(v);
    });
    const items = await collect(zoteroLocalAdapter(dataDir));
    expect(byKey(items, "BBBB2222")!.externalKeys?.zoteroVersion).toBe("0");
    expect(byKey(items, "CCCC3333")!.referenceMetadata?.issued).toBe("2020");
  });

  it("citation keys: BBT, then Zotero's own field, then Extra (Citation Key or legacy bibtex:), else none", async () => {
    zoteroEdit((db) => {
      db.prepare("INSERT INTO fields (fieldID, fieldName) VALUES (100, 'citationKey')").run();
      db.prepare("INSERT INTO itemDataValues (valueID, value) VALUES (900, 'whoWater2021'), (901, 'okaforNative'), (902, 'Citation Key: extraLoses'), (903, 'bibtex: doeVendors2020')").run();
      db.prepare("INSERT INTO itemData (itemID, fieldID, valueID) VALUES (3, 100, 900), (1, 100, 901)").run();
      db.prepare("INSERT INTO itemData (itemID, fieldID, valueID) VALUES (3, (SELECT fieldID FROM fields WHERE fieldName = 'extra'), 902), (5, (SELECT fieldID FROM fields WHERE fieldName = 'extra'), 903)").run();
    });
    const items = await collect(zoteroLocalAdapter(dataDir));
    expect(byKey(items, "AAAA1111")!.referenceMetadata?.citationKey).toBe("okaforFeedingCity2024"); // BBT first
    expect(byKey(items, "CCCC3333")!.referenceMetadata?.citationKey).toBe("whoWater2021"); // native field over Extra
    expect(byKey(items, "EEEE5555")!.referenceMetadata?.citationKey).toBe("doeVendors2020"); // legacy bibtex: line
    expect(byKey(items, "DDDD4444")!.referenceMetadata?.citationKey).toBeUndefined();
  });

  it("a legacy (Loki) Better BibTeX store gives the scan note; a changed BBT key changes the version token", async () => {
    const notes: string[] = [];
    const before = await collect(zoteroLocalAdapter(dataDir));
    const b = new Database(fx.bbtDb!);
    b.prepare("UPDATE citationkey SET citationKey = 'okafor2024new' WHERE itemKey = 'AAAA1111'").run();
    b.close();
    const after = await collect(zoteroLocalAdapter(dataDir));
    expect(byKey(after, "AAAA1111")!.version!.version).not.toBe(byKey(before, "AAAA1111")!.version!.version);
    expect(byKey(after, "BBBB2222")!.version!.version).toBe(byKey(before, "BBBB2222")!.version!.version);
    await rm(fx.bbtDb!);
    const loki = new Database(fx.bbtDb!);
    loki.exec(`CREATE TABLE "better-bibtex" (name TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL); INSERT INTO "better-bibtex" VALUES ('better-bibtex.citekey', '{}')`);
    loki.close();
    await collect(zoteroLocalAdapter(dataDir), { ...ctx, note: (t) => notes.push(t) });
    expect(notes).toContain(ZOTERO_NOTES.bbt);
  });

  it("the copy honours the abort signal and checks free space first; a Windows lock error asks to close Zotero", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect((async () => {
      for await (const _ of zoteroLocalAdapter(dataDir).scan(ac.signal, ctx)) void _;
    })()).rejects.toThrow(/abort/iu);
    expect(await readdir(work)).toEqual([]);
    const items = await collect(zoteroLocalAdapter(dataDir, { freeSpace: async () => 1024 }));
    expect(items).toEqual([expect.objectContaining({ unreadable: ZOTERO_REASONS.noSpace })]);
    expect(zoteroCopyReason(Object.assign(new Error("busy"), { code: "EBUSY" }))).toBe(ZOTERO_REASONS.locked);
    expect(zoteroCopyReason(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(ZOTERO_REASONS.unreadable);
    expect(ZOTERO_REASONS.busy).toBe("Zotero is busy saving — try again in a moment or close Zotero.");
  });
});

describe("Zotero RDF wording (R71)", () => {
  it("the too-many message points to the direct Zotero import", () => {
    expect(RDF_REASONS.tooMany).toMatch(/split it into smaller files, or import directly from Zotero/u);
  });
});

describe("Zotero local import through the engine", () => {
  const GOV = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
consent:
  requireLegalBasis: true
  defaultLegalBasis:
    zotero-import: "legitimate interest; Zotero library"
encryption:
  atRest: optional
captureMethods: [zotero_import]
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

  const project = async (encrypted = false): Promise<Project> =>
    (
      await repo.createProject({
        name: `P${Math.random().toString(36).slice(2, 7)}`,
        governanceYaml: GOV,
        encryption: encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false },
      })
    ).project;
  const bulkImport = () => createBulkImport({ repo, http: new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 }), index: handle });
  const sources = async (p: Project): Promise<SourceFile[]> => Promise.all(repo.listSourceIds(p.id).map((id) => repo.getSource(p.id, id)));
  const byZoteroKey = (sfs: SourceFile[], k: string) => sfs.find((sf) => sf.source.provenance.externalKeys?.zoteroKey === k)!;
  const titleOf = (sf: SourceFile) => sf.source.title.variants[0]?.value;
  const approve = () => ({ approveOutside: { folders: [linkedDir] } });

  it("imports 5 items with nested collections, citation keys, tag colours, annotations and notes; the linked file needs approval (R67)", async () => {
    const p = await project();
    const bulk = bulkImport();
    const before = await sha(fx.db);

    // Dry run: the linked PDF outside the data folder is listed for approval.
    const dry = await bulk.dryRun(p.id, zoteroLocalAdapter(dataDir));
    expect(dry.items).toBe(5);
    expect(dry.outsideFiles).toEqual([{ item: "zotero:BBBB2222", folder: await realpath(linkedDir) }]);

    // Not approved: the item imports without it, with the note.
    const h = await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir));
    const r = await h.done;
    expect(r.state).toBe("finished");
    expect(r.counts.failed).toBe(0);
    expect(r.counts.created + r.counts.needsReview).toBe(5);
    const sfs = await sources(p);
    expect(sfs).toHaveLength(5);

    const a = byZoteroKey(sfs, "AAAA1111");
    expect(a.source.provenance.captureMethod).toBe("zotero_import");
    expect(a.source.provenance.legal.basis).toBe("legitimate interest; Zotero library");
    expect(a.source.provenance.externalKeys).toMatchObject({ zoteroKey: "AAAA1111", zoteroVersion: "5", libraryId: "1", related: "BBBB2222", zoteroDateAdded: "2024-05-01T10:00:00.000Z" });
    expect(a.source.provenance.externalKeys?.["import-item"]).toMatch(/^[0-9a-f]{64}$/); // R63: never the key itself
    expect(a.source.citationKey).toBe("okaforFeedingCity2024");
    expect(byZoteroKey(sfs, "BBBB2222").source.citationKey).toBe("adebayo2019markets");
    expect(byZoteroKey(sfs, "CCCC3333").source.citationKey).toBe("worldhealthorganization2021water");
    expect([byZoteroKey(sfs, "DDDD4444").source.citationKey, byZoteroKey(sfs, "EEEE5555").source.citationKey].sort()).toEqual(["doe2020street", "doe2020streeta"]);
    expect(a.fieldEvidence.some((e) => e.field === "/title" && e.source.kind === "zotero")).toBe(true);

    // Collections Urban > Food; tags with the Zotero colour.
    const { collections, tags } = await projectCollectionsAndTags(repo, p.id);
    const urban = collections.find((c) => c.name === "Urban" && !c.parentId)!;
    const food = collections.find((c) => c.name === "Food")!;
    expect(food.parentId).toBe(urban.id);
    expect(a.source.collectionIds).toEqual([food.id]);
    expect(byZoteroKey(sfs, "BBBB2222").source.collectionIds).toEqual([urban.id]);
    expect(tags.find((t) => t.name === "food systems")?.color).toBe("#FF6666");
    expect(tags.filter((t) => a.source.tagIds.includes(t.id)).map((t) => t.name).sort()).toEqual(["Lagos", "food systems"]);

    // Annotations anchored in the PDF asset, with page numbers; the note as Markdown.
    expect(a.assets).toHaveLength(1);
    const pdf = a.assets[0]!;
    const hl = a.annotations.find((x) => x.externalKey === "zotero:ANNO0001")!;
    expect(hl).toMatchObject({ kind: "highlight", quote: "informal markets", body: "key claim", sourceId: a.source.id });
    expect(hl.anchors).toEqual([expect.objectContaining({ kind: "pdf", assetId: pdf.id, page: 1 })]);
    expect(a.annotations.find((x) => x.externalKey === "zotero:ANNO0002")!.anchors[0]).toMatchObject({ kind: "pdf", page: 3, assetId: pdf.id });
    const note = a.annotations.find((x) => x.externalKey === "zotero:NOTE0001")!;
    expect(note.kind).toBe("note");
    expect(note.body).toContain("the dataset (https://example.org/lagos)");

    // The linked file was not approved: metadata only, with the note.
    expect(byZoteroKey(sfs, "BBBB2222").assets).toEqual([]);
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.fileNotes).toEqual([{ item: "zotero:BBBB2222", note: OUTSIDE_NOTE }]);
    expect(JSON.stringify(report)).not.toContain(linkedDir);
    expect(await sha(fx.db)).toBe(before);
  });

  it("an approved linked file is linked in place", async () => {
    const p = await project();
    const r = await (await bulkImport().startBatch(p.id, zoteroLocalAdapter(dataDir), approve())).done;
    expect(r.counts.failed).toBe(0);
    const b = byZoteroKey(await sources(p), "BBBB2222");
    expect(b.assets).toHaveLength(1);
    expect(b.assets[0]!.linked?.absolutePath).toBe(await realpath(fx.linkedPdf));
    // Stored attachments are still copied.
    expect(byZoteroKey(await sources(p), "AAAA1111").assets[0]!.linked).toBeUndefined();
  });

  it("re-import: unchanged items are skipped; a version bump updates the changed title and creates nothing", async () => {
    const p = await project();
    const bulk = bulkImport();
    await (await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve())).done;
    const firstIds = repo.listSourceIds(p.id).sort();

    const again = await (await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve())).done;
    expect(again.counts).toMatchObject({ created: 0, needsReview: 0, failed: 0, unchanged: 5, updated: 0 });

    zoteroEdit((db) => {
      setTitle(db, 4, "Street Food and the State, Second Edition");
      db.prepare("UPDATE items SET version = 7, clientDateModified = '2024-06-01 08:00:00' WHERE itemID = 4").run();
    });
    const h = await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve());
    const r = await h.done;
    expect(r.counts).toMatchObject({ created: 0, needsReview: 0, failed: 0, updated: 1, unchanged: 4 });
    expect(repo.listSourceIds(p.id).sort()).toEqual(firstIds);
    const d = byZoteroKey(await sources(p), "DDDD4444");
    expect(titleOf(d)).toBe("Street Food and the State, Second Edition");
    expect(d.source.provenance.externalKeys?.zoteroVersion).toBe("1"); // provenance is never touched
    expect(d.fieldEvidence.filter((e) => e.field === "/title" && e.source.kind === "zotero").map((e) => e.value)).toContain("Street Food and the State, Second Edition");
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.counts).toMatchObject({ updated: 1, unchanged: 4 });

    // Nothing more to do after that.
    expect((await (await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve())).done).counts).toMatchObject({ updated: 0, unchanged: 5, created: 0 });
  });

  it("re-import keeps a field the user edited, lists it in the report, and adds new annotations", async () => {
    const p = await project();
    const bulk = bulkImport();
    await (await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve())).done;
    const a0 = byZoteroKey(await sources(p), "AAAA1111");
    await repo.updateSource(p.id, a0.source.id, { title: { variants: [{ lang: "en", kind: "original", value: "My Own Title" }] } });

    zoteroEdit((db) => {
      setTitle(db, 1, "Feeding the City (Zotero edit)");
      db.prepare("UPDATE items SET version = 6, clientDateModified = '2024-06-01 08:00:00' WHERE itemID = 1").run();
      db.prepare("INSERT INTO items (itemID, itemTypeID, libraryID, key, version, dateAdded, dateModified, clientDateModified) VALUES (20, 1, 1, 'ANNO0003', 6, '2024-06-01 08:00:00', '2024-06-01 08:00:00', '2024-06-01 08:00:00')").run();
      db.prepare(
        "INSERT INTO itemAnnotations (itemID, parentItemID, type, authorName, text, comment, color, pageLabel, sortIndex, position, isExternal) VALUES (20, 7, 1, '', 'new highlight', '', '#ffd400', '2', '00001|000001|00001', ?, 0)",
      ).run(JSON.stringify({ pageIndex: 1, rects: [[1, 2, 3, 4]] }));
    });
    const h = await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve());
    const r = await h.done;
    expect(r.counts).toMatchObject({ created: 0, updated: 1 });
    const a = byZoteroKey(await sources(p), "AAAA1111");
    expect(titleOf(a)).toBe("My Own Title");
    expect(a.annotations.find((x) => x.externalKey === "zotero:ANNO0003")?.anchors[0]).toMatchObject({ page: 2, assetId: a.assets[0]!.id });
    expect(a.annotations.filter((x) => x.externalKey === "zotero:ANNO0001")).toHaveLength(1); // not added twice
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.keptFields).toEqual([{ item: "zotero:AAAA1111", fields: ["/title"] }]);
    expect(await readFile(join(lib.root, p.folder, "imports", "batch-0002", "report.md"), "utf8")).toMatch(/zotero:AAAA1111: \/title/u);
  });

  const DELETED_NOTE = /^1 item you deleted here was not re-imported/u;
  const DEFERRED_NOTE =
    "Not imported from Zotero: 1 standalone note, 1 attachment note, 1 linked URL, 1 image embedded in a note, 1 linked file relative to Zotero's base folder (not given).";

  it("dry run and report count the kinds that are not imported (no paths)", async () => {
    const p = await project();
    const bulk = bulkImport();
    expect((await bulk.dryRun(p.id, zoteroLocalAdapter(dataDir))).notes).toContain(DEFERRED_NOTE);
    const h = await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve());
    await h.done;
    expect((await bulk.batchReport(p.id, h.batchId)).notes).toContain(DEFERRED_NOTE);
  });

  it("R73: a source deleted here is not re-imported (report note); includeDeleted brings it back and clears the tombstone", async () => {
    const p = await project();
    const bulk = bulkImport();
    await (await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve())).done;
    const c = byZoteroKey(await sources(p), "CCCC3333");
    await repo.deleteSource(p.id, c.source.id);
    // The tombstone holds an HMAC, never the key.
    const tomb = await readFile(join(lib.root, p.folder, "imports", "deleted-items.json"), "utf8");
    expect(tomb).not.toContain("CCCC3333");
    expect(JSON.parse(tomb).zotero).toHaveLength(1);

    const h = await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve());
    expect((await h.done).counts).toMatchObject({ created: 0, needsReview: 0, unchanged: 4 });
    expect(repo.listSourceIds(p.id)).toHaveLength(4);
    expect((await bulk.batchReport(p.id, h.batchId)).notes.some((n) => DELETED_NOTE.test(n))).toBe(true);

    const back = await (await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), { ...approve(), includeDeleted: true })).done;
    expect(back.counts.created + back.counts.needsReview).toBe(1);
    expect(byZoteroKey(await sources(p), "CCCC3333")).toBeDefined();
    expect(JSON.parse(await readFile(join(lib.root, p.folder, "imports", "deleted-items.json"), "utf8")).zotero).toEqual([]);
    expect((await (await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve())).done).counts).toMatchObject({ unchanged: 5, created: 0 });
  });

  it("R73: undoing a batch is not a deletion: its items import again", async () => {
    const p = await project();
    const bulk = bulkImport();
    const h = await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve());
    await h.done;
    expect((await bulk.undoBatch(p.id, h.batchId)).removedSources).toBe(5);
    const again = await (await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve())).done;
    expect(again.counts.created + again.counts.needsReview).toBe(5);
    expect(repo.listSourceIds(p.id)).toHaveLength(5);
  });

  it("R73: in an encrypted project the tombstone file is sealed", async () => {
    const p = await project(true);
    const bulk = bulkImport();
    await (await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve())).done;
    await repo.deleteSource(p.id, byZoteroKey(await sources(p), "CCCC3333").source.id);
    const dir = join(lib.root, p.folder, "imports");
    expect(await readdir(dir)).toContain("deleted-items.json.enc");
    expect(await readdir(dir)).not.toContain("deleted-items.json");
    const raw = (await readFile(join(dir, "deleted-items.json.enc"))).toString("latin1");
    expect(raw).not.toContain("zotero");
    expect(raw).not.toContain("CCCC3333");
    const r = await (await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve())).done;
    expect(r.counts).toMatchObject({ created: 0, needsReview: 0, unchanged: 4 });
  });

  it("undo of an incremental update reverts the update (and its new annotation) like a merge", async () => {
    const p = await project();
    const bulk = bulkImport();
    await (await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve())).done;
    zoteroEdit((db) => {
      setTitle(db, 5, "Street Vendors in Accra and Kumasi");
      db.prepare("UPDATE items SET version = 9, clientDateModified = '2024-06-02 08:00:00' WHERE itemID = 5").run();
      // A new note on item 1 (its parent's version is unchanged; the token still changes).
      db.prepare("INSERT INTO items (itemID, itemTypeID, libraryID, key, version, dateAdded, dateModified, clientDateModified) VALUES (21, 3, 1, 'NOTE0002', 1, '2024-06-02 08:00:00', '2024-06-02 08:00:00', '2024-06-02 08:00:00')").run();
      db.prepare("INSERT INTO itemNotes (itemID, parentItemID, note, title) VALUES (21, 1, '<p>second thoughts</p>', 'second')").run();
    });
    const h = await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve());
    expect((await h.done).counts).toMatchObject({ updated: 2 });
    expect(byZoteroKey(await sources(p), "AAAA1111").annotations.find((x) => x.externalKey === "zotero:NOTE0002")?.body).toBe("second thoughts");
    const e = byZoteroKey(await sources(p), "EEEE5555");
    expect(titleOf(e)).toBe("Street Vendors in Accra and Kumasi");

    const u = await bulk.undoBatch(p.id, h.batchId);
    expect(u.removedSources).toBe(0);
    expect(u.revertedMerges).toBe(2);
    const back = byZoteroKey(await sources(p), "EEEE5555");
    expect(titleOf(back)).toBe("Street Vendors in Accra");
    expect(back.fieldEvidence.some((x) => x.value === "Street Vendors in Accra and Kumasi")).toBe(false);
    expect(byZoteroKey(await sources(p), "AAAA1111").annotations.map((x) => x.externalKey).sort()).toEqual(["zotero:ANNO0001", "zotero:ANNO0002", "zotero:NOTE0001"]);
    expect(repo.listSourceIds(p.id)).toHaveLength(5);
    // The undone batch no longer counts: the next run applies the changes again.
    expect((await (await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve())).done).counts).toMatchObject({ updated: 2, created: 0 });
  });

  it("encrypted project: annotations and notes are sealed; the approved linked file is copied with a note", async () => {
    const p = await project(true);
    const bulk = bulkImport();
    const h = await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), approve());
    const r = await h.done;
    expect(r.counts.failed).toBe(0);
    const sfs = await sources(p);
    const a = byZoteroKey(sfs, "AAAA1111");
    expect(a.annotations.map((x) => x.externalKey).sort()).toEqual(["zotero:ANNO0001", "zotero:ANNO0002", "zotero:NOTE0001"]);
    const b = byZoteroKey(sfs, "BBBB2222");
    expect(b.assets).toHaveLength(1);
    expect(b.assets[0]!.linked).toBeUndefined();
    expect(b.assets[0]!.encrypted).toBe(true);
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.fileNotes).toEqual([{ item: "zotero:BBBB2222", note: ENGINE_FILE_NOTES.linkedCopied }]);
    // Nothing of the notes or annotations in plaintext anywhere in the project.
    const walk = async (d: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(d, { withFileTypes: true })) {
        const q = join(d, e.name);
        if (e.isDirectory()) out.push(...(await walk(q)));
        else out.push(q);
      }
      return out;
    };
    for (const f of await walk(join(lib.root, p.folder))) {
      const text = (await readFile(f)).toString("latin1");
      for (const secret of ["check the numbers", "informal markets", "Reading notes", "example.org/lagos"]) expect(text, f).not.toContain(secret);
    }
  });

  it("notes over 1 MB are cut", async () => {
    zoteroEdit((db) => {
      db.prepare("UPDATE itemNotes SET note = ? WHERE itemID = 8").run(`<p>${"long ".repeat(400_000)}</p>`);
    });
    const items = await collect(zoteroLocalAdapter(dataDir));
    const note = byKey(items, "AAAA1111")!.annotations!.find((x) => x.key === "zotero:NOTE0001")!;
    expect(note.body!.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    expect(note.body!.endsWith("(note truncated)")).toBe(true);
  });
});
