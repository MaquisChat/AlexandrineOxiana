/**
 * Task R3: governed annotation operations (list, create, update, delete one source's annotations).
 * Every change is one governed, audited, crash-safe change (R26); audit entries hold ids, kinds,
 * counts and field names only, never a quote or a note (R177); the per-source caps are enforced
 * whole (R74 I4).
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Annotation, type AuditEvent, type Provenance, type SourceDraft, type SourceFile } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { IndexHandle, createIndexSink, search } from "../index/index.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { isPdfMime } from "../asset-content.js";
import { MAX_SOURCE_ANNOTATION_TEXT, MAX_SOURCE_ANNOTATIONS } from "../import/bulk/update.js";
import {
  ANNOTATION_CREATE_OP,
  ANNOTATION_DELETE_OP,
  ANNOTATION_UPDATE_OP,
  AnnotationLimitError,
  type AnnotationDraft,
  type AnnotationPatch,
} from "./annotations.js";
import { InvalidInputError, NotFoundError, PolicyDeniedError, ProjectLockedError, ReadOnlyLibraryError } from "./errors.js";
import type { Repo } from "./index.js";
import { importChange } from "./repo.js";
import { pauseBetweenSourceFilesForTests } from "./sources.js";
import { SimulatedCrash, openTestRepo, seams, type CrashPoint } from "./testing.js";

/**
 * A hold point between an operation's pre-read (its read of the source OUTSIDE the write queue, for
 * the policy request) and its entry into the queue: the next such read, once set, waits on `hold`.
 * The library's own code is unchanged; only this test file's view of `readSourceFile` is wrapped.
 */
const preRead = vi.hoisted(() => ({ hold: undefined as undefined | (() => Promise<void>) }));
vi.mock("./sources.js", async (orig) => {
  const m = await orig<typeof import("./sources.js")>();
  return {
    ...m,
    readSourceFile: async (...args: Parameters<typeof m.readSourceFile>) => {
      const sf = await m.readSourceFile(...args);
      const hold = preRead.hold;
      if (hold && !args[0].holdsTurn()) {
        preRead.hold = undefined;
        await hold();
      }
      return sf;
    },
  };
});

const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
`;
const NOW = "2026-11-13T10:00:00.000Z";
const PASS = "correct horse battery staple";
/** Planted text that must never reach an audit entry. */
const QUOTE = "PLANTED-QUOTE-qx7zv";
const NOTE = "PLANTED-NOTE-kw3jm";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let handle: IndexHandle;
let pdf: string;
let txt: string;
let repo: Repo;

const mkDeps = (): Deps => ({
  clock: () => new Date(NOW),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
});
const repoFor = (l: Library = lib): Promise<Repo> =>
  openTestRepo(l, ring, {
    clock: () => new Date(NOW),
    tz: "UTC",
    actor: "tester",
    scryptN: 2 ** 10,
    index: createIndexSink(handle, { root: l.root, keyRing: ring }),
  });
const draft = (title: string): SourceDraft => ({
  projectIds: [],
  type: "article-journal",
  title: { variants: [{ lang: "en", kind: "original", value: title }] },
  creators: [],
  identifiers: {},
  caseAttributes: {},
  availability: { status: "available" },
  collectionIds: [],
  tagIds: [],
  participantIds: [],
});
const provenance = (): Provenance => ({ captureMethod: "manual_upload", capturedAt: NOW, tool: { name: "ao", version: "0" }, fileHashes: {}, legal: { status: "public" }, identifiable: false });
const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-annotations-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  handle = new IndexHandle(lib.root);
  pdf = join(tmp, "in.pdf");
  await writeFile(pdf, "%PDF-1.7\nhello\n%%EOF\n");
  txt = join(tmp, "notes.txt");
  await writeFile(txt, "plain text");
  repo = await repoFor();
});
afterEach(async () => {
  seams.crashAt = undefined;
  seams.failAuditAppendFor = undefined;
  preRead.hold = undefined;
  pauseBetweenSourceFilesForTests(undefined);
  handle.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

interface Fixture {
  pid: string;
  projectFolder: string;
  sid: string;
  folder: string;
  assetId: string;
  txtAssetId: string;
}

async function fixture(opts: { encrypted?: boolean } = {}): Promise<Fixture> {
  const project = (
    await repo.createProject({ name: opts.encrypted ? "Sealed" : "P", governanceYaml: OPEN_GOV, encryption: opts.encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } })
  ).project;
  const sf = await repo.createSource(
    project.id,
    draft("Annotated"),
    [
      { path: pdf, role: "original", handling: "copy" },
      { path: txt, role: "original", handling: "copy" },
    ],
    { provenance: provenance() },
  );
  return { pid: project.id, projectFolder: project.folder, sid: sf.source.id, folder: sf.source.folder, assetId: sf.assets[0]!.id, txtAssetId: sf.assets[1]!.id };
}

const highlight = (f: Fixture, over: Partial<AnnotationDraft> = {}): AnnotationDraft => ({
  kind: "highlight",
  assetId: f.assetId,
  anchors: [{ page: 3, rects: [{ x: 72, y: 600, w: 200, h: 12 }] }],
  quote: QUOTE,
  colorName: "yellow",
  ...over,
});

async function auditText(projectFolder: string): Promise<string> {
  const dir = join(lib.root, projectFolder, "audit");
  let out = "";
  for (const f of (await readdir(dir)).sort()) out += await readFile(join(dir, f), "utf8");
  return out;
}
async function auditEvents(projectFolder: string): Promise<AuditEvent[]> {
  return (await auditText(projectFolder))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuditEvent);
}
const annotationEvents = async (projectFolder: string) => (await auditEvents(projectFolder)).filter((e) => String(e.details?.op ?? "").startsWith("annotation."));

/** Every file under `dir` with the SHA-256 of its content. */
async function snapshot(dir: string, base = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, await snapshot(join(dir, e.name), rel));
    else out[rel] = createHash("sha256").update(await readFile(join(dir, e.name))).digest("hex");
  }
  return out;
}
const txnMarkers = async () => (await readdir(join(lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => /^txn-.*\.json$/.test(n));

/** Replaces a source's annotations directly through one governed change (seeding a big source). */
const seed = (pid: string, sid: string, make: (sid: string) => Annotation[]) =>
  importChange(repo, pid, STORE, async (ops) => {
    const cur = await ops.readSource(sid);
    await ops.writeSource(cur, { ...cur, annotations: make(sid) });
  }, { op: "test.seed" });
const seedNote = (sid: string, body: string, extra: Partial<Annotation> = {}): Annotation => ({ id: newId(), sourceId: sid, kind: "note", anchors: [], body, author: "zotero-user", createdAt: NOW, ...extra });

describe("create", () => {
  it("create writes annotations.json once and audits ids and counts only", async () => {
    const f = await fixture();
    const before = (await annotationEvents(f.projectFolder)).length;
    const a = await repo.createAnnotation(f.pid, f.sid, highlight(f, {
      anchors: [
        { page: 5, rects: [{ x: 72, y: 700, w: 100, h: 12 }] },
        { page: 4, rects: [{ x: 72, y: 60, w: 100, h: 12 }], sortIndex: "00003|000120|00700" },
      ],
      body: NOTE,
      pageLabel: "iv",
    }));
    expect(a).toMatchObject({ sourceId: f.sid, kind: "highlight", quote: QUOTE, body: NOTE, colorName: "yellow", pageLabel: "iv", author: "tester", createdAt: NOW });
    // Anchors stored in page order, each a pdf anchor on the draft's asset with an id set here.
    expect(a.anchors.map((x) => (x.kind === "pdf" ? x.page : 0))).toEqual([4, 5]);
    expect(a.anchors.every((x) => x.kind === "pdf" && x.assetId === f.assetId && typeof x.id === "string")).toBe(true);
    expect(a.anchors[0]).toMatchObject({ sortIndex: "00003|000120|00700" });
    // The annotations file holds it; source.json counts it.
    const onDisk = JSON.parse(await readFile(join(lib.root, f.folder, "annotations.json"), "utf8")) as Annotation[];
    expect(onDisk).toEqual([a]);
    const stored = JSON.parse(await readFile(join(lib.root, f.folder, "source.json"), "utf8")) as SourceFile;
    expect(stored.annotationCount).toBe(1);
    expect(await repo.listAnnotations(f.pid, f.sid)).toEqual([a]);
    // One audit entry, about the source, with ids and counts only.
    const evs = await annotationEvents(f.projectFolder);
    expect(evs).toHaveLength(before + 1);
    const ev = evs[evs.length - 1]!;
    expect(ev.action).toBe("store");
    expect(ev.entity).toEqual({ type: "source", id: f.sid });
    expect(ev.decision).toEqual({ result: "allow" });
    const { txn, changes, ...rest } = ev.details as Record<string, unknown>;
    expect(typeof txn).toBe("string");
    expect(typeof changes).toBe("number");
    expect(rest).toEqual({ op: ANNOTATION_CREATE_OP, annotation: a.id, kind: "highlight", anchorCount: 2, hasNote: true });
    const raw = await auditText(f.projectFolder);
    expect(raw).not.toContain(QUOTE);
    expect(raw).not.toContain(NOTE);
    expect(raw).not.toContain('"iv"');
  });

  it("a note needs a non-blank body", async () => {
    const f = await fixture();
    const snap = await snapshot(join(lib.root, f.projectFolder));
    await expect(repo.createAnnotation(f.pid, f.sid, { kind: "note", assetId: f.assetId, anchors: [{ page: 1, rects: [{ x: 10, y: 10, w: 0, h: 0 }] }], body: "  \n ", colorName: "yellow" })).rejects.toThrow(
      new InvalidInputError("Write the note first."),
    );
    const n = await repo.createAnnotation(f.pid, f.sid, { kind: "note", assetId: f.assetId, anchors: [{ page: 1, rects: [{ x: 10, y: 10, w: 0, h: 0 }] }], body: NOTE, colorName: "blue" });
    expect(n).toMatchObject({ kind: "note", body: NOTE, colorName: "blue" });
    expect(snap).not.toEqual(await snapshot(join(lib.root, f.projectFolder)));
  });

  it("refuses malformed anchors, rectangles and over-long text, writing nothing", async () => {
    const f = await fixture();
    const snap = await snapshot(join(lib.root, f.projectFolder));
    const r = (x: number, y: number, w = 10, h = 10) => ({ x, y, w, h });
    const bad: AnnotationDraft[] = [
      highlight(f, { anchors: [] }),
      highlight(f, { anchors: Array.from({ length: 51 }, (_, i) => ({ page: i + 1, rects: [r(1, 1)] })) }),
      highlight(f, { anchors: [{ page: 2, rects: [r(1, 1)] }, { page: 2, rects: [r(5, 5)] }] }),
      highlight(f, { anchors: [{ page: 0, rects: [r(1, 1)] }] }),
      highlight(f, { anchors: [{ page: 100_001, rects: [r(1, 1)] }] }),
      highlight(f, { anchors: [{ page: 1.5, rects: [r(1, 1)] }] }),
      highlight(f, { anchors: [{ page: 1, rects: [] }] }),
      highlight(f, { anchors: [{ page: 1, rects: Array.from({ length: 1001 }, () => r(1, 1)) }] }),
      highlight(f, { anchors: [{ page: 1, rects: [r(Number.NaN, 1)] }] }),
      highlight(f, { anchors: [{ page: 1, rects: [r(Infinity, 1)] }] }),
      highlight(f, { anchors: [{ page: 1, rects: [r(1, 1, -1, 10)] }] }),
      highlight(f, { anchors: [{ page: 1, rects: [r(1_000_001, 1)] }] }),
      highlight(f, { anchors: [{ page: 1, rects: [r(1, -1_000_001)] }] }),
      highlight(f, { anchors: [{ page: 1, rects: [r(1, 1)], sortIndex: "1|2|3" }] }),
      highlight(f, { quote: "q".repeat(65_537) }),
      highlight(f, { body: "b".repeat(65_537) }),
      highlight(f, { colorName: "pink" as never }),
      highlight(f, { kind: "underline" as never }),
      highlight(f, { pageLabel: "x".repeat(65) }),
    ];
    for (const d of bad) await expect(repo.createAnnotation(f.pid, f.sid, d)).rejects.toBeInstanceOf(InvalidInputError);
    // The limits themselves are accepted.
    await repo.createAnnotation(f.pid, f.sid, highlight(f, { anchors: [{ page: 100_000, rects: [r(-1_000_000, 1_000_000, 0, 0)] }], quote: "q".repeat(65_536) }));
    expect(snap).not.toEqual(await snapshot(join(lib.root, f.projectFolder)));
    expect(await repo.listAnnotations(f.pid, f.sid)).toHaveLength(1);
  });

  it("an asset that is not a PDF is refused", async () => {
    const f = await fixture();
    expect(isPdfMime("application/pdf")).toBe(true);
    expect(isPdfMime("text/plain")).toBe(false);
    expect(isPdfMime("application/pdf+zip")).toBe(false);
    const snap = await snapshot(join(lib.root, f.projectFolder));
    await expect(repo.createAnnotation(f.pid, f.sid, highlight(f, { assetId: f.txtAssetId }))).rejects.toBeInstanceOf(InvalidInputError);
    // An asset of another source, and an unknown one, are not found.
    const other = await repo.createSource(f.pid, draft("Other"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    const snap2 = await snapshot(join(lib.root, f.projectFolder));
    await expect(repo.createAnnotation(f.pid, f.sid, highlight(f, { assetId: other.assets[0]!.id }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.createAnnotation(f.pid, f.sid, highlight(f, { assetId: newId() }))).rejects.toBeInstanceOf(NotFoundError);
    expect(await snapshot(join(lib.root, f.projectFolder))).toEqual(snap2);
    expect(Object.keys(snap2).length).toBeGreaterThan(Object.keys(snap).length);
    expect(await txnMarkers()).toEqual([]);
  });

  it("a destroyed PDF asset is refused", async () => {
    const f = await fixture();
    await importChange(repo, f.pid, STORE, async (ops) => {
      const cur = await ops.readSource(f.sid);
      await ops.writeSource(cur, { ...cur, assets: cur.assets.map((a) => (a.id === f.assetId ? { ...a, status: "destroyed" as const, destroyedAt: NOW } : a)) });
    }, { op: "test.destroy" });
    await expect(repo.createAnnotation(f.pid, f.sid, highlight(f))).rejects.toBeInstanceOf(NotFoundError);
    expect(await repo.listAnnotations(f.pid, f.sid)).toEqual([]);
  });
});

describe("caps (R74 I4): refused whole, nothing written", () => {
  it("the 10,001st annotation is refused and nothing is written", async () => {
    const f = await fixture();
    await seed(f.pid, f.sid, (sid) => Array.from({ length: MAX_SOURCE_ANNOTATIONS }, (_, i) => seedNote(sid, `n${i}`)));
    const snap = await snapshot(join(lib.root, f.projectFolder));
    const err = await repo.createAnnotation(f.pid, f.sid, highlight(f)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnnotationLimitError);
    expect((err as AnnotationLimitError).kind).toBe("count");
    expect((err as Error).message).toBe("This source already has 10,000 annotations, the most one source can hold. Delete some to add more.");
    expect(await snapshot(join(lib.root, f.projectFolder))).toEqual(snap);
    expect(await txnMarkers()).toEqual([]);
    // Deleting one makes room again.
    const first = (await repo.listAnnotations(f.pid, f.sid))[0]!;
    await repo.deleteAnnotation(f.pid, f.sid, first.id);
    await expect(repo.createAnnotation(f.pid, f.sid, highlight(f))).resolves.toMatchObject({ kind: "highlight" });
  });

  it("a note that would pass 16 MB of text is refused", async () => {
    const f = await fixture();
    const big = MAX_SOURCE_ANNOTATION_TEXT - 100;
    await seed(f.pid, f.sid, (sid) => [seedNote(sid, "x".repeat(big))]);
    const small = await repo.createAnnotation(f.pid, f.sid, highlight(f, { quote: "q".repeat(50) }));
    const snap = await snapshot(join(lib.root, f.projectFolder));
    // A create past the cap (exactly at it is allowed).
    const e1 = await repo.createAnnotation(f.pid, f.sid, highlight(f, { quote: "q".repeat(51) })).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(AnnotationLimitError);
    expect((e1 as AnnotationLimitError).kind).toBe("text");
    expect((e1 as Error).message).toBe("This source's annotations would pass 16 MB of text, the most one source can hold.");
    // A longer note on an existing annotation, past the cap: the old note's length is given back first.
    const e2 = await repo.updateAnnotation(f.pid, f.sid, small.id, { body: "b".repeat(51) }).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(AnnotationLimitError);
    expect((e2 as AnnotationLimitError).kind).toBe("text");
    expect(await snapshot(join(lib.root, f.projectFolder))).toEqual(snap);
    expect(await txnMarkers()).toEqual([]);
    // Exactly at the cap is fine; so is shortening a note.
    const atCap = await repo.updateAnnotation(f.pid, f.sid, small.id, { body: "b".repeat(50) });
    expect(atCap.body).toHaveLength(50);
    const shorter = await repo.updateAnnotation(f.pid, f.sid, small.id, { body: "b" });
    expect(shorter.body).toBe("b");
  });

  it("an update of a source already past the text cap may shorten but not lengthen", async () => {
    const f = await fixture();
    const big = seedNote(f.sid, "x".repeat(MAX_SOURCE_ANNOTATION_TEXT + 10));
    const n = seedNote(f.sid, "two words");
    await seed(f.pid, f.sid, () => [big, n]);
    await expect(repo.updateAnnotation(f.pid, f.sid, n.id, { body: "two words!" })).rejects.toBeInstanceOf(AnnotationLimitError);
    await expect(repo.updateAnnotation(f.pid, f.sid, n.id, { colorName: "red" })).resolves.toMatchObject({ colorName: "red" });
    await expect(repo.updateAnnotation(f.pid, f.sid, n.id, { body: "two" })).resolves.toMatchObject({ body: "two" });
    await expect(repo.updateAnnotation(f.pid, f.sid, n.id, { body: "six" })).resolves.toMatchObject({ body: "six" });
  });
});

describe("update and delete", () => {
  it("update recolours, sets and removes a note, stamps modifiedAt and audits field names only", async () => {
    const f = await fixture();
    const a = await repo.createAnnotation(f.pid, f.sid, highlight(f));
    const b = await repo.updateAnnotation(f.pid, f.sid, a.id, { colorName: "green", body: NOTE });
    expect(b).toMatchObject({ id: a.id, colorName: "green", body: NOTE, quote: QUOTE, modifiedAt: NOW, modifiedBy: "tester", createdAt: a.createdAt, author: a.author });
    expect(b.anchors).toEqual(a.anchors);
    const c = await repo.updateAnnotation(f.pid, f.sid, a.id, { body: null });
    expect(c.body).toBeUndefined();
    expect(c.colorName).toBe("green");
    expect(await repo.listAnnotations(f.pid, f.sid)).toEqual([c]);
    const evs = (await annotationEvents(f.projectFolder)).filter((e) => e.details?.op === ANNOTATION_UPDATE_OP);
    expect(evs).toHaveLength(2);
    const strip = (e: AuditEvent) => {
      const { txn: _t, changes: _c, ...rest } = e.details as Record<string, unknown>;
      return rest;
    };
    expect(evs.map((e) => e.action)).toEqual(["store", "store"]);
    expect(evs.every((e) => e.entity?.type === "source" && e.entity.id === f.sid)).toBe(true);
    expect(strip(evs[0]!)).toEqual({ op: ANNOTATION_UPDATE_OP, annotation: a.id, kind: "highlight", changed: ["body", "colorName"] });
    expect(strip(evs[1]!)).toEqual({ op: ANNOTATION_UPDATE_OP, annotation: a.id, kind: "highlight", changed: ["body"] });
    expect(await auditText(f.projectFolder)).not.toContain(NOTE);
  });

  it("refuses an empty patch, a bad colour, and removing a note's only text", async () => {
    const f = await fixture();
    const n = await repo.createAnnotation(f.pid, f.sid, { kind: "note", assetId: f.assetId, anchors: [{ page: 1, rects: [{ x: 1, y: 1, w: 0, h: 0 }] }], body: NOTE, colorName: "yellow" });
    await expect(repo.updateAnnotation(f.pid, f.sid, n.id, {})).rejects.toBeInstanceOf(InvalidInputError);
    await expect(repo.updateAnnotation(f.pid, f.sid, n.id, { colorName: "pink" as never })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(repo.updateAnnotation(f.pid, f.sid, n.id, { body: null })).rejects.toThrow(new InvalidInputError("Write the note first."));
    await expect(repo.updateAnnotation(f.pid, f.sid, n.id, { body: " " })).rejects.toThrow(new InvalidInputError("Write the note first."));
    await expect(repo.updateAnnotation(f.pid, f.sid, n.id, { body: "b".repeat(65_537) })).rejects.toBeInstanceOf(InvalidInputError);
    expect((await repo.listAnnotations(f.pid, f.sid))[0]!.body).toBe(NOTE);
  });

  it("an update that changes nothing writes nothing and returns the annotation as it is", async () => {
    const f = await fixture();
    const a = await repo.createAnnotation(f.pid, f.sid, highlight(f, { colorName: "red" }));
    const snap = await snapshot(join(lib.root, f.projectFolder));
    await expect(repo.updateAnnotation(f.pid, f.sid, a.id, { colorName: "red" })).resolves.toEqual(a);
    expect(await snapshot(join(lib.root, f.projectFolder))).toEqual(snap);
  });

  it("an imported #ffd400 highlight recoloured to yellow writes nothing and is not marked edited; recoloured to green it is", async () => {
    // Ruling M1 (round 1b): the colour it already shows (highlightColourOf) is no change.
    const f = await fixture();
    const imported = seedNote(f.sid, "", { kind: "highlight", body: undefined, quote: "zotero quote", color: "#ffd400", externalKey: "zotero:YELLOW01", externalHash: "h" });
    await seed(f.pid, f.sid, () => [imported]);
    const snap = await snapshot(join(lib.root, f.projectFolder));
    const n0 = (await annotationEvents(f.projectFolder)).length;
    const same = await repo.updateAnnotation(f.pid, f.sid, imported.id, { colorName: "yellow" });
    expect(same).toEqual(imported);
    expect(same.colorName).toBeUndefined();
    expect(same.modifiedAt).toBeUndefined();
    expect(await snapshot(join(lib.root, f.projectFolder))).toEqual(snap);
    expect(await annotationEvents(f.projectFolder)).toHaveLength(n0);
    expect(await txnMarkers()).toEqual([]);
    expect(await repo.listAnnotations(f.pid, f.sid)).toEqual([imported]);
    // A different named colour is the researcher's edit.
    const green = await repo.updateAnnotation(f.pid, f.sid, imported.id, { colorName: "green" });
    expect(green).toMatchObject({ colorName: "green", color: "#ffd400", modifiedAt: NOW, modifiedBy: "tester", externalKey: "zotero:YELLOW01", externalHash: "h" });
    const ev = (await annotationEvents(f.projectFolder)).slice(n0);
    expect(ev.map((e) => e.details?.changed)).toEqual([["colorName"]]);
    // And recolouring back to yellow, now that "green" is stored, is again a change.
    await expect(repo.updateAnnotation(f.pid, f.sid, imported.id, { colorName: "yellow" })).resolves.toMatchObject({ colorName: "yellow" });
  });

  it("a recolour to the shown colour together with a new note changes only the note", async () => {
    const f = await fixture();
    const imported = seedNote(f.sid, "", { kind: "highlight", body: undefined, quote: "q", color: "#ffd400", externalKey: "zotero:Y2" });
    await seed(f.pid, f.sid, () => [imported]);
    const n0 = (await annotationEvents(f.projectFolder)).length;
    const after = await repo.updateAnnotation(f.pid, f.sid, imported.id, { colorName: "yellow", body: "mine" });
    expect(after.body).toBe("mine");
    expect(after.colorName).toBeUndefined();
    expect((await annotationEvents(f.projectFolder)).slice(n0).map((e) => e.details?.changed)).toEqual([["body"]]);
  });

  it("extra fields in a draft or a patch are dropped: no provenance, import key, author or id can be set", async () => {
    const f = await fixture();
    const before = await repo.getSource(f.pid, f.sid);
    const hostile = {
      ...highlight(f),
      id: "chosen-id",
      externalKey: "zotero:FORGED",
      externalHash: "forged",
      author: "someone else",
      createdAt: "2000-01-01T00:00:00.000Z",
      color: "#000000",
      provenance: { identifiable: true },
      anchors: [{ page: 2, rects: [{ x: 1, y: 2, w: 3, h: 4, z: 9 }], kind: "text-range", assetId: f.txtAssetId, id: "anchor-id" }],
    } as unknown as AnnotationDraft;
    const a = await repo.createAnnotation(f.pid, f.sid, hostile);
    expect(a.id).not.toBe("chosen-id");
    expect(a).not.toHaveProperty("externalKey");
    expect(a).not.toHaveProperty("externalHash");
    expect(a).not.toHaveProperty("color");
    expect(a).not.toHaveProperty("provenance");
    expect(a).toMatchObject({ author: "tester", createdAt: NOW });
    expect(a.anchors).toEqual([{ kind: "pdf", id: expect.any(String), assetId: f.assetId, page: 2, rects: [{ x: 1, y: 2, w: 3, h: 4 }] }]);
    expect(a.anchors[0]!.id).not.toBe("anchor-id");
    const patched = await repo.updateAnnotation(f.pid, f.sid, a.id, {
      colorName: "red",
      externalKey: "zotero:FORGED",
      quote: "rewritten",
      kind: "note",
      author: "someone else",
      createdAt: "2000-01-01T00:00:00.000Z",
      anchors: [],
      sourceId: "other",
      provenance: { identifiable: true },
    } as unknown as AnnotationPatch);
    expect(patched).toEqual({ ...a, colorName: "red", modifiedAt: NOW, modifiedBy: "tester" });
    const sf = await repo.getSource(f.pid, f.sid);
    expect(sf.source).toEqual(before.source);
    expect(sf.deletedAnnotationKeys).toBeUndefined();
    // Extra fields on a delete call have nothing to reach either: an annotation made here leaves no key.
    await expect(repo.deleteAnnotation(f.pid, f.sid, a.id)).resolves.toEqual({ id: a.id, external: false });
    expect((await repo.getSource(f.pid, f.sid)).deletedAnnotationKeys).toBeUndefined();
  });

  it("a failed audit append leaves nothing on disk and no marker, for create, update and delete", async () => {
    const f = await fixture();
    const a = await repo.createAnnotation(f.pid, f.sid, highlight(f));
    const imported = seedNote(f.sid, "n", { kind: "highlight", externalKey: "zotero:KEEP" });
    await importChange(repo, f.pid, STORE, async (ops) => {
      const cur = await ops.readSource(f.sid);
      await ops.writeSource(cur, { ...cur, annotations: [...cur.annotations, imported] });
    }, { op: "test.seed" });
    const snap = await snapshot(join(lib.root, f.projectFolder));
    seams.failAuditAppendFor = f.pid;
    try {
      await expect(repo.createAnnotation(f.pid, f.sid, highlight(f, { body: NOTE }))).rejects.toThrow();
      await expect(repo.updateAnnotation(f.pid, f.sid, a.id, { body: NOTE })).rejects.toThrow();
      await expect(repo.deleteAnnotation(f.pid, f.sid, imported.id)).rejects.toThrow();
    } finally {
      seams.failAuditAppendFor = undefined;
    }
    expect(await snapshot(join(lib.root, f.projectFolder))).toEqual(snap);
    expect(await txnMarkers()).toEqual([]);
    expect(await repo.listAnnotations(f.pid, f.sid)).toEqual([a, imported]);
    expect((await repo.getSource(f.pid, f.sid)).deletedAnnotationKeys).toBeUndefined();
    // The project still takes changes afterwards.
    await expect(repo.updateAnnotation(f.pid, f.sid, a.id, { body: NOTE })).resolves.toMatchObject({ body: NOTE });
  });

  it("an unknown annotation is not found", async () => {
    const f = await fixture();
    await expect(repo.updateAnnotation(f.pid, f.sid, newId(), { colorName: "red" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.deleteAnnotation(f.pid, f.sid, newId())).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.listAnnotations(f.pid, newId())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("two updates at once both land, the second on the first", async () => {
    const f = await fixture();
    const a = await repo.createAnnotation(f.pid, f.sid, highlight(f));
    const [x, y] = await Promise.all([
      repo.updateAnnotation(f.pid, f.sid, a.id, { colorName: "purple" }),
      repo.updateAnnotation(f.pid, f.sid, a.id, { body: NOTE }),
    ]);
    // Which of the two enters the write queue first is not guaranteed: each first reads the source
    // outside the queue, for its policy request. What is guaranteed is that both land, the later on
    // the earlier, whichever that is. Each order is pinned down under "changes at the same time".
    expect(x.colorName).toBe("purple");
    expect(y.body).toBe(NOTE);
    const [stored] = await repo.listAnnotations(f.pid, f.sid);
    expect(stored).toMatchObject({ colorName: "purple", body: NOTE });
    expect([x, y]).toContainEqual(stored);
  });

  it("deleting an imported highlight records its key", async () => {
    const f = await fixture();
    const imported = seedNote(f.sid, "imported note", { kind: "highlight", quote: "zotero quote", externalKey: "zotero:ABCD2345", externalHash: "h" });
    const old = Array.from({ length: MAX_SOURCE_ANNOTATIONS }, (_, i) => `zotero:OLD${i}`);
    await importChange(repo, f.pid, STORE, async (ops) => {
      const cur = await ops.readSource(f.sid);
      await ops.writeSource(cur, { ...cur, annotations: [imported], deletedAnnotationKeys: old });
    }, { op: "test.seed" });
    const mine = await repo.createAnnotation(f.pid, f.sid, highlight(f));
    // An imported annotation may be recoloured here.
    await expect(repo.updateAnnotation(f.pid, f.sid, imported.id, { colorName: "orange" })).resolves.toMatchObject({ colorName: "orange", externalKey: "zotero:ABCD2345" });
    await expect(repo.deleteAnnotation(f.pid, f.sid, imported.id)).resolves.toEqual({ id: imported.id, external: true });
    const sf = await repo.getSource(f.pid, f.sid);
    expect(sf.annotations.map((a) => a.id)).toEqual([mine.id]);
    // Appended; the oldest dropped past 10,000.
    expect(sf.deletedAnnotationKeys).toHaveLength(MAX_SOURCE_ANNOTATIONS);
    expect(sf.deletedAnnotationKeys![MAX_SOURCE_ANNOTATIONS - 1]).toBe("zotero:ABCD2345");
    expect(sf.deletedAnnotationKeys![0]).toBe("zotero:OLD1");
    // One made here leaves no key.
    await expect(repo.deleteAnnotation(f.pid, f.sid, mine.id)).resolves.toEqual({ id: mine.id, external: false });
    const after = await repo.getSource(f.pid, f.sid);
    expect(after.annotations).toEqual([]);
    expect(after.deletedAnnotationKeys).toEqual(sf.deletedAnnotationKeys);
    const evs = (await annotationEvents(f.projectFolder)).filter((e) => e.details?.op === ANNOTATION_DELETE_OP);
    expect(evs.map((e) => e.action)).toEqual(["delete", "delete"]);
    const strip = (e: AuditEvent) => {
      const { txn: _t, changes: _c, ...rest } = e.details as Record<string, unknown>;
      return rest;
    };
    expect(evs.map(strip)).toEqual([
      { op: ANNOTATION_DELETE_OP, annotation: imported.id, kind: "highlight", external: true },
      { op: ANNOTATION_DELETE_OP, annotation: mine.id, kind: "highlight", external: false },
    ]);
    const raw = await auditText(f.projectFolder);
    expect(raw).not.toContain("zotero quote");
    expect(raw).not.toContain("ABCD2345");
  });

  it("deleting an imported key already recorded does not record it twice", async () => {
    const f = await fixture();
    const imported = seedNote(f.sid, "n", { kind: "highlight", externalKey: "zotero:SAME" });
    await importChange(repo, f.pid, STORE, async (ops) => {
      const cur = await ops.readSource(f.sid);
      await ops.writeSource(cur, { ...cur, annotations: [imported], deletedAnnotationKeys: ["zotero:SAME", "zotero:X"] });
    }, { op: "test.seed" });
    await repo.deleteAnnotation(f.pid, f.sid, imported.id);
    expect((await repo.getSource(f.pid, f.sid)).deletedAnnotationKeys).toEqual(["zotero:X", "zotero:SAME"]);
  });
});

describe("changes at the same time (R3a): every decision is taken on the state the change writes over", () => {
  type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
  const settle = <T,>(p: Promise<T>): Promise<Settled<T>> => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

  /**
   * `held` is started and stopped right after its pre-read, before it enters the write queue; `other`
   * then runs to completion; then `held` goes on. So `held` read the source BEFORE `other` changed it,
   * and is applied AFTER: the order that makes a stale pre-read matter.
   */
  async function race<A, B>(held: () => Promise<A>, other: () => Promise<B>): Promise<{ held: Settled<A>; other: Settled<B> }> {
    let reached!: () => void;
    let release!: () => void;
    const atHold = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    preRead.hold = async () => {
      reached();
      await gate;
    };
    const first = settle(held());
    await atHold;
    const second = await settle(other());
    release();
    return { held: await first, other: second };
  }
  const value = <T,>(s: Settled<T>): T => {
    if (!s.ok) throw s.error;
    return s.value;
  };
  /** The annotation audit entries after the first `from`, without the transaction id and change count. */
  const entriesFrom = async (projectFolder: string, from: number): Promise<Array<Record<string, unknown>>> =>
    (await annotationEvents(projectFolder)).slice(from).map((e) => {
      const { txn: _t, changes: _c, ...rest } = e.details as Record<string, unknown>;
      return { action: e.action, result: e.decision?.result, ...rest };
    });

  for (const [heldName, heldPatch, otherName, otherPatch] of [
    ["a recolour", { colorName: "purple" }, "a note", { body: NOTE }],
    ["a note", { body: NOTE }, "a recolour", { colorName: "purple" }],
  ] as const) {
    it(`${heldName} read before ${otherName} and applied after it: both land, and each audit entry names only its own field`, async () => {
      const f = await fixture();
      const a = await repo.createAnnotation(f.pid, f.sid, highlight(f));
      const n0 = (await annotationEvents(f.projectFolder)).length;
      const r = await race(
        () => repo.updateAnnotation(f.pid, f.sid, a.id, heldPatch),
        () => repo.updateAnnotation(f.pid, f.sid, a.id, otherPatch),
      );
      const other = value(r.other);
      const held = value(r.held);
      // The other change was applied to the annotation as created; the held one on top of it.
      expect(other).toEqual({ ...a, ...otherPatch, modifiedAt: NOW, modifiedBy: "tester" });
      expect(held).toEqual({ ...a, colorName: "purple", body: NOTE, modifiedAt: NOW, modifiedBy: "tester" });
      expect(await repo.listAnnotations(f.pid, f.sid)).toEqual([held]);
      const field = (p: AnnotationPatch) => (p.body !== undefined ? "body" : "colorName");
      expect(await entriesFrom(f.projectFolder, n0)).toEqual([
        { action: "store", result: "allow", op: ANNOTATION_UPDATE_OP, annotation: a.id, kind: "highlight", changed: [field(otherPatch)] },
        { action: "store", result: "allow", op: ANNOTATION_UPDATE_OP, annotation: a.id, kind: "highlight", changed: [field(heldPatch)] },
      ]);
      expect(await txnMarkers()).toEqual([]);
    });
  }

  it("two notes on one annotation: the one applied later wins whole, and each is audited as a change of the note", async () => {
    const f = await fixture();
    const a = await repo.createAnnotation(f.pid, f.sid, highlight(f, { body: "first" }));
    const n0 = (await annotationEvents(f.projectFolder)).length;
    const r = await race(
      () => repo.updateAnnotation(f.pid, f.sid, a.id, { body: "held note, applied last" }),
      () => repo.updateAnnotation(f.pid, f.sid, a.id, { body: "other note" }),
    );
    expect(value(r.other).body).toBe("other note");
    expect(value(r.held).body).toBe("held note, applied last");
    expect(await repo.listAnnotations(f.pid, f.sid)).toEqual([value(r.held)]);
    expect((await entriesFrom(f.projectFolder, n0)).map((e) => e.changed)).toEqual([["body"], ["body"]]);
  });

  it("two identical recolours: the later finds nothing to change, writes nothing and is not audited", async () => {
    const f = await fixture();
    const a = await repo.createAnnotation(f.pid, f.sid, highlight(f));
    const n0 = (await annotationEvents(f.projectFolder)).length;
    let snap: Record<string, string> | undefined;
    const r = await race(
      () => repo.updateAnnotation(f.pid, f.sid, a.id, { colorName: "red" }),
      async () => {
        const done = await repo.updateAnnotation(f.pid, f.sid, a.id, { colorName: "red" });
        snap = await snapshot(join(lib.root, f.projectFolder));
        return done;
      },
    );
    expect(value(r.held)).toEqual(value(r.other));
    expect(await snapshot(join(lib.root, f.projectFolder))).toEqual(snap);
    expect((await entriesFrom(f.projectFolder, n0)).map((e) => e.changed)).toEqual([["colorName"]]);
  });

  it("an update read before a delete and applied after it is a plain \"not found\": nothing written, no update audited", async () => {
    const f = await fixture();
    const a = await repo.createAnnotation(f.pid, f.sid, highlight(f));
    const n0 = (await annotationEvents(f.projectFolder)).length;
    let snap: Record<string, string> | undefined;
    const r = await race(
      () => repo.updateAnnotation(f.pid, f.sid, a.id, { body: NOTE }),
      async () => {
        const done = await repo.deleteAnnotation(f.pid, f.sid, a.id);
        snap = await snapshot(join(lib.root, f.projectFolder));
        return done;
      },
    );
    expect(value(r.other)).toEqual({ id: a.id, external: false });
    expect(r.held.ok).toBe(false);
    expect((r.held as { error: unknown }).error).toBeInstanceOf(NotFoundError);
    expect(await snapshot(join(lib.root, f.projectFolder))).toEqual(snap);
    expect(await repo.listAnnotations(f.pid, f.sid)).toEqual([]);
    expect(await entriesFrom(f.projectFolder, n0)).toEqual([
      { action: "delete", result: "allow", op: ANNOTATION_DELETE_OP, annotation: a.id, kind: "highlight", external: false },
    ]);
    expect(await txnMarkers()).toEqual([]);
  });

  it("a recolour and a delete of an imported highlight called together: the delete enters first, the recolour is a plain \"not found\", the key recorded once", async () => {
    const f = await fixture();
    const imported = seedNote(f.sid, "", { kind: "highlight", body: undefined, quote: "q", color: "#ffd400", externalKey: "zotero:RACE1" });
    await seed(f.pid, f.sid, () => [imported]);
    const n0 = (await annotationEvents(f.projectFolder)).length;
    // A delete has no pre-read: it enters the queue when it is called, so these two run in call order.
    const [up, del] = await Promise.all([settle(repo.updateAnnotation(f.pid, f.sid, imported.id, { colorName: "green" })), settle(repo.deleteAnnotation(f.pid, f.sid, imported.id))]);
    // The recolour's pre-read is still on its way when the delete enters the queue: the delete goes first.
    expect(value(del)).toEqual({ id: imported.id, external: true });
    expect(up.ok).toBe(false);
    expect((up as { error: unknown }).error).toBeInstanceOf(NotFoundError);
    const sf = await repo.getSource(f.pid, f.sid);
    expect(sf.annotations).toEqual([]);
    expect(sf.deletedAnnotationKeys).toEqual(["zotero:RACE1"]);
    expect((await entriesFrom(f.projectFolder, n0)).map((e) => e.op)).toEqual([ANNOTATION_DELETE_OP]);
  });

  it("two deletes at once: one deletes, the other is a plain \"not found\", one audit entry, the key recorded once", async () => {
    const f = await fixture();
    const imported = seedNote(f.sid, "n", { kind: "highlight", externalKey: "zotero:TWICE" });
    await seed(f.pid, f.sid, () => [imported]);
    const n0 = (await annotationEvents(f.projectFolder)).length;
    const results = await Promise.all([settle(repo.deleteAnnotation(f.pid, f.sid, imported.id)), settle(repo.deleteAnnotation(f.pid, f.sid, imported.id))]);
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    const failed = results.filter((x) => !x.ok);
    expect(failed).toHaveLength(1);
    expect((failed[0] as { error: unknown }).error).toBeInstanceOf(NotFoundError);
    const sf = await repo.getSource(f.pid, f.sid);
    expect(sf.annotations).toEqual([]);
    expect(sf.deletedAnnotationKeys).toEqual(["zotero:TWICE"]);
    expect(await entriesFrom(f.projectFolder, n0)).toEqual([
      { action: "delete", result: "allow", op: ANNOTATION_DELETE_OP, annotation: imported.id, kind: "highlight", external: true },
    ]);
    expect(await txnMarkers()).toEqual([]);
  });

  it("two creates at the count cap: the one applied later is refused whole, on the state it would have written over", async () => {
    const f = await fixture();
    await seed(f.pid, f.sid, (sid) => Array.from({ length: MAX_SOURCE_ANNOTATIONS - 1 }, (_, i) => seedNote(sid, `n${i}`)));
    const n0 = (await annotationEvents(f.projectFolder)).length;
    let snap: Record<string, string> | undefined;
    const r = await race(
      () => repo.createAnnotation(f.pid, f.sid, highlight(f, { quote: "held" })),
      async () => {
        const done = await repo.createAnnotation(f.pid, f.sid, highlight(f, { quote: "other" }));
        snap = await snapshot(join(lib.root, f.projectFolder));
        return done;
      },
    );
    expect(value(r.other).quote).toBe("other");
    expect(r.held.ok).toBe(false);
    expect((r.held as { error: unknown }).error).toBeInstanceOf(AnnotationLimitError);
    expect(((r.held as { error: unknown }).error as AnnotationLimitError).kind).toBe("count");
    expect(await snapshot(join(lib.root, f.projectFolder))).toEqual(snap);
    expect(await repo.listAnnotations(f.pid, f.sid)).toHaveLength(MAX_SOURCE_ANNOTATIONS);
    expect((await entriesFrom(f.projectFolder, n0)).map((e) => e.op)).toEqual([ANNOTATION_CREATE_OP]);
    expect(await txnMarkers()).toEqual([]);
  });

  it("two longer notes that fit the text cap alone but not together: the one applied later is refused whole", async () => {
    const f = await fixture();
    const big = seedNote(f.sid, "x".repeat(MAX_SOURCE_ANNOTATION_TEXT - 100));
    const p = seedNote(f.sid, "p");
    const q = seedNote(f.sid, "q");
    await seed(f.pid, f.sid, () => [big, p, q]);
    let snap: Record<string, string> | undefined;
    // 98 characters of room: each adds 59.
    const r = await race(
      () => repo.updateAnnotation(f.pid, f.sid, q.id, { body: "q".repeat(60) }),
      async () => {
        const done = await repo.updateAnnotation(f.pid, f.sid, p.id, { body: "p".repeat(60) });
        snap = await snapshot(join(lib.root, f.projectFolder));
        return done;
      },
    );
    expect(value(r.other).body).toBe("p".repeat(60));
    expect(r.held.ok).toBe(false);
    expect(((r.held as { error: unknown }).error as AnnotationLimitError).kind).toBe("text");
    expect(await snapshot(join(lib.root, f.projectFolder))).toEqual(snap);
    expect((await repo.listAnnotations(f.pid, f.sid)).find((a) => a.id === q.id)!.body).toBe("q");
  });

  it("a page note's text removed while another change is on its way is still refused, and the other lands", async () => {
    const f = await fixture();
    const n = await repo.createAnnotation(f.pid, f.sid, { kind: "note", assetId: f.assetId, anchors: [{ page: 1, rects: [{ x: 1, y: 1, w: 0, h: 0 }] }], body: NOTE, colorName: "yellow" });
    const r = await race(
      () => repo.updateAnnotation(f.pid, f.sid, n.id, { body: null }),
      () => repo.updateAnnotation(f.pid, f.sid, n.id, { colorName: "blue" }),
    );
    expect(r.held.ok).toBe(false);
    expect((r.held as { error: unknown }).error).toEqual(new InvalidInputError("Write the note first."));
    expect(await repo.listAnnotations(f.pid, f.sid)).toEqual([value(r.other)]);
    expect(value(r.other)).toMatchObject({ body: NOTE, colorName: "blue" });
  });

  it("an update read before its source was deleted is a plain \"not found\" and writes nothing", async () => {
    const f = await fixture();
    const a = await repo.createAnnotation(f.pid, f.sid, highlight(f));
    const n0 = (await annotationEvents(f.projectFolder)).length;
    let snap: Record<string, string> | undefined;
    const r = await race(
      () => repo.updateAnnotation(f.pid, f.sid, a.id, { body: NOTE }),
      async () => {
        await repo.deleteSource(f.pid, f.sid);
        snap = await snapshot(join(lib.root, f.projectFolder));
      },
    );
    expect(r.other.ok).toBe(true);
    expect(r.held.ok).toBe(false);
    expect((r.held as { error: unknown }).error).toBeInstanceOf(NotFoundError);
    expect(await snapshot(join(lib.root, f.projectFolder))).toEqual(snap);
    expect(await entriesFrom(f.projectFolder, n0)).toEqual([]);
    expect(await txnMarkers()).toEqual([]);
  });
});

describe("crash safety (R26)", () => {
  const points: CrashPoint[] = ["before-changes", "before-audit", "torn-audit", "before-marker-delete"];
  /** Reopens the library as after a crash (recovery runs on open). */
  async function reopen(): Promise<void> {
    handle.close();
    await lib.close();
    lib = await openLibrary(lib.root, mkDeps());
    handle = new IndexHandle(lib.root);
    repo = await repoFor();
  }
  /** The annotations on disk match the allow entries in the audit: never one without the other. */
  async function consistent(f: Fixture): Promise<string[]> {
    const ids = (await repo.listAnnotations(f.pid, f.sid)).map((a) => a.id);
    const audited = (await annotationEvents(f.projectFolder)).filter((e) => e.decision?.result !== "deny");
    const created = audited.filter((e) => e.details?.op === ANNOTATION_CREATE_OP).map((e) => e.details?.annotation as string);
    const deleted = audited.filter((e) => e.details?.op === ANNOTATION_DELETE_OP).map((e) => e.details?.annotation as string);
    expect(ids.sort()).toEqual(created.filter((x) => !deleted.includes(x)).sort());
    const stored = JSON.parse(await readFile(join(lib.root, f.folder, "source.json"), "utf8")) as SourceFile;
    expect(stored.annotationCount ?? 0).toBe(ids.length);
    if (ids.length) {
      const raw = await readFile(join(lib.root, f.folder, "annotations.json"), "utf8");
      expect(createHash("sha256").update(raw).digest("hex")).toBe(stored.annotationsSha256);
    }
    expect(repo.integrityWarnings.filter((w) => w.kind.startsWith("annotations-"))).toEqual([]);
    return ids;
  }

  for (const point of points) {
    it(`a create, an update and a delete cut off at ${point} are all-or-nothing`, async () => {
      const f = await fixture();
      const keep = await repo.createAnnotation(f.pid, f.sid, highlight(f));
      const committed = point === "before-marker-delete";

      seams.crashAt = point;
      await expect(repo.createAnnotation(f.pid, f.sid, highlight(f, { quote: "second" }))).rejects.toBeInstanceOf(SimulatedCrash);
      await reopen();
      expect(await consistent(f)).toHaveLength(committed ? 2 : 1);

      seams.crashAt = point;
      await expect(repo.updateAnnotation(f.pid, f.sid, keep.id, { body: NOTE })).rejects.toBeInstanceOf(SimulatedCrash);
      await reopen();
      await consistent(f);
      const kept = (await repo.listAnnotations(f.pid, f.sid)).find((a) => a.id === keep.id)!;
      expect(kept.body).toBe(committed ? NOTE : undefined);
      expect((await annotationEvents(f.projectFolder)).filter((e) => e.details?.op === ANNOTATION_UPDATE_OP)).toHaveLength(committed ? 1 : 0);

      seams.crashAt = point;
      await expect(repo.deleteAnnotation(f.pid, f.sid, keep.id)).rejects.toBeInstanceOf(SimulatedCrash);
      await reopen();
      const ids = await consistent(f);
      expect(ids.includes(keep.id)).toBe(!committed);
      expect(await txnMarkers()).toEqual([]);
    });
  }

  it("a crash after the annotations file and before the audit rolls the whole change back", async () => {
    const f = await fixture();
    const keep = await repo.createAnnotation(f.pid, f.sid, highlight(f));
    const crash = async () => {
      throw new SimulatedCrash("simulated crash between the annotations file and source.json");
    };
    for (const change of [
      () => repo.createAnnotation(f.pid, f.sid, highlight(f, { quote: "second" })),
      () => repo.updateAnnotation(f.pid, f.sid, keep.id, { colorName: "red" }),
      () => repo.deleteAnnotation(f.pid, f.sid, keep.id),
    ]) {
      pauseBetweenSourceFilesForTests(crash);
      await expect(change()).rejects.toBeInstanceOf(SimulatedCrash);
      pauseBetweenSourceFilesForTests(undefined);
      expect(await txnMarkers()).not.toEqual([]);
      await reopen();
      expect(await repo.listAnnotations(f.pid, f.sid)).toEqual([keep]);
      await consistent(f);
      expect(repo.integrityWarnings.map((w) => w.kind)).toEqual(["rolled-back-incomplete-write"]);
    }
  });
});

describe("governance, locks and read-only", () => {
  it("an encrypted project's audit line holds no quote or note", async () => {
    const f = await fixture({ encrypted: true });
    const a = await repo.createAnnotation(f.pid, f.sid, highlight(f, { body: NOTE }));
    await repo.updateAnnotation(f.pid, f.sid, a.id, { body: `${NOTE} again`, colorName: "magenta" });
    expect(await repo.listAnnotations(f.pid, f.sid)).toEqual([expect.objectContaining({ quote: QUOTE, body: `${NOTE} again`, colorName: "magenta" })]);
    await repo.deleteAnnotation(f.pid, f.sid, a.id);
    const evs = await annotationEvents(f.projectFolder);
    expect(evs.map((e) => e.details?.op)).toEqual([ANNOTATION_CREATE_OP, ANNOTATION_UPDATE_OP, ANNOTATION_DELETE_OP]);
    const raw = await auditText(f.projectFolder);
    expect(raw).not.toContain(QUOTE);
    expect(raw).not.toContain(NOTE);
    // Nothing in the project folder holds the text in the clear (the annotations file is sealed).
    const dir = join(lib.root, f.projectFolder);
    for (const rel of Object.keys(await snapshot(dir))) {
      const bytes = (await readFile(join(dir, rel))).toString("latin1");
      expect(bytes.includes(QUOTE) || bytes.includes(NOTE), rel).toBe(false);
    }
  });

  it("an encrypted project stores the annotations sealed", async () => {
    const f = await fixture({ encrypted: true });
    await repo.createAnnotation(f.pid, f.sid, highlight(f));
    const names = await readdir(join(lib.root, f.folder));
    expect(names).toContain("annotations.json.enc");
    expect(names).not.toContain("annotations.json");
  });

  it("a locked project is refused before reading", async () => {
    const f = await fixture({ encrypted: true });
    const a = await repo.createAnnotation(f.pid, f.sid, highlight(f));
    repo.lockProject(f.pid);
    const snap = await snapshot(join(lib.root, f.projectFolder));
    // An unknown source id still answers "locked": nothing was read to find out.
    for (const sid of [f.sid, newId()]) {
      await expect(repo.listAnnotations(f.pid, sid)).rejects.toBeInstanceOf(ProjectLockedError);
      await expect(repo.createAnnotation(f.pid, sid, highlight(f))).rejects.toBeInstanceOf(ProjectLockedError);
      await expect(repo.updateAnnotation(f.pid, sid, a.id, { colorName: "red" })).rejects.toBeInstanceOf(ProjectLockedError);
      await expect(repo.deleteAnnotation(f.pid, sid, a.id)).rejects.toBeInstanceOf(ProjectLockedError);
    }
    expect(await snapshot(join(lib.root, f.projectFolder))).toEqual(snap);
  });

  it("a read-only library is refused", async () => {
    const f = await fixture();
    const a = await repo.createAnnotation(f.pid, f.sid, highlight(f));
    const ro = await repoFor({ ...lib, mode: "read-only", readOnlyReason: "locked-by-other-device" });
    const snap = await snapshot(lib.root);
    await expect(ro.createAnnotation(f.pid, f.sid, highlight(f))).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    await expect(ro.updateAnnotation(f.pid, f.sid, a.id, { colorName: "red" })).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    await expect(ro.deleteAnnotation(f.pid, f.sid, a.id)).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    // Even a malformed draft answers read-only first.
    await expect(ro.createAnnotation(f.pid, f.sid, highlight(f, { anchors: [] }))).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    // Reading is allowed.
    expect(await ro.listAnnotations(f.pid, f.sid)).toEqual([a]);
    expect(await snapshot(lib.root)).toEqual(snap);
  });

  it("a policy refusal is audited and nothing changes", async () => {
    const f = await fixture();
    const a = await repo.createAnnotation(f.pid, f.sid, highlight(f));
    // Governance that cannot be read denies everything (fail closed).
    await writeFile(join(lib.root, f.projectFolder, "governance.yaml"), "identifiability: [unclosed\n");
    const before = await snapshot(join(lib.root, f.folder));
    const n0 = (await annotationEvents(f.projectFolder)).length;
    await expect(repo.createAnnotation(f.pid, f.sid, highlight(f, { body: NOTE }))).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(repo.updateAnnotation(f.pid, f.sid, a.id, { body: NOTE })).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(repo.deleteAnnotation(f.pid, f.sid, a.id)).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(await snapshot(join(lib.root, f.folder))).toEqual(before);
    expect(await repo.listAnnotations(f.pid, f.sid)).toEqual([a]);
    const denies = (await annotationEvents(f.projectFolder)).slice(n0);
    expect(denies.map((e) => [e.action, e.details?.op, e.decision?.result, e.entity])).toEqual([
      ["store", ANNOTATION_CREATE_OP, "deny", { type: "source", id: f.sid }],
      ["store", ANNOTATION_UPDATE_OP, "deny", { type: "source", id: f.sid }],
      ["delete", ANNOTATION_DELETE_OP, "deny", { type: "source", id: f.sid }],
    ]);
    expect(await auditText(f.projectFolder)).not.toContain(NOTE);
  });

  it("the store request carries the source's provenance", async () => {
    // A project that requires a legal basis for identifiable data refuses storing an annotation on
    // an identifiable source without one, as it would refuse storing the source itself.
    const gov = OPEN_GOV.replace("containsIdentifiable: false", "containsIdentifiable: true\n  pseudonymizeFileNames: false");
    const project = (await repo.createProject({ name: "Strict", governanceYaml: gov, encryption: { enabled: false } })).project;
    const sf = await repo.createSource(project.id, draft("Identifiable"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: { ...provenance(), identifiable: true } });
    await writeFile(join(lib.root, project.folder, "governance.yaml"), gov.replace("requireLegalBasis: false", "requireLegalBasis: true"));
    const err = await repo.createAnnotation(project.id, sf.source.id, { kind: "highlight", assetId: sf.assets[0]!.id, anchors: [{ page: 1, rects: [{ x: 1, y: 1, w: 1, h: 1 }] }], colorName: "yellow" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect((err as PolicyDeniedError).reason).toMatch(/legal basis/);
  });
});

describe("search index", () => {
  it("the search index finds a new note's word", async () => {
    const f = await fixture();
    expect(search(handle.db, { text: "zanzibarite" }).total).toBe(0);
    const a = await repo.createAnnotation(f.pid, f.sid, highlight(f, { body: "a zanzibarite deposit" }));
    expect(search(handle.db, { text: "zanzibarite" }).items).toEqual([expect.objectContaining({ id: f.sid, matchedIn: "annotation" })]);
    await repo.updateAnnotation(f.pid, f.sid, a.id, { body: "a quillwort meadow" });
    expect(search(handle.db, { text: "zanzibarite" }).total).toBe(0);
    expect(search(handle.db, { text: "quillwort" }).total).toBe(1);
    await repo.deleteAnnotation(f.pid, f.sid, a.id);
    expect(search(handle.db, { text: "quillwort" }).total).toBe(0);
    expect(repo.indexErrors).toEqual([]);
  });
});
