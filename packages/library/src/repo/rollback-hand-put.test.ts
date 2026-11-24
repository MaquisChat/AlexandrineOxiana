/**
 * R519 (FR-735, R503 c as corrected): a roll-back never deletes, never overwrites and never moves a file it can tell is
 * not its own. Where a file put or changed by hand stands where the undo would have to delete or replace it, the undo
 * leaves it exactly where it is, does not undo the earlier steps at or above that path either, and is incomplete with a
 * cause and the library-relative path; once the researcher moves the file away, the roll-back completes.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Annotation, type Provenance, type SourceDraft, type SourceFile } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import type { Repo } from "./index.js";
import type { Tx } from "./mutate.js";
import { importChange } from "./repo.js";
import { PendingWriteIncompleteError } from "./errors.js";
import { SimulatedCrash, openTestRepo, seams } from "./testing.js";
import { fromRel, undoEntries, type MarkerEntry, type TxnMarker, type UndoCause } from "./txn.js";

const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const NOW = "2026-11-11T10:00:00.000Z";
const PDF = "%PDF-1.7\nhello\n%%EOF\n";
const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };
const HAND = "a file put here by hand\n";
const ORIGINAL = "the researcher's original\n";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let pid: string;
let sid: string;
let folder: string;

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
const repoFor = (): Promise<Repo> => openTestRepo(lib, ring, { clock: () => new Date(NOW), tz: "UTC", actor: "tester", scryptN: 2 ** 10 });
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
const note = (sourceId: string, body: string): Annotation => ({ id: newId(), sourceId, kind: "note", anchors: [], body, author: "tester", createdAt: NOW });
const withNotes = (sf: SourceFile, bodies: string[]): SourceFile => ({ ...sf, annotations: bodies.map((b) => note(sf.source.id, b)) });

const markers = async () => (await readdir(join(lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => /^txn-.*\.json$/u.test(n));
const readMarker = async (): Promise<TxnMarker> => JSON.parse(await readFile(join(lib.root, ".tmp", (await markers())[0]!), "utf8")) as TxnMarker;
const text = (rel: string) => readFile(fromRel(lib.root, rel), "utf8").catch(() => null);
const reopen = async () => {
  await lib.close();
  lib = await openLibrary(lib.root, mkDeps());
  repo = await repoFor();
};
/** The causes the reopen's roll-back gave for this project's incomplete change (on its warning). */
const causes = (): UndoCause[] => repo.integrityWarnings.filter((x) => x.projectId === pid && x.kind === "rolled-back-incomplete-write").flatMap((x) => x.causes ?? []);
const kinds = () => repo.integrityWarnings.filter((x) => x.projectId === pid).map((x) => x.kind);

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-r519h-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  await writeFile(join(tmp, "in.pdf"), PDF);
  await writeFile(join(tmp, "src.txt"), ORIGINAL);
  await writeFile(join(tmp, "other.txt"), "the change's own copied file\n");
  repo = await repoFor();
  pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  const sf = await repo.createSource(pid, draft("Annotated"), [{ path: join(tmp, "in.pdf"), role: "original", handling: "copy" }], { provenance: provenance() });
  sid = sf.source.id;
  folder = sf.source.folder;
  await importChange(repo, pid, STORE, async (ops) => {
    const cur = await ops.readSource(sid);
    await ops.writeSource(cur, withNotes(cur, ["first", "second"]));
  }, { op: "test.annotations" });
});
afterEach(async () => {
  seams.failUndo = undefined;
  seams.crashAt = undefined;
  seams.stopUndoAfter = undefined;
  seams.failLook = undefined;
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

/** A change cut off by a crash before its audit entry (no undo has run): its marker is left. */
async function crashed(fn: (tx: Tx) => Promise<void>): Promise<TxnMarker> {
  seams.crashAt = "before-audit";
  await expect(repo.mutate(pid, STORE, fn)).rejects.toBeInstanceOf(SimulatedCrash);
  expect(await markers()).toHaveLength(1);
  return readMarker();
}

/** At this reopen and the next: the hand-put file unchanged at its path, the marker kept, incomplete with exactly `want`, no outside-change claim. */
async function keptAndIncomplete(rel: string, want: UndoCause[], txn: string): Promise<void> {
  for (const run of ["first", "second"]) {
    await reopen();
    expect(await text(rel), `${run} reopen`).toBe(HAND);
    expect(await markers(), `${run} reopen`).toEqual([`txn-${txn}.json`]);
    expect(kinds(), `${run} reopen`).toContain("rolled-back-incomplete-write");
    expect(kinds(), `${run} reopen`).not.toContain("changed-outside-before-rollback");
    expect(causes(), `${run} reopen`).toEqual(want);
    expect((await repo.pendingWrites()).map((x) => x.txn), `${run} reopen`).toEqual([txn]);
  }
}

describe("R519: the undo of a created file removes only the change's own bytes", () => {
  it("a copied file (completion line), changed by hand: kept, unchanged, incomplete (hand-changed-file); moved away, the roll-back completes", async () => {
    const rel = `${folder}/copied.txt`;
    const m = await crashed(async (tx) => {
      await tx.copyFile(join(tmp, "src.txt"), rel);
    });
    await writeFile(fromRel(lib.root, rel), HAND);
    await keptAndIncomplete(rel, [{ kind: "hand-changed-file", path: rel }], m.txn);
    await rename(fromRel(lib.root, rel), join(tmp, "moved-away.txt"));
    await reopen();
    expect(await markers()).toEqual([]);
    expect(await text(rel)).toBeNull();
    expect(await readFile(join(tmp, "moved-away.txt"), "utf8")).toBe(HAND);
    expect(kinds()).not.toContain("changed-outside-before-rollback");
  });

  it("a copied file as the change left it: removed, the roll-back complete (the control)", async () => {
    const rel = `${folder}/copied.txt`;
    await crashed(async (tx) => {
      await tx.copyFile(join(tmp, "src.txt"), rel);
    });
    await reopen();
    expect(await text(rel)).toBeNull();
    expect(await markers()).toEqual([]);
    expect(causes()).toEqual([]);
  });

  it("a created line with no completion line (the copy was cut off): the half-written file is the change's own and is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "ao-r519half-"));
    try {
      const rel = "Projects/P/half.bin";
      await mkdir(fromRel(root, "Projects/P"), { recursive: true });
      await writeFile(fromRel(root, rel), "half of a cop");
      expect(await undoEntries(root, [{ kind: "created", path: rel }])).toEqual({ ok: true, causes: [] });
      expect(await readFile(fromRel(root, rel)).catch(() => null)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a file written whole by the change (its hash on its line), changed by hand: kept, incomplete", async () => {
    const rel = `${folder}/written.txt`;
    const m = await crashed(async (tx) => {
      await tx.writeFile(rel, "written by the change\n");
    });
    await writeFile(fromRel(lib.root, rel), HAND);
    await keptAndIncomplete(rel, [{ kind: "hand-changed-file", path: rel }], m.txn);
  });

  it("a file in a folder the change made, changed by hand: kept with its folder, incomplete; the folder's other file of the change is removed", async () => {
    const dir = `${folder}/made`;
    const m = await crashed(async (tx) => {
      await tx.mkdir(dir);
      await tx.copyFile(join(tmp, "src.txt"), `${dir}/copied.txt`);
      await tx.writeFile(`${dir}/other.txt`, "the change's other file\n");
    });
    await writeFile(fromRel(lib.root, `${dir}/copied.txt`), HAND);
    await keptAndIncomplete(`${dir}/copied.txt`, [{ kind: "hand-changed-file", path: `${dir}/copied.txt` }], m.txn);
    expect(await text(`${dir}/other.txt`)).toBeNull();
  });

  it("a file the change could not look at (a read error): nothing deleted, incomplete (could-not-look)", async () => {
    const rel = `${folder}/copied.txt`;
    const m = await crashed(async (tx) => {
      await tx.copyFile(join(tmp, "src.txt"), rel);
    });
    await writeFile(fromRel(lib.root, rel), HAND);
    for (const run of ["first", "second"]) {
      seams.failLook = rel;
      await reopen();
      expect(await text(rel), run).toBe(HAND);
      expect(await markers(), run).toEqual([`txn-${m.txn}.json`]);
      expect(causes(), run).toEqual([{ kind: "could-not-look", path: rel }]);
    }
  });
});

describe("R519: the undo of a replaced file never overwrites bytes that are not the change's own", () => {
  /** A hand edit of source.json: the same record, another title. */
  async function editSourceByHand(from: string): Promise<string> {
    const sf = JSON.parse(from) as SourceFile;
    sf.source.title.variants[0]!.value = "Retitled by hand";
    const edited = JSON.stringify(sf);
    await writeFile(fromRel(lib.root, `${folder}/source.json`), edited);
    return edited;
  }

  it("a source record edited by hand while the change waited: kept as edited, incomplete (hand-changed-file), the earlier lines at that path not undone", async () => {
    const rel = `${folder}/source.json`;
    const before = (await text(rel))!;
    const m = await crashed(async (tx) => {
      await tx.writeFile(rel, "the change's first write\n");
      await tx.writeFile(rel, "the change's second write\n");
    });
    const edited = await editSourceByHand(before);
    for (const run of ["first", "second"]) {
      await reopen();
      expect(await text(rel), run).toBe(edited);
      expect(await markers(), run).toEqual([`txn-${m.txn}.json`]);
      expect(causes(), run).toEqual([{ kind: "hand-changed-file", path: rel }]);
      expect(kinds(), run).not.toContain("changed-outside-before-rollback");
    }
    // Moved away by the researcher: the earlier record is put back and the roll-back completes.
    await rename(fromRel(lib.root, rel), join(tmp, "edited.json"));
    await reopen();
    expect(await markers()).toEqual([]);
    expect(await text(rel)).toBe(before);
    expect((await repo.getSource(pid, sid)).annotations.map((a) => a.body)).toEqual(["first", "second"]);
  });

  it("the record as the change left it, or as it was before: put back, complete (the control)", async () => {
    const rel = `${folder}/source.json`;
    const before = await text(rel);
    await crashed(async (tx) => {
      await tx.writeFile(rel, "the change's write\n");
    });
    await reopen();
    expect(await text(rel)).toBe(before);
    expect(await markers()).toEqual([]);
  });
});

describe("the in-process undo answers its causes", () => {
  it("resolving from the list while a hand-changed file stands: refused, the cause and path on the error, the file kept", async () => {
    const rel = `${folder}/copied.txt`;
    await crashed(async (tx) => {
      await tx.copyFile(join(tmp, "src.txt"), rel);
    });
    await writeFile(fromRel(lib.root, rel), HAND);
    await reopen();
    const [pending] = await repo.pendingWrites();
    const err = await repo.resolvePendingWrite(pending!.txn, "roll-back").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PendingWriteIncompleteError);
    expect((err as PendingWriteIncompleteError).causes).toEqual([{ kind: "hand-changed-file", path: rel }]);
    expect(await text(rel)).toBe(HAND);
  });
});

describe("R519 (1): a trashed original whose path is occupied", () => {
  it("by a file put there by hand: nothing touched, the kept copy stays, incomplete (path-occupied); moved away, the original is put back", async () => {
    const rel = `${folder}/kept.txt`;
    await writeFile(fromRel(lib.root, rel), ORIGINAL);
    const m = await crashed(async (tx) => {
      await tx.trash(rel);
    });
    const copy = (m.entries[0] as { to: string }).to;
    await writeFile(fromRel(lib.root, rel), HAND);
    await keptAndIncomplete(rel, [{ kind: "path-occupied", path: rel }], m.txn);
    expect(await text(copy)).toBe(ORIGINAL);
    await rename(fromRel(lib.root, rel), join(tmp, "moved-away.txt"));
    await reopen();
    expect(await markers()).toEqual([]);
    expect(await text(rel)).toBe(ORIGINAL);
    expect(causes()).toEqual([]);
  });

  for (const how of ["written whole", "copied"] as const) {
    it(`by the change's own file (${how}) whose undo failed: that file is removed as its own undo does, and the original is put back`, async () => {
      const rel = `${folder}/kept.txt`;
      await writeFile(fromRel(lib.root, rel), ORIGINAL);
      seams.failUndo = "created";
      await expect(
        repo.mutate(pid, STORE, async (tx) => {
          await tx.trash(rel);
          if (how === "copied") await tx.copyFile(join(tmp, "other.txt"), rel);
          else await tx.writeFile(rel, "the change's own file\n");
          throw new Error("the change failed");
        }),
      ).rejects.toThrow("the change failed");
      seams.failUndo = undefined;
      // The in-process undo: its "created" step failed, yet the trashed step found the change's own bytes and put the original back.
      expect(await text(rel)).toBe(ORIGINAL);
      expect(await markers()).toHaveLength(1);
      await reopen();
      expect(await text(rel)).toBe(ORIGINAL);
      expect(await markers()).toEqual([]);
      expect(causes()).toEqual([]);
    });
  }
});

describe("R519 (3) (R509 M1, M2): where the kept copy of a trashed original is gone, the original's identity tells whether it was put back", () => {
  const rel = () => `${folder}/kept.txt`;
  /** The change trashes the original and writes `again` at its path; a crash before its audit entry. */
  async function trashedThenWritten(again: (tx: Tx) => Promise<void>): Promise<TxnMarker> {
    await writeFile(fromRel(lib.root, rel()), ORIGINAL);
    return crashed(async (tx) => {
      await tx.trash(rel());
      await again(tx);
    });
  }
  const write = (bytes: string) => (tx: Tx) => tx.writeFile(rel(), bytes);

  it("M1: the change wrote the original's very bytes back; the original put back by a roll-back cut before the marker went is DONE, at every later reopen", async () => {
    const m = await trashedThenWritten(write(ORIGINAL));
    await lib.close();
    seams.stopUndoAfter = m.entries.length;
    lib = await openLibrary(lib.root, mkDeps());
    repo = await repoFor();
    expect(seams.stopUndoAfter).toBeUndefined();
    expect(await text(rel())).toBe(ORIGINAL);
    expect(await markers()).toHaveLength(1);
    for (const run of ["second", "third"]) {
      await reopen();
      expect(await text(rel()), run).toBe(ORIGINAL);
      expect(await markers(), run).toEqual([]);
      expect(causes(), run).toEqual([]);
    }
  });

  const GONE: Array<{ name: string; again: (tx: Tx) => Promise<void>; after?: () => Promise<void>; left: string | null }> = [
    { name: "the change's own file written whole at the path", again: write("the change's own file\n"), left: "the change's own file\n" },
    { name: "the change's own COPIED file at the path", again: (tx) => tx.copyFile(join(tmp, "other.txt"), rel()).then(() => undefined), left: "the change's own copied file\n" },
    { name: "a file put there by hand", again: write("the change's own file\n"), after: () => writeFile(fromRel(lib.root, rel()), HAND), left: HAND },
    { name: "nothing at the path", again: write("the change's own file\n"), after: () => rm(fromRel(lib.root, rel())), left: null },
  ];
  for (const g of GONE) {
    it(`M2: the kept copy deleted by hand, ${g.name}: incomplete (kept-copy-gone), nothing deleted or moved, at every reopen`, async () => {
      const m = await trashedThenWritten(g.again);
      await rm(fromRel(lib.root, (m.entries[0] as { to: string }).to), { recursive: true, force: true });
      await g.after?.();
      for (const run of ["first", "second"]) {
        await reopen();
        expect(await text(rel()), run).toBe(g.left);
        expect(await markers(), run).toEqual([`txn-${m.txn}.json`]);
        expect(causes(), run).toEqual([{ kind: "kept-copy-gone", path: rel() }]);
        expect(kinds(), run).not.toContain("changed-outside-before-rollback");
      }
    });
  }

  it("an original the change appended to, then trashed, its kept copy deleted by hand: the original part is gone, incomplete (kept-copy-gone)", async () => {
    await writeFile(fromRel(lib.root, rel()), ORIGINAL);
    const m = await crashed(async (tx) => {
      await tx.appendLine(rel(), "a line the change added");
      await tx.trash(rel());
    });
    await rm(fromRel(lib.root, (m.entries.find((e) => e.kind === "trashed") as { to: string }).to), { force: true });
    for (const run of ["first", "second"]) {
      await reopen();
      expect(await text(rel()), run).toBeNull();
      expect(await markers(), run).toEqual([`txn-${m.txn}.json`]);
      expect(causes(), run).toEqual([{ kind: "kept-copy-gone", path: rel() }]);
    }
  });

  it("the original put back, then replaced by a copy of itself (as when the library was copied to another disk): its identity is lost, incomplete (kept-copy-gone), the file kept", async () => {
    const m = await trashedThenWritten(write("the change's own file\n"));
    await lib.close();
    seams.stopUndoAfter = m.entries.length;
    lib = await openLibrary(lib.root, mkDeps());
    repo = await repoFor();
    expect(await text(rel())).toBe(ORIGINAL);
    await copyFile(fromRel(lib.root, rel()), join(tmp, "copy-of-it"));
    await rename(join(tmp, "copy-of-it"), fromRel(lib.root, rel()));
    await reopen();
    expect(await text(rel())).toBe(ORIGINAL);
    expect(await markers()).toEqual([`txn-${m.txn}.json`]);
    expect(causes()).toEqual([{ kind: "kept-copy-gone", path: rel() }]);
  });

  describe("at the level of the marker's lines", () => {
    let root: string;
    const R = "Projects/P/kept.txt";
    const T = ".tmp/trash-0-0";
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "ao-r519id-"));
      await mkdir(fromRel(root, "Projects/P"), { recursive: true });
      await mkdir(fromRel(root, ".tmp"), { recursive: true });
      await writeFile(fromRel(root, R), ORIGINAL);
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const identity = async () => {
      const st = await stat(fromRel(root, R), { bigint: true });
      return { ino: st.ino.toString(), size: Number(st.size), mtimeNs: st.mtimeNs.toString() };
    };

    it("a crash between the trashed line and its rename (no copy was ever made, no later line): the original is at its path, done", async () => {
      const entries: MarkerEntry[] = [{ kind: "trashed", from: R, to: T, ...(await identity()) }];
      expect(await undoEntries(root, entries)).toEqual({ ok: true, causes: [] });
      expect(await readFile(fromRel(root, R), "utf8")).toBe(ORIGINAL);
    });

    it("an older build's trashed line (no identity) is judged as before: copy gone, a different file there, counted as put back; the change's own bytes there, kept-copy-gone", async () => {
      const own = "the change's own file\n";
      const entries: MarkerEntry[] = [
        { kind: "trashed", from: R, to: T },
        { kind: "created", path: R, sha256: createHash("sha256").update(own).digest("hex") },
      ];
      await writeFile(fromRel(root, R), HAND);
      expect(await undoEntries(root, entries)).toEqual({ ok: true, causes: [] });
      expect(await readFile(fromRel(root, R), "utf8")).toBe(HAND);
      await writeFile(fromRel(root, R), own);
      expect(await undoEntries(root, entries)).toEqual({ ok: false, causes: [{ kind: "kept-copy-gone", path: R }] });
      expect(await readFile(fromRel(root, R), "utf8")).toBe(own);
    });
  });
});
