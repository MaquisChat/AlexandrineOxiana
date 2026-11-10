import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
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
  IndexHandle,
  createIndexSink,
  findSourceBy,
  getMeta,
  indexSource,
  isIndexStale,
  openIndex,
  rebuildIndex,
  search,
} from "./index.js";
import { changeLogReads } from "./changes.js";
import { indexProjectEntities, openIndexAt, purgeProject } from "./db.js";
import { indexUnlockedProject } from "./sink.js";
import { stripVtt } from "./load.js";
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
let handle: IndexHandle;
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

async function mkRepo(withSink = true): Promise<Repo> {
  return openTestRepo(lib, ring, {
    clock: () => new Date(NOW),
    tz: "UTC",
    actor: "tester",
    scryptN: 2 ** 10,
    ...(withSink ? { index: createIndexSink(handle, { root: lib.root, keyRing: ring }) } : {}),
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
  handle = new IndexHandle(lib.root);
  repo = await mkRepo();
});

afterEach(async () => {
  try {
    handle.close();
  } catch {
    // already closed
  }
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});


describe("schema", () => {
  it("uses WAL, records schemaVersion 1 and creates the required tables", () => {
    expect(handle.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(getMeta(handle.db, "schemaVersion")).toBe("1");
    const names = (handle.db.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of [
      "projects", "sources", "assets", "collections", "tags", "source_collections", "source_tags", "participants",
      "sessions", "consents", "import_batches", "review_items", "jobs", "meta", "source_text", "source_hashes",
    ]) expect(names).toContain(t);
    // reopening does not re-run migrations
    handle.reopen();
    expect(getMeta(handle.db, "schemaVersion")).toBe("1");
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
    const r = search(handle.db, { text: "cooking" });
    expect(ids(r)).toEqual([es.source.id]);
    expect(r.items[0]!.title).toBe("Cocina familiar y memoria");
    expect(r.items[0]).toMatchObject({ projectId: pid, type: "article-journal", issuedYear: "2025", locked: false, needsReview: false });
    expect(search(handle.db, { text: "cafe" }).items.map((i) => i.id)).toEqual([cafe.source.id]);
    expect(search(handle.db, { text: "CAFÉ" }).total).toBe(1);
    expect(search(handle.db, { text: "fam" }).total).toBe(1); // prefix
    expect(search(handle.db, { text: "memory madrid" }).total).toBe(0); // AND
    expect(search(handle.db, { text: "Smith" }).total).toBe(2); // creators
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

    expect(search(handle.db, {}).total).toBe(3);
    expect(search(handle.db, { text: "   " }).total).toBe(3);
    expect(ids(search(handle.db, { projectId: p1 }))).toEqual([a.source.id, b.source.id].sort());
    expect(ids(search(handle.db, { types: ["book"] }))).toEqual([b.source.id]);
    expect(ids(search(handle.db, { collectionId: col.id }))).toEqual([a.source.id]);
    expect(ids(search(handle.db, { tagIds: [t1.id] }))).toEqual([a.source.id, b.source.id].sort());
    expect(ids(search(handle.db, { tagIds: [t1.id, t2.id] }))).toEqual([a.source.id]);
    expect(ids(search(handle.db, { text: "gamma", projectId: p1 }))).toEqual([]);
    expect(ids(search(handle.db, { text: "gamma", projectId: p2 }))).toEqual([c.source.id]);
    const page = search(handle.db, { limit: 2, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(search(handle.db, { limit: 2, offset: 2 }).items).toHaveLength(1);
  });

  it("keeps extracted text across metadata re-indexing", async () => {
    const pid = await openProject();
    const sf = await repo.createSource(pid, draft("Plain title"), files(), { provenance: prov() });
    // import pipeline path: indexSource with extracted text, then a metadata edit without it
    indexSource(handle.db, sf, "the quick brown fox");
    expect(search(handle.db, { text: "fox" }).total).toBe(1);
    await repo.updateSource(pid, sf.source.id, { publisher: "X" });
    expect(search(handle.db, { text: "fox" }).total).toBe(1);
  });

  it("is safe against FTS5 syntax in user text", async () => {
    const pid = await openProject();
    const a = await repo.createSource(pid, draft("Near and far: a study"), files(), { provenance: prov() });
    await repo.createSource(pid, draft("Something else"), files(), { provenance: prov() });
    const nasty = [
      '"', '""', '"unterminated', "*", "**", "NEAR", "NEAR(a b)", "a NEAR/2 b", "AND", "OR", "NOT", "a OR b", "-far", "far -study",
      "title:foo", "cjk_bigrams:x", "{title_all}:x", "(", ")", "(((", "^far", "far*", "'; DROP TABLE sources; --", "\\", "\u0000", "a\"b",
    ];
    for (const text of nasty) expect(() => search(handle.db, { text }), JSON.stringify(text)).not.toThrow();
    // user text is data: '-far' means the word far, "NEAR" the word near, "*" matches nothing special
    expect(ids(search(handle.db, { text: "-far" }))).toEqual([a.source.id]);
    expect(ids(search(handle.db, { text: "NEAR" }))).toEqual([a.source.id]);
    expect(ids(search(handle.db, { text: '"near" far' }))).toEqual([a.source.id]);
    expect(search(handle.db, { text: "*" }).total).toBe(2); // nothing searchable: filter-only
    expect(search(handle.db, { text: "title:foo" }).total).toBe(0); // 'title' and 'foo' are plain words
    expect(search(handle.db, { text: "far OR nothing" }).total).toBe(0); // OR is a word, not an operator
    expect(buildMatchQuery('x" OR "y')).toBe('"x"* AND "OR"* AND "y"*');
  });

  it("finds CJK text through character bigrams", async () => {
    const pid = await openProject();
    const jp = await repo.createSource(pid, draft([{ lang: "ja", kind: "original", value: "家庭料理の記憶" }]), files(), { provenance: prov() });
    await repo.createSource(pid, draft("English only"), files(), { provenance: prov() });
    expect(ids(search(handle.db, { text: "料理" }))).toEqual([jp.source.id]);
    expect(ids(search(handle.db, { text: "家庭料理の記憶" }))).toEqual([jp.source.id]);
    expect(ids(search(handle.db, { text: "憶" }))).toEqual([jp.source.id]); // last character
    expect(ids(search(handle.db, { text: "料" }))).toEqual([jp.source.id]); // single char
    expect(search(handle.db, { text: "料記" }).total).toBe(0); // not adjacent
    expect(search(handle.db, { text: "料理 english" }).total).toBe(0);
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
    const before = queries.map((q) => search(handle.db, q));
    handle.close();
    for (const s of ["", "-wal", "-shm"]) await rm(join(lib.root, INDEX_FILE + s), { force: true });
    const progress: Array<[number, number]> = [];
    const res = await rebuildIndex(handle, ring, lib, (d, t) => progress.push([d, t]));
    expect(res).toEqual({ indexed: 2, lockedProjects: [], errors: [] });
    expect(progress.at(-1)).toEqual([2, 2]);
    expect(queries.map((q) => search(handle.db, q))).toEqual(before);
    expect((await readdir(lib.root)).filter((f) => f.includes("rebuild"))).toEqual([]);
    expect(await isIndexStale(lib.root, handle.db, ring)).toBe(false);
  });

  it("reports a corrupt source.json and indexes the others", async () => {
    const { pid, a } = await seed();
    const bad = await repo.createSource(pid, draft("Broken one"), files(), { provenance: prov() });
    await writeFile(join(lib.root, bad.source.folder, "source.json"), "{ not json");
    const res = await rebuildIndex(handle, ring, lib);
    expect(res.indexed).toBe(2);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.folder).toBe(bad.source.folder);
    expect(res.errors[0]!.message).toBeTruthy();
    expect(search(handle.db, { text: "cooking" }).items.map((i) => i.id)).toEqual([a.source.id]);
    expect(search(handle.db, { text: "broken" }).total).toBe(0);
  });

  it("refuses to rebuild a read-only library", async () => {
    await expect(rebuildIndex(handle, ring, { mode: "read-only", readOnlyReason: "offline" })).rejects.toBeInstanceOf(
      ReadOnlyLibraryError,
    );
  });

  it("a crash before the rename leaves the old database intact; the next rebuild cleans up", async () => {
    await seed();
    const before = search(handle.db, { text: "cooking" });
    handle.close();
    const oldBytes = await readFile(join(lib.root, INDEX_FILE));
    await expect(
      rebuildIndex(handle, ring, lib, undefined, {
        beforeRename: () => {
          throw new Error("power cut");
        },
      }),
    ).rejects.toThrow("power cut");
    expect(await readFile(join(lib.root, INDEX_FILE))).toEqual(oldBytes);
    expect((await readdir(lib.root)).filter((f) => f.includes("rebuild"))).toEqual([]);
    expect(search(handle.db, { text: "cooking" })).toEqual(before);

    // a hard kill leaves the temp file behind; the old DB still works and the next rebuild removes it
    await writeFile(join(lib.root, `${INDEX_FILE}.rebuild-dead`), "garbage");
    await rebuildIndex(handle, ring, lib);
    expect((await readdir(lib.root)).filter((f) => f.includes("rebuild"))).toEqual([]);
    expect(search(handle.db, { text: "cooking" })).toEqual(before);
  });

  it("a failure while building (progress callback throws) leaves the old database intact", async () => {
    await seed();
    handle.close();
    const oldBytes = await readFile(join(lib.root, INDEX_FILE));
    await expect(
      rebuildIndex(handle, ring, lib, (d) => {
        if (d === 1) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await readFile(join(lib.root, INDEX_FILE))).toEqual(oldBytes);
    expect((await readdir(lib.root)).filter((f) => f.includes("rebuild"))).toEqual([]);
  });

  it("indexes a locked project from the manifest only: type and year, no titles, no text", async () => {
    const created = await repo.createProject({ name: "Secret", governanceYaml: STRICT_GOV, encryption: { enabled: true, passphrase: "pw" } });
    const pid = created.project.id;
    const sf = await repo.createSource(pid, draft("Very identifying title", { type: "interview" }), files(), {
      provenance: prov({ identifiable: true, legal: { status: "consented", basis: "consent form" } }),
    });
    expect(search(handle.db, { text: "identifying" }).total).toBe(1); // unlocked: indexed
    repo.lockProject(pid);
    const res = await rebuildIndex(handle, ring, lib);
    expect(res.lockedProjects).toEqual([pid]);
    expect(res.indexed).toBe(1);
    expect(search(handle.db, { text: "identifying" }).total).toBe(0);
    const rows = search(handle.db, { projectId: pid }).items;
    expect(rows).toEqual([
      { id: sf.source.id, projectId: pid, type: "interview", title: "", creatorsText: "", issuedYear: "2025", folder: sf.source.folder, needsReview: false, locked: true },
    ]);
    // nothing identifying anywhere in the database file
    const raw = (await readFile(join(lib.root, INDEX_FILE))).toString("latin1");
    // (the folder name, taken from the plaintext manifest, is the only place a title can appear)
    expect(handle.db.prepare("SELECT COUNT(*) AS n FROM source_text").get()).toEqual({ n: 0 });
    expect(raw).not.toContain("Smith");
    // unlocking and rebuilding indexes it fully
    await repo.unlockProject(pid, "pw");
    const res2 = await rebuildIndex(handle, ring, lib);
    expect(res2.lockedProjects).toEqual([]);
    expect(search(handle.db, { text: "identifying" }).items[0]).toMatchObject({ id: sf.source.id, locked: false, title: "Very identifying title" });
  });
});

describe("isIndexStale", () => {
  it("is true after an extra change is appended to the change log", async () => {
    const pid = await openProject();
    await repo.createSource(pid, draft("A"), files(), { provenance: prov() });
    await rebuildIndex(handle, ring, lib);
    expect(await isIndexStale(lib.root, handle.db, ring)).toBe(false);
    const dir = join(lib.root, "Projects", "P", "changes");
    const file = (await readdir(dir))[0]!;
    const change = { id: newId(), at: NOW, author: "x", device: "d", projectId: pid, entity: { type: "source", id: newId() }, op: "delete" };
    await appendFile(join(dir, file), `${JSON.stringify(change)}\n`);
    expect(await isIndexStale(lib.root, handle.db, ring)).toBe(true);
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
    await rebuildIndex(handle, ring, lib);
    expect(await isIndexStale(lib.root, handle.db, ring)).toBe(false);
    const stamps = JSON.parse(getMeta(handle.db, "projectStamps")!) as Record<string, { mode: string; id?: string }>;
    expect(stamps[pid]!.mode).toBe("changes");
    expect(getMeta(handle.db, "lastChangeId")).toBe(stamps[pid]!.id);

    // a sealed line written by a later (unindexed) change is noticed while the key is in the ring
    // a change made by something that does not feed the index (no sink)
    const plain = await mkRepo(false);
    const another = await plain.updateSource(pid, plain.listSourceIds(pid)[0]!, { publisher: "Q" });
    expect(another.source.publisher).toBe("Q");
    expect(await isIndexStale(lib.root, handle.db, ring)).toBe(true);
    await rebuildIndex(handle, ring, lib);
    expect(await isIndexStale(lib.root, handle.db, ring)).toBe(false);

    // lock: the project's stamp mode changes, so the index is stale until rebuilt, then by mtime
    repo.lockProject(pid);
    expect(await isIndexStale(lib.root, handle.db, ring)).toBe(true);
    await rebuildIndex(handle, ring, lib);
    expect(await isIndexStale(lib.root, handle.db, ring)).toBe(false);
    const manifest = join(lib.root, "Projects", "Secret", "manifest.json");
    const st = await stat(manifest);
    await utimes(manifest, st.atime, new Date(st.mtimeMs + 5000));
    expect(await isIndexStale(lib.root, handle.db, ring)).toBe(true);
  });
});

describe("IndexSink through openRepo", () => {
  it("keeps the index (and its freshness) current across mutations", async () => {
    const pid = await openProject();
    expect(repo.indexErrors).toEqual([]);
    const sf = await repo.createSource(pid, draft("Original words"), files(), { provenance: prov() });
    expect(search(handle.db, { text: "original" }).total).toBe(1);
    expect(handle.db.prepare("SELECT name FROM projects").all()).toEqual([{ name: "P" }]);
    expect(await isIndexStale(lib.root, handle.db, ring)).toBe(false);

    await repo.updateSource(pid, sf.source.id, {
      title: { variants: [{ lang: "en", kind: "original", value: "Changed phrase" }] },
    });
    expect(search(handle.db, { text: "original" }).total).toBe(0);
    expect(search(handle.db, { text: "changed" }).total).toBe(1);
    expect(await isIndexStale(lib.root, handle.db, ring)).toBe(false);

    const tag = await repo.createTag(pid, "x");
    await repo.setMembership(pid, sf.source.id, { tagIds: [tag.id] });
    expect(search(handle.db, { tagIds: [tag.id] }).total).toBe(1);

    await repo.deleteSource(pid, sf.source.id);
    expect(search(handle.db, {}).total).toBe(0);
    expect(search(handle.db, { text: "changed" }).total).toBe(0);
    expect(handle.db.prepare("SELECT COUNT(*) AS n FROM assets").get()).toEqual({ n: 0 });
    expect(repo.indexErrors).toEqual([]);
    expect(await isIndexStale(lib.root, handle.db, ring)).toBe(false);
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

    expect(rid(findSourceBy(handle.db, { platform: "youtube", postId: "abc123" }))).toEqual([yt.source.id]);
    expect(findSourceBy(handle.db, { platform: "instagram", postId: "abc123" })).toEqual([]);
    expect(rid(findSourceBy(handle.db, { doi: "https://doi.org/10.1000/xyz.1" }))).toEqual([art.source.id]);
    expect(rid(findSourceBy(handle.db, { doi: "10.1000/XYZ.1" }))).toEqual([art.source.id]);
    expect(findSourceBy(handle.db, { doi: "10.1/none" })).toEqual([]);
    expect(rid(findSourceBy(handle.db, { isbn: "9780306406157" }))).toEqual([book.source.id]);
    expect(rid(findSourceBy(handle.db, { isbn: "0306406152" }))).toEqual([book.source.id]);
    expect(rid(findSourceBy(handle.db, { isbn: "978-0-306-40615-7" }))).toEqual([book.source.id]);
    expect(findSourceBy(handle.db, { isbn: "garbage" })).toEqual([]);
    expect(rid(findSourceBy(handle.db, { sha256: hash }))).toEqual([yt.source.id]);
    // asset hashes (the stored original file) match too
    const assetHash = yt.assets[0]!.sha256;
    expect(rid(findSourceBy(handle.db, { sha256: assetHash }))).toContain(yt.source.id);
    expect(findSourceBy(handle.db, { sha256: "b".repeat(64) })).toEqual([]);
    const idx = (handle.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["sources_platform_post", "sources_doi", "sources_isbn13", "source_hashes_sha256"]));
  });
});

const SECRET_GOV_LEGAL = { status: "consented" as const, basis: "consent form" };

async function rawIndexBytes(): Promise<string> {
  let out = "";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      out += (await readFile(join(lib.root, INDEX_FILE + suffix))).toString("latin1");
    } catch {
      // side file absent
    }
  }
  return out;
}

describe("R30: encrypted content stays out of the persistent database", () => {
  it("indexes in memory only, purges on lock, and finds the source again after unlock", async () => {
    const created = await repo.createProject({ name: "Secret", governanceYaml: STRICT_GOV, encryption: { enabled: true, passphrase: "pw" } });
    const pid = created.project.id;
    const extra = join(tmp, "ocr.txt");
    await writeFile(extra, "zzquuxtranscript distinctive body text");
    const sf = await repo.createSource(
      pid,
      draft("Wolfsbane Interview Qxzv", {
        type: "interview",
        creators: [{ family: "Zzyzxfamily", given: "Pelagia", role: "interviewee" }],
        identifiers: { doi: "10.9999/secret-doi", isbn: ["9780306406157"], platform: "other", platformPostId: "secretpost" },
      }),
      files(),
      { provenance: prov({ identifiable: true, legal: SECRET_GOV_LEGAL, fileHashes: { "a.mp3": "c".repeat(64) } }) },
    );
    await repo.addDerivedAsset(pid, sf.source.id, {
      fromPath: extra, kind: "ocr-text", tool: "t", ext: "txt",
      derivation: { parents: [], operation: "ocr", provider: "local", ranAt: "local", params: {}, at: NOW, triggeredBy: "tester" },
    });
    const col = await repo.createCollection(pid, "Qcollectionname");
    expect(col.name).toBe("Qcollectionname");

    // everything is searchable while unlocked, by every key
    expect(search(handle.db, { text: "Wolfsbane" }).items[0]).toMatchObject({ id: sf.source.id, locked: false, title: "Wolfsbane Interview Qxzv" });
    expect(search(handle.db, { text: "Zzyzxfamily" }).total).toBe(1);
    expect(search(handle.db, { text: "zzquuxtranscript" }).total).toBe(1);
    expect(findSourceBy(handle.db, { doi: "10.9999/secret-doi" })).toHaveLength(1);
    expect(findSourceBy(handle.db, { isbn: "9780306406157" })).toHaveLength(1);
    expect(findSourceBy(handle.db, { platform: "other", postId: "secretpost" })).toHaveLength(1);
    expect(findSourceBy(handle.db, { sha256: "c".repeat(64) })).toHaveLength(1);

    const secrets = ["Wolfsbane", "Zzyzxfamily", "Pelagia", "zzquuxtranscript", "secret-doi", "secretpost", "Qcollectionname", "c".repeat(64)];
    // while unlocked the persistent file already holds none of it (it is in memory only)
    handle.db.pragma("wal_checkpoint(TRUNCATE)");
    let raw = await rawIndexBytes();
    // folder names come from the plaintext manifest; mask them before looking for the title
    raw = raw.split(sf.source.folder).join("<folder>");
    for (const x of secrets) expect(raw, x).not.toContain(x);

    repo.lockProject(pid);
    handle.db.pragma("wal_checkpoint(TRUNCATE)");
    raw = (await rawIndexBytes()).split(sf.source.folder).join("<folder>");
    for (const x of secrets) expect(raw, x).not.toContain(x);
    expect(search(handle.db, { text: "Wolfsbane" }).total).toBe(0);
    expect(search(handle.db, { text: "zzquuxtranscript" }).total).toBe(0);
    expect(findSourceBy(handle.db, { doi: "10.9999/secret-doi" })).toEqual([]);
    expect(findSourceBy(handle.db, { sha256: "c".repeat(64) })).toEqual([]);
    expect(handle.db.prepare("SELECT COUNT(*) AS n FROM temp.t_sources").get()).toEqual({ n: 0 });
    expect(handle.db.prepare("SELECT COUNT(*) AS n FROM temp.t_collections").get()).toEqual({ n: 0 });
    // manifest-level row remains
    expect(search(handle.db, { projectId: pid }).items).toEqual([
      { id: sf.source.id, projectId: pid, type: "interview", title: "", creatorsText: "", issuedYear: "2025", folder: sf.source.folder, needsReview: false, locked: true },
    ]);

    await repo.unlockProject(pid, "pw");
    expect(repo.indexErrors).toEqual([]);
    expect(search(handle.db, { text: "Wolfsbane" }).items[0]).toMatchObject({ id: sf.source.id, locked: false });
    expect(search(handle.db, { text: "zzquuxtranscript" }).total).toBe(1);
    expect(findSourceBy(handle.db, { isbn: "9780306406157" })).toHaveLength(1);
    handle.db.pragma("wal_checkpoint(TRUNCATE)");
    raw = (await rawIndexBytes()).split(sf.source.folder).join("<folder>");
    for (const x of secrets) expect(raw, x).not.toContain(x);
  });

  it("a rebuild with the project unlocked keeps it searchable (in memory) and persists nothing sensitive", async () => {
    const pid = (await repo.createProject({ name: "Secret", governanceYaml: STRICT_GOV, encryption: { enabled: true, passphrase: "pw" } })).project.id;
    const sf = await repo.createSource(pid, draft("Rebuilt Wolfsbane"), files(), { provenance: prov({ identifiable: true, legal: SECRET_GOV_LEGAL }) });
    await rebuildIndex(handle, ring, lib);
    expect(search(handle.db, { text: "wolfsbane" }).items[0]).toMatchObject({ id: sf.source.id, locked: false });
    handle.db.pragma("wal_checkpoint(TRUNCATE)");
    const raw = (await rawIndexBytes()).split(sf.source.folder).join("<folder>");
    expect(raw).not.toContain("Wolfsbane");
  });
});

describe("review fixes", () => {
  it("I1: every valid ISBN is findable; invalid ones are skipped", async () => {
    const pid = await openProject();
    const b = await repo.createSource(
      pid,
      draft("Two editions", { type: "book", identifiers: { isbn: ["978-0-306-40615-7", "9780306406158", "0-306-40615-2", "0-19-852663-6"] } }),
      files(),
      { provenance: prov() },
    );
    expect(findSourceBy(handle.db, { isbn: "9780306406157" }).map((r) => r.id)).toEqual([b.source.id]);
    expect(findSourceBy(handle.db, { isbn: "0198526636" }).map((r) => r.id)).toEqual([b.source.id]); // the second, distinct ISBN
    expect(findSourceBy(handle.db, { isbn: "9780198526636" }).map((r) => r.id)).toEqual([b.source.id]);
    expect(findSourceBy(handle.db, { isbn: "9780306406158" })).toEqual([]); // bad check digit
    expect(handle.db.prepare("SELECT COUNT(*) AS n FROM source_isbns").get()).toEqual({ n: 2 });
  });

  it("I2: sink writes after a rebuild land in the new database, and no WAL is orphaned", async () => {
    const pid = await openProject();
    await repo.createSource(pid, draft("Before rebuild"), files(), { provenance: prov() });
    await rebuildIndex(handle, ring, lib);
    expect(handle.isOpen).toBe(true);
    await repo.createSource(pid, draft("After rebuild"), files(), { provenance: prov() });
    expect(search(handle.db, { text: "after" }).total).toBe(1);
    handle.close();
    expect((await readdir(lib.root)).filter((f) => f.startsWith(INDEX_FILE)).sort()).toEqual([INDEX_FILE]);
    const other = openIndexAt(join(lib.root, INDEX_FILE));
    expect(search(other, { text: "after" }).total).toBe(1);
    expect(search(other, { text: "before" }).total).toBe(1);
    other.close();
    handle.reopen();
  });

  it("I2: a checkpoint that cannot complete aborts the rebuild with the old database intact", async () => {
    const pid = await openProject();
    await repo.createSource(pid, draft("Keep me"), files(), { provenance: prov() });
    // a reader pinned to an old snapshot keeps the WAL from being truncated
    const reader = openIndexAt(join(lib.root, INDEX_FILE));
    reader.prepare("BEGIN").run();
    reader.prepare("SELECT COUNT(*) FROM meta").get();
    await repo.createSource(pid, draft("Written after the snapshot"), files(), { provenance: prov() });
    await expect(rebuildIndex(handle, ring, lib)).rejects.toThrow(/checkpoint/);
    reader.close();
    expect(handle.isOpen).toBe(true);
    expect(search(handle.db, { text: "snapshot" }).total).toBe(1);
    expect((await readdir(lib.root)).filter((f) => f.includes("rebuild"))).toEqual([]);
  });

  it("I3: a read-only library cannot rebuild and the index is untouched", async () => {
    const pid = await openProject();
    await repo.createSource(pid, draft("Stays"), files(), { provenance: prov() });
    await expect(rebuildIndex(handle, ring, { mode: "read-only", readOnlyReason: "offline" })).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    expect(search(handle.db, { text: "stays" }).total).toBe(1);
  });

  it("I4: rebuild carries review_items, import_batches and jobs over", async () => {
    const pid = await openProject();
    handle.db.prepare("INSERT INTO review_items VALUES ('r1', ?, NULL, NULL, 'import', 'pending', '{\"a\":1}', ?)").run(pid, NOW);
    handle.db.prepare("INSERT INTO import_batches VALUES ('b1', ?, 1, ?, NULL, '{}')").run(pid, NOW);
    handle.db.prepare("INSERT INTO jobs VALUES ('j1', ?, 'ocr', 'queued', '{}', ?)").run(pid, NOW);
    await rebuildIndex(handle, ring, lib);
    expect(handle.db.prepare("SELECT id, kind, status, payload_json FROM review_items").all()).toEqual([
      { id: "r1", kind: "import", status: "pending", payload_json: '{"a":1}' },
    ]);
    expect(handle.db.prepare("SELECT id FROM import_batches").all()).toEqual([{ id: "b1" }]);
    expect(handle.db.prepare("SELECT id FROM jobs").all()).toEqual([{ id: "j1" }]);
  });

  it("I5: rebuild restores extracted text from ocr-text and transcript (.vtt) assets, plain and encrypted", async () => {
    const pid = await openProject();
    const sf = await repo.createSource(pid, draft("Has derived"), files(), { provenance: prov() });
    const ocr = join(tmp, "o.txt");
    await writeFile(ocr, "older ocr words");
    const ocr2 = join(tmp, "o2.txt");
    await writeFile(ocr2, "newest ocr marmalade");
    const vtt = join(tmp, "t.vtt");
    await writeFile(vtt, "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\n<v Bob>spoken pineapple</v>\n\nNOTE hidden remark\n\n2\n00:00:04.000 --> 00:00:05.000\nsecond cue\n");
    const mk = (fromPath: string, kind: string, ext: string, at: string) => ({
      fromPath, kind, tool: "t", ext,
      derivation: { parents: [], operation: kind, provider: "local", ranAt: "local", params: {}, at, triggeredBy: "tester" },
    });
    await repo.addDerivedAsset(pid, sf.source.id, mk(ocr, "ocr-text", "txt", "2026-11-09T10:00:00.000Z"));
    await repo.addDerivedAsset(pid, sf.source.id, mk(ocr2, "ocr-text", "txt", "2026-11-09T11:00:00.000Z"));
    await repo.addDerivedAsset(pid, sf.source.id, mk(vtt, "transcript", "vtt", "2026-11-09T11:00:00.000Z"));
    expect(search(handle.db, { text: "marmalade" }).total).toBe(1); // live sink path
    await rebuildIndex(handle, ring, lib);
    expect(search(handle.db, { text: "marmalade" }).total).toBe(1);
    expect(search(handle.db, { text: "pineapple" }).total).toBe(1);
    expect(search(handle.db, { text: "older" }).total).toBe(0); // only the newest ocr-text
    expect(search(handle.db, { text: "hidden" }).total).toBe(0); // NOTE blocks stripped
    expect(search(handle.db, { text: "Bob" }).total).toBe(0); // markup stripped
    expect(search(handle.db, { text: "second cue" }).total).toBe(1);
    expect(stripVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start\nhi <b>there</b>\n")).toBe("hi there");

    // encrypted project: restored into memory only
    const epid = (await repo.createProject({ name: "Enc", governanceYaml: STRICT_GOV, encryption: { enabled: true, passphrase: "pw" } })).project.id;
    const es = await repo.createSource(epid, draft("Enc source"), files(), { provenance: prov({ identifiable: true, legal: SECRET_GOV_LEGAL }) });
    await repo.addDerivedAsset(epid, es.source.id, mk(ocr2, "ocr-text", "txt", "2026-11-09T11:00:00.000Z"));
    await rebuildIndex(handle, ring, lib);
    expect(search(handle.db, { text: "marmalade", projectId: epid }).total).toBe(1);
  });

  it("I6: a mutation reads only its own project's change log", async () => {
    const p1 = await openProject("One");
    const p2 = await openProject("Two");
    await repo.createSource(p2, draft("Other"), files(), { provenance: prov() });
    changeLogReads.length = 0;
    await repo.createSource(p1, draft("Mine"), files(), { provenance: prov() });
    expect(changeLogReads.length).toBeGreaterThan(0);
    expect(new Set(changeLogReads)).toEqual(new Set(["Projects/One"]));
    expect(await isIndexStale(lib.root, handle.db, ring)).toBe(false);
  });

  it("minor: terms without letters or digits are dropped; sha256 is case-insensitive", async () => {
    const pid = await openProject();
    const hash = "ab".repeat(32);
    const s = await repo.createSource(pid, draft("Un Café"), files(), { provenance: prov({ fileHashes: { x: hash } }) });
    expect(search(handle.db, { text: "cafe \u0301" }).items.map((i) => i.id)).toEqual([s.source.id]);
    expect(buildMatchQuery("\u0301 !!")).toBeUndefined();
    expect(findSourceBy(handle.db, { sha256: hash.toUpperCase() })).toHaveLength(1);
    expect(findSourceBy(handle.db, { sha256: hash })).toHaveLength(1);
  });
});

describe("fix round 2", () => {
  async function encProject(name: string, title: string) {
    const pid = (await repo.createProject({ name, governanceYaml: STRICT_GOV, encryption: { enabled: true, passphrase: "pw" } })).project.id;
    const sf = await repo.createSource(pid, draft(title, { identifiers: { doi: `10.1/${name.toLowerCase()}` } }), files(), {
      provenance: prov({ identifiable: true, legal: SECRET_GOV_LEGAL }),
    });
    return { pid, sf };
  }

  it("1: a rename failure after the connection was closed still reloads unlocked encrypted projects", async () => {
    const { sf } = await encProject("E1", "Persisting Wolfsbane");
    await expect(
      rebuildIndex(handle, ring, lib, undefined, {
        afterClose: () => {
          throw new Error("rename failed");
        },
      }),
    ).rejects.toThrow("rename failed");
    expect(handle.isOpen).toBe(true);
    expect(search(handle.db, { text: "wolfsbane" }).items[0]).toMatchObject({ id: sf.source.id, locked: false });
    expect(findSourceBy(handle.db, { doi: "10.1/e1" })).toHaveLength(1);
  });

  it("1: a reload failure in one project does not skip the others and is reported", async () => {
    const a = await encProject("E1", "First Wolfsbane");
    const b = await encProject("E2", "Second Wolfsbane");
    const res = await rebuildIndex(handle, ring, lib, undefined, {
      reloadProject: async (db, root, keyRing, pid) => {
        if (pid === a.pid) throw new Error("reload boom");
        return indexUnlockedProject(db, root, keyRing, pid);
      },
    });
    expect(res.errors).toEqual([{ folder: "Projects/E1", message: "reload boom" }]);
    expect(search(handle.db, { text: "second" }).items.map((i) => i.id)).toEqual([b.sf.source.id]);
    expect(findSourceBy(handle.db, { doi: "10.1/e2" })).toHaveLength(1);
  });

  it("2: locking while a project is being loaded leaves nothing in memory", async () => {
    const { pid } = await encProject("E1", "Racy Wolfsbane");
    await repo.createSource(pid, draft("Another racy one"), files(), { provenance: prov({ identifiable: true, legal: SECRET_GOV_LEGAL }) });
    repo.lockProject(pid);
    await repo.unlockProject(pid, "pw");
    expect(search(handle.db, { text: "racy" }).total).toBe(2);
    let reads = 0;
    await indexUnlockedProject(handle.db, lib.root, ring, pid, {
      afterRead: () => {
        if (++reads === 1) repo.lockProject(pid);
      },
    });
    for (const t of ["t_sources", "t_source_text", "t_assets", "t_source_hashes", "t_collections", "t_tags"]) {
      expect(handle.db.prepare(`SELECT COUNT(*) AS n FROM temp.${t}`).get(), t).toEqual({ n: 0 });
    }
    expect(search(handle.db, { text: "racy" }).total).toBe(0);
    expect(reads).toBe(1);
  });

  it("3: purge removes the project's tags whatever their scope, and other rows keyed by it", async () => {
    const pid = newId();
    const other = newId();
    const mk = (project: string) => ({
      project: { id: project },
      collections: [{ id: newId(), projectId: project, name: "c" }],
      tags: [
        { id: newId(), scope: "workspace" as const, name: "ws tag" },
        { id: newId(), scope: project, name: "own tag" },
      ],
      participants: [{ id: newId(), projectId: project, code: "P-1", consentIds: [] }],
      sessions: [{ id: newId(), projectId: project, date: "2026-01-01", participantIds: [] }],
      consents: [{ id: newId(), projectId: project, participantId: newId(), scope: "s", date: "2026-01-01" }],
    });
    indexProjectEntities(handle.db, mk(pid), true);
    indexProjectEntities(handle.db, mk(other), true);
    purgeProject(handle.db, pid);
    expect(handle.db.prepare("SELECT project_id FROM temp.t_tags ORDER BY name").all()).toEqual([
      { project_id: other },
      { project_id: other },
    ]);
    for (const t of ["t_collections", "t_participants", "t_sessions", "t_consents"]) {
      expect(handle.db.prepare(`SELECT DISTINCT project_id FROM temp.${t}`).all(), t).toEqual([{ project_id: other }]);
    }
  });
});
