import { appendFile, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Provenance, type SourceDraft } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import { ReadOnlyLibraryError, type Repo } from "../repo/index.js";
import { openTestRepo } from "../repo/testing.js";
import {
  INDEX_FILE,
  createIndexSink,
  findSourceBy,
  getMeta,
  isIndexStale,
  openIndex,
  rebuildIndex,
  search,
  type IndexDb,
} from "./index.js";
import { buildMatchQuery, cjkBigrams } from "./text.js";

const NOW = "2026-11-09T14:30:00.000Z";
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const STRICT_GOV = `captureMethods: [manual_upload, downloader]
`;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let db: IndexDb;
let pdf: string;

function deps(): Deps {
  return {
    clock: () => new Date(NOW),
    deviceId: "dev-A",
    hostname: "host-A",
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: join(tmp, "config"),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
  };
}

function draft(title: string | Array<{ lang: string; kind: "original" | "translated" | "romanized"; value: string }>, over: Partial<SourceDraft> = {}): SourceDraft {
  const variants = typeof title === "string" ? [{ lang: "en", kind: "original" as const, value: title }] : title;
  return {
    projectIds: [],
    type: "article-journal",
    title: { variants },
    creators: [{ family: "Smith", given: "Jane", role: "author" }],
    issued: "2025",
    identifiers: {},
    caseAttributes: {},
    availability: { status: "available" },
    collectionIds: [],
    tagIds: [],
    participantIds: [],
    ...over,
  };
}

function prov(over: Partial<Provenance> = {}): Provenance {
  return {
    captureMethod: "manual_upload",
    capturedAt: NOW,
    tool: { name: "ao", version: "0.0.0" },
    fileHashes: {},
    legal: { status: "public" },
    identifiable: false,
    ...over,
  };
}

const files = () => [{ path: pdf, role: "original" as const, handling: "copy" as const }];

async function mkRepo(sinkDb: IndexDb | undefined = db): Promise<Repo> {
  return openTestRepo(lib, ring, {
    clock: () => new Date(NOW),
    tz: "UTC",
    actor: "tester",
    scryptN: 2 ** 10,
    ...(sinkDb ? { index: createIndexSink(sinkDb, { root: lib.root, keyRing: ring }) } : {}),
  });
}

async function openProject(name = "P"): Promise<string> {
  return (await repo.createProject({ name, governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
}

const ids = (r: { items: Array<{ id: string }> }) => r.items.map((i) => i.id).sort();

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-index-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  pdf = join(tmp, "input.pdf");
  await writeFile(pdf, Buffer.from("%PDF-1.7\nhello\n%%EOF\n"));
  db = openIndex(lib.root);
  repo = await mkRepo();
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    // already closed
  }
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

/** Reopens the index after a rebuild replaced the file. */
function reopen(): void {
  db.close();
  db = openIndex(lib.root);
}

describe("schema", () => {
  it("uses WAL, records schemaVersion 1 and creates the required tables", () => {
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(getMeta(db, "schemaVersion")).toBe("1");
    const names = (db.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of [
      "projects", "sources", "assets", "collections", "tags", "source_collections", "source_tags", "participants",
      "sessions", "consents", "import_batches", "review_items", "jobs", "meta", "source_text", "source_hashes",
    ]) expect(names).toContain(t);
    // reopening does not re-run migrations
    db.close();
    db = openIndex(lib.root);
    expect(getMeta(db, "schemaVersion")).toBe("1");
  });
});

describe("search", () => {
  it("finds a Spanish source by its English translated title, and Café by cafe", async () => {
    const pid = await openProject();
    const es = await repo.createSource(
      pid,
      draft([
        { lang: "es", kind: "original", value: "Cocina familiar y memoria" },
        { lang: "en", kind: "translated", value: "Family cooking and memory" },
      ]),
      files(),
      { provenance: prov() },
    );
    const cafe = await repo.createSource(pid, draft("Un Café en Madrid"), files(), { provenance: prov() });
    const r = search(db, { text: "cooking" });
    expect(ids(r)).toEqual([es.source.id]);
    expect(r.items[0]!.title).toBe("Cocina familiar y memoria");
    expect(r.items[0]).toMatchObject({ projectId: pid, type: "article-journal", issuedYear: "2025", locked: false, needsReview: false });
    expect(search(db, { text: "cafe" }).items.map((i) => i.id)).toEqual([cafe.source.id]);
    expect(search(db, { text: "CAFÉ" }).total).toBe(1);
    expect(search(db, { text: "fam" }).total).toBe(1); // prefix
    expect(search(db, { text: "memory madrid" }).total).toBe(0); // AND
    expect(search(db, { text: "Smith" }).total).toBe(2); // creators
  });

  it("filters by project, type, collection, tags; empty text is filter-only; paging", async () => {
    const p1 = await openProject("One");
    const p2 = await openProject("Two");
    const a = await repo.createSource(p1, draft("Alpha"), files(), { provenance: prov() });
    const b = await repo.createSource(p1, draft("Beta", { type: "book" }), files(), { provenance: prov() });
    const c = await repo.createSource(p2, draft("Gamma"), files(), { provenance: prov() });
    const col = await repo.createCollection(p1, "Col");
    const t1 = await repo.createTag(p1, "t1");
    const t2 = await repo.createTag(p1, "t2");
    await repo.setMembership(p1, a.source.id, { collectionIds: [col.id], tagIds: [t1.id, t2.id] });
    await repo.setMembership(p1, b.source.id, { tagIds: [t1.id] });

    expect(search(db, {}).total).toBe(3);
    expect(search(db, { text: "   " }).total).toBe(3);
    expect(ids(search(db, { projectId: p1 }))).toEqual([a.source.id, b.source.id].sort());
    expect(ids(search(db, { types: ["book"] }))).toEqual([b.source.id]);
    expect(ids(search(db, { collectionId: col.id }))).toEqual([a.source.id]);
    expect(ids(search(db, { tagIds: [t1.id] }))).toEqual([a.source.id, b.source.id].sort());
    expect(ids(search(db, { tagIds: [t1.id, t2.id] }))).toEqual([a.source.id]);
    expect(ids(search(db, { text: "gamma", projectId: p1 }))).toEqual([]);
    expect(ids(search(db, { text: "gamma", projectId: p2 }))).toEqual([c.source.id]);
    const page = search(db, { limit: 2, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(search(db, { limit: 2, offset: 2 }).items).toHaveLength(1);
  });

  it("keeps extracted text across metadata re-indexing", async () => {
    const pid = await openProject();
    const sf = await repo.createSource(pid, draft("Plain title"), files(), { provenance: prov() });
    // import pipeline path: indexSource with extracted text, then a metadata edit without it
    const { indexSource } = await import("./db.js");
    indexSource(db, sf, "the quick brown fox");
    expect(search(db, { text: "fox" }).total).toBe(1);
    await repo.updateSource(pid, sf.source.id, { publisher: "X" });
    expect(search(db, { text: "fox" }).total).toBe(1);
  });

  it("is safe against FTS5 syntax in user text", async () => {
    const pid = await openProject();
    const a = await repo.createSource(pid, draft("Near and far: a study"), files(), { provenance: prov() });
    await repo.createSource(pid, draft("Something else"), files(), { provenance: prov() });
    const nasty = [
      '"', '""', '"unterminated', "*", "**", "NEAR", "NEAR(a b)", "a NEAR/2 b", "AND", "OR", "NOT", "a OR b", "-far", "far -study",
      "title:foo", "cjk_bigrams:x", "{title_all}:x", "(", ")", "(((", "^far", "far*", "'; DROP TABLE sources; --", "\\", "\u0000", "a\"b",
    ];
    for (const text of nasty) expect(() => search(db, { text }), JSON.stringify(text)).not.toThrow();
    // user text is data: '-far' means the word far, "NEAR" the word near, "*" matches nothing special
    expect(ids(search(db, { text: "-far" }))).toEqual([a.source.id]);
    expect(ids(search(db, { text: "NEAR" }))).toEqual([a.source.id]);
    expect(ids(search(db, { text: '"near" far' }))).toEqual([a.source.id]);
    expect(search(db, { text: "*" }).total).toBe(2); // nothing searchable: filter-only
    expect(search(db, { text: "title:foo" }).total).toBe(0); // 'title' and 'foo' are plain words
    expect(search(db, { text: "far OR nothing" }).total).toBe(0); // OR is a word, not an operator
    expect(buildMatchQuery('x" OR "y')).toBe('"x"* AND "OR"* AND "y"*');
  });

  it("finds CJK text through character bigrams", async () => {
    const pid = await openProject();
    const jp = await repo.createSource(pid, draft([{ lang: "ja", kind: "original", value: "家庭料理の記憶" }]), files(), { provenance: prov() });
    await repo.createSource(pid, draft("English only"), files(), { provenance: prov() });
    expect(ids(search(db, { text: "料理" }))).toEqual([jp.source.id]);
    expect(ids(search(db, { text: "家庭料理の記憶" }))).toEqual([jp.source.id]);
    expect(ids(search(db, { text: "憶" }))).toEqual([jp.source.id]); // last character
    expect(ids(search(db, { text: "料" }))).toEqual([jp.source.id]); // single char
    expect(search(db, { text: "料記" }).total).toBe(0); // not adjacent
    expect(search(db, { text: "料理 english" }).total).toBe(0);
    expect(cjkBigrams("家庭料理の記憶 abc")).toBe("家庭 庭料 料理 理の の記 記憶 憶");
    expect(buildMatchQuery("料理")).toBe('cjk_bigrams : "料理"');
  });
});

describe("rebuildIndex", () => {
  async function seed() {
    const pid = await openProject();
    const a = await repo.createSource(
      pid,
      draft([
        { lang: "es", kind: "original", value: "Cocina familiar" },
        { lang: "en", kind: "translated", value: "Family cooking" },
      ]),
      files(),
      { provenance: prov() },
    );
    const b = await repo.createSource(pid, draft("Un Café"), files(), { provenance: prov() });
    return { pid, a, b };
  }

  it("rebuilding after deleting library.sqlite gives the same results", async () => {
    await seed();
    const queries = [{ text: "cooking" }, { text: "cafe" }, {}, { types: ["article-journal" as const] }];
    const before = queries.map((q) => search(db, q));
    db.close();
    for (const s of ["", "-wal", "-shm"]) await rm(join(lib.root, INDEX_FILE + s), { force: true });
    const progress: Array<[number, number]> = [];
    const res = await rebuildIndex(lib.root, ring, (d, t) => progress.push([d, t]), { library: lib });
    expect(res).toEqual({ indexed: 2, lockedProjects: [], errors: [] });
    expect(progress.at(-1)).toEqual([2, 2]);
    db = openIndex(lib.root);
    expect(queries.map((q) => search(db, q))).toEqual(before);
    expect((await readdir(lib.root)).filter((f) => f.includes("rebuild"))).toEqual([]);
    expect(await isIndexStale(lib.root, db, ring)).toBe(false);
  });

  it("reports a corrupt source.json and indexes the others", async () => {
    const { pid, a } = await seed();
    const bad = await repo.createSource(pid, draft("Broken one"), files(), { provenance: prov() });
    await writeFile(join(lib.root, bad.source.folder, "source.json"), "{ not json");
    const res = await rebuildIndex(lib.root, ring, undefined, { library: lib });
    expect(res.indexed).toBe(2);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.folder).toBe(bad.source.folder);
    expect(res.errors[0]!.message).toBeTruthy();
    reopen();
    expect(search(db, { text: "cooking" }).items.map((i) => i.id)).toEqual([a.source.id]);
    expect(search(db, { text: "broken" }).total).toBe(0);
  });

  it("refuses to rebuild a read-only library", async () => {
    await expect(rebuildIndex(lib.root, ring, undefined, { library: { mode: "read-only", readOnlyReason: "offline" } })).rejects.toBeInstanceOf(
      ReadOnlyLibraryError,
    );
  });

  it("a crash before the rename leaves the old database intact; the next rebuild cleans up", async () => {
    await seed();
    const before = search(db, { text: "cooking" });
    db.close();
    const oldBytes = await readFile(join(lib.root, INDEX_FILE));
    await expect(
      rebuildIndex(lib.root, ring, undefined, {
        library: lib,
        beforeRename: () => {
          throw new Error("power cut");
        },
      }),
    ).rejects.toThrow("power cut");
    expect(await readFile(join(lib.root, INDEX_FILE))).toEqual(oldBytes);
    expect((await readdir(lib.root)).filter((f) => f.includes("rebuild"))).toEqual([]);
    db = openIndex(lib.root);
    expect(search(db, { text: "cooking" })).toEqual(before);

    // a hard kill leaves the temp file behind; the old DB still works and the next rebuild removes it
    await writeFile(join(lib.root, `${INDEX_FILE}.rebuild-dead`), "garbage");
    await rebuildIndex(lib.root, ring, undefined, { library: lib });
    expect((await readdir(lib.root)).filter((f) => f.includes("rebuild"))).toEqual([]);
    reopen();
    expect(search(db, { text: "cooking" })).toEqual(before);
  });

  it("a failure while building (progress callback throws) leaves the old database intact", async () => {
    await seed();
    db.close();
    const oldBytes = await readFile(join(lib.root, INDEX_FILE));
    await expect(
      rebuildIndex(lib.root, ring, (d) => {
        if (d === 1) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await readFile(join(lib.root, INDEX_FILE))).toEqual(oldBytes);
    expect((await readdir(lib.root)).filter((f) => f.includes("rebuild"))).toEqual([]);
    db = openIndex(lib.root);
  });

  it("indexes a locked project from the manifest only: type and year, no titles, no text", async () => {
    const created = await repo.createProject({ name: "Secret", governanceYaml: STRICT_GOV, encryption: { enabled: true, passphrase: "pw" } });
    const pid = created.project.id;
    const sf = await repo.createSource(pid, draft("Very identifying title", { type: "interview" }), files(), {
      provenance: prov({ identifiable: true, legal: { status: "consented", basis: "consent form" } }),
    });
    expect(search(db, { text: "identifying" }).total).toBe(1); // unlocked: indexed
    repo.lockProject(pid);
    const res = await rebuildIndex(lib.root, ring, undefined, { library: lib });
    expect(res.lockedProjects).toEqual([pid]);
    expect(res.indexed).toBe(1);
    reopen();
    expect(search(db, { text: "identifying" }).total).toBe(0);
    const rows = search(db, { projectId: pid }).items;
    expect(rows).toEqual([
      { id: sf.source.id, projectId: pid, type: "interview", title: "", creatorsText: "", issuedYear: "2025", folder: sf.source.folder, needsReview: false, locked: true },
    ]);
    // nothing identifying anywhere in the database file
    const raw = (await readFile(join(lib.root, INDEX_FILE))).toString("latin1");
    // (the folder name, taken from the plaintext manifest, is the only place a title can appear)
    expect(db.prepare("SELECT COUNT(*) AS n FROM source_text").get()).toEqual({ n: 0 });
    expect(raw).not.toContain("Smith");
    // unlocking and rebuilding indexes it fully
    await repo.unlockProject(pid, "pw");
    const res2 = await rebuildIndex(lib.root, ring, undefined, { library: lib });
    expect(res2.lockedProjects).toEqual([]);
    reopen();
    expect(search(db, { text: "identifying" }).items[0]).toMatchObject({ id: sf.source.id, locked: false, title: "Very identifying title" });
  });
});

describe("isIndexStale", () => {
  it("is true after an extra change is appended to the change log", async () => {
    const pid = await openProject();
    await repo.createSource(pid, draft("A"), files(), { provenance: prov() });
    await rebuildIndex(lib.root, ring, undefined, { library: lib });
    reopen();
    expect(await isIndexStale(lib.root, db, ring)).toBe(false);
    const dir = join(lib.root, "Projects", "P", "changes");
    const file = (await readdir(dir))[0]!;
    const change = { id: newId(), at: NOW, author: "x", device: "d", projectId: pid, entity: { type: "source", id: newId() }, op: "delete" };
    await appendFile(join(dir, file), `${JSON.stringify(change)}\n`);
    expect(await isIndexStale(lib.root, db, ring)).toBe(true);
  });

  it("is true for a fresh database with nothing recorded", async () => {
    await openProject();
    const fresh = openIndex(tmp);
    expect(await isIndexStale(lib.root, fresh, ring)).toBe(true);
    fresh.close();
  });

  it("reads sealed change lines of an unlocked encrypted project; locked ones compare by manifest mtime", async () => {
    const created = await repo.createProject({ name: "Secret", governanceYaml: STRICT_GOV, encryption: { enabled: true, passphrase: "pw" } });
    const pid = created.project.id;
    await repo.createSource(pid, draft("S"), files(), { provenance: prov({ identifiable: true, legal: { status: "consented", basis: "consent form" } }) });
    await rebuildIndex(lib.root, ring, undefined, { library: lib });
    reopen();
    expect(await isIndexStale(lib.root, db, ring)).toBe(false);
    const stamps = JSON.parse(getMeta(db, "projectStamps")!) as Record<string, { mode: string; id?: string }>;
    expect(stamps[pid]!.mode).toBe("changes");
    expect(getMeta(db, "lastChangeId")).toBe(stamps[pid]!.id);

    // a sealed line written by a later (unindexed) change is noticed while the key is in the ring
    const another = await repo.updateSource(pid, (await repo.listSourceIds(pid))[0]!, { publisher: "Q" });
    expect(another.source.publisher).toBe("Q");
    expect(await isIndexStale(lib.root, db, ring)).toBe(true);
    await rebuildIndex(lib.root, ring, undefined, { library: lib });
    reopen();
    expect(await isIndexStale(lib.root, db, ring)).toBe(false);

    // lock: the project's stamp mode changes, so the index is stale until rebuilt, then by mtime
    repo.lockProject(pid);
    expect(await isIndexStale(lib.root, db, ring)).toBe(true);
    await rebuildIndex(lib.root, ring, undefined, { library: lib });
    reopen();
    expect(await isIndexStale(lib.root, db, ring)).toBe(false);
    const manifest = join(lib.root, "Projects", "Secret", "manifest.json");
    const st = await stat(manifest);
    await utimes(manifest, st.atime, new Date(st.mtimeMs + 5000));
    expect(await isIndexStale(lib.root, db, ring)).toBe(true);
  });
});

describe("IndexSink through openRepo", () => {
  it("keeps the index (and its freshness) current across mutations", async () => {
    const pid = await openProject();
    expect(repo.indexErrors).toEqual([]);
    const sf = await repo.createSource(pid, draft("Original words"), files(), { provenance: prov() });
    expect(search(db, { text: "original" }).total).toBe(1);
    expect(db.prepare("SELECT name FROM projects").all()).toEqual([{ name: "P" }]);
    expect(await isIndexStale(lib.root, db, ring)).toBe(false);

    await repo.updateSource(pid, sf.source.id, {
      title: { variants: [{ lang: "en", kind: "original", value: "Changed phrase" }] },
    });
    expect(search(db, { text: "original" }).total).toBe(0);
    expect(search(db, { text: "changed" }).total).toBe(1);
    expect(await isIndexStale(lib.root, db, ring)).toBe(false);

    const tag = await repo.createTag(pid, "x");
    await repo.setMembership(pid, sf.source.id, { tagIds: [tag.id] });
    expect(search(db, { tagIds: [tag.id] }).total).toBe(1);

    await repo.deleteSource(pid, sf.source.id);
    expect(search(db, {}).total).toBe(0);
    expect(search(db, { text: "changed" }).total).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assets").get()).toEqual({ n: 0 });
    expect(repo.indexErrors).toEqual([]);
    expect(await isIndexStale(lib.root, db, ring)).toBe(false);
  });
});

describe("findSourceBy", () => {
  it("finds by platform post, DOI, ISBN (10 or 13) and sha256", async () => {
    const pid = await openProject();
    const hash = "a".repeat(64);
    const yt = await repo.createSource(
      pid,
      draft("Video", { type: "video", identifiers: { platform: "youtube", platformPostId: "abc123" } }),
      files(),
      { provenance: prov({ fileHashes: { "x.mp4": hash } }) },
    );
    const art = await repo.createSource(pid, draft("Article", { identifiers: { doi: "10.1000/XYZ.1" } }), files(), { provenance: prov() });
    const book = await repo.createSource(pid, draft("Book", { type: "book", identifiers: { isbn: ["0-306-40615-2"] } }), files(), { provenance: prov() });
    const rid = (r: Array<{ id: string }>) => r.map((x) => x.id);

    expect(rid(findSourceBy(db, { platform: "youtube", postId: "abc123" }))).toEqual([yt.source.id]);
    expect(findSourceBy(db, { platform: "instagram", postId: "abc123" })).toEqual([]);
    expect(rid(findSourceBy(db, { doi: "https://doi.org/10.1000/xyz.1" }))).toEqual([art.source.id]);
    expect(rid(findSourceBy(db, { doi: "10.1000/XYZ.1" }))).toEqual([art.source.id]);
    expect(findSourceBy(db, { doi: "10.1/none" })).toEqual([]);
    expect(rid(findSourceBy(db, { isbn: "9780306406157" }))).toEqual([book.source.id]);
    expect(rid(findSourceBy(db, { isbn: "0306406152" }))).toEqual([book.source.id]);
    expect(rid(findSourceBy(db, { isbn: "978-0-306-40615-7" }))).toEqual([book.source.id]);
    expect(findSourceBy(db, { isbn: "garbage" })).toEqual([]);
    expect(rid(findSourceBy(db, { sha256: hash }))).toEqual([yt.source.id]);
    // asset hashes (the stored original file) match too
    const assetHash = yt.assets[0]!.sha256;
    expect(rid(findSourceBy(db, { sha256: assetHash }))).toContain(yt.source.id);
    expect(findSourceBy(db, { sha256: "b".repeat(64) })).toEqual([]);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["sources_platform_post", "sources_doi", "sources_isbn13", "source_hashes_sha256"]));
  });
});
