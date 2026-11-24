/**
 * FR-736 (R503 d, R509, R519): while the undo of an interrupted change is incomplete, what the library says is true of
 * the state it is in. Each incomplete undo carries its state (`try-again`, `in-the-way`, `lost`) on its warning and in
 * the list of interrupted changes, with the causes and their library-relative paths in the list; "Roll it back"
 * answers by the state; a write is refused without advice to reopen; an in-process undo that fails says so too.
 */
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Annotation, type Provenance, type SourceDraft, type SourceFile } from "@ao/core";
import { INCOMPLETE_ROLLBACK_BANNER, ROLLBACK_CAUSE_TEXT, ROLLBACK_INCOMPLETE_ANSWER } from "@ao/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import type { Repo } from "./index.js";
import type { Tx } from "./mutate.js";
import { importChange } from "./repo.js";
import { PendingWriteIncompleteError, RecoveryPendingError } from "./errors.js";
import { SimulatedCrash, openTestRepo, seams } from "./testing.js";
import { fromRel, type TxnMarker } from "./txn.js";

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
const reopen = async () => {
  await lib.close();
  lib = await openLibrary(lib.root, mkDeps());
  repo = await repoFor();
};
const mine = () => repo.integrityWarnings.filter((x) => x.projectId === pid);

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-fr736-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  await writeFile(join(tmp, "in.pdf"), PDF);
  await writeFile(join(tmp, "src.txt"), ORIGINAL);
  repo = await repoFor();
  pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  const sf = await repo.createSource(pid, draft("Annotated"), [{ path: join(tmp, "in.pdf"), role: "original", handling: "copy" }], { provenance: provenance() });
  sid = sf.source.id;
  folder = sf.source.folder;
  await importChange(repo, pid, STORE, async (ops) => {
    const cur = await ops.readSource(sid);
    await ops.writeSource(cur, withNotes(cur, ["first"]));
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

/** A change cut off by a crash before its audit entry: its marker is left for the next open. */
async function crashed(fn: (tx: Tx) => Promise<void>): Promise<TxnMarker> {
  seams.crashAt = "before-audit";
  await expect(repo.mutate(pid, STORE, fn)).rejects.toBeInstanceOf(SimulatedCrash);
  seams.crashAt = undefined;
  return readMarker();
}

/** The four states the undo can be left in at a reopen, each with the case that makes it. */
const CASES: Array<{ name: string; state: "try-again" | "could-not-read" | "in-the-way" | "lost" | "unconfirmed"; causes: (rel: string) => Array<{ kind: string; path: string; somethingThere?: true }>; make: () => Promise<{ rel: string; before?: () => void }> }> = [
  {
    name: "a file the change wrote, changed by hand (hand-changed-file)",
    state: "in-the-way",
    causes: (rel) => [{ kind: "hand-changed-file", path: rel }],
    make: async () => {
      const rel = `${folder}/copied.txt`;
      await crashed(async (tx) => {
        await tx.copyFile(join(tmp, "src.txt"), rel);
      });
      await writeFile(fromRel(lib.root, rel), HAND);
      return { rel };
    },
  },
  {
    name: "a trashed original whose place a hand-put file occupies (path-occupied)",
    state: "in-the-way",
    causes: (rel) => [{ kind: "path-occupied", path: rel }],
    make: async () => {
      const rel = `${folder}/kept.txt`;
      await writeFile(fromRel(lib.root, rel), ORIGINAL);
      await crashed(async (tx) => {
        await tx.trash(rel);
      });
      await writeFile(fromRel(lib.root, rel), HAND);
      return { rel };
    },
  },
  {
    // R527: a file stands at the place: the app cannot confirm it is not the original, so it never says "lost".
    name: "a trashed original whose kept copy is gone, a file at its place (kept-copy-gone)",
    state: "unconfirmed",
    causes: (rel) => [{ kind: "kept-copy-gone", path: rel, somethingThere: true }],
    make: async () => {
      const rel = `${folder}/kept.txt`;
      await writeFile(fromRel(lib.root, rel), ORIGINAL);
      const m = await crashed(async (tx) => {
        await tx.trash(rel);
        await tx.writeFile(rel, "the change's own file\n");
      });
      await rm(fromRel(lib.root, (m.entries[0] as { to: string }).to), { recursive: true, force: true });
      return { rel };
    },
  },
  {
    name: "a trashed original whose kept copy is gone, nothing at its place (kept-copy-gone)",
    state: "lost",
    causes: (rel) => [{ kind: "kept-copy-gone", path: rel }],
    make: async () => {
      const rel = `${folder}/kept.txt`;
      await writeFile(fromRel(lib.root, rel), ORIGINAL);
      const m = await crashed(async (tx) => {
        await tx.trash(rel);
        await tx.writeFile(rel, "the change's own file\n");
      });
      await rm(fromRel(lib.root, (m.entries[0] as { to: string }).to), { recursive: true, force: true });
      await rm(fromRel(lib.root, rel));
      return { rel };
    },
  },
  {
    // R528 M4: the same cause, the same words: "the app could not read a file", never "a step failed".
    name: "a file that could not be read (could-not-look)",
    state: "could-not-read",
    causes: (rel) => [{ kind: "could-not-look", path: rel }],
    make: async () => {
      const rel = `${folder}/copied.txt`;
      await crashed(async (tx) => {
        await tx.copyFile(join(tmp, "src.txt"), rel);
      });
      return { rel, before: () => void (seams.failLook = rel) };
    },
  },
  {
    name: "a step that failed for no cause the undo can name",
    state: "try-again",
    causes: () => [],
    make: async () => {
      const rel = `${folder}/written.txt`;
      await crashed(async (tx) => {
        await tx.writeFile(rel, "written by the change\n");
      });
      return { rel, before: () => void (seams.failUndo = "created") };
    },
  },
];

describe("FR-736: an incomplete undo at the opening carries its state", () => {
  for (const c of CASES) {
    it(`${c.name}: the warning, the list and "Roll it back" say ${c.state}`, async () => {
      const { rel, before } = await c.make();
      before?.();
      await reopen();
      const w = mine().filter((x) => x.kind === "rolled-back-incomplete-write");
      expect(w).toHaveLength(1);
      expect(w[0]!.rollback).toBe(c.state);
      // The detail (what the command line prints) never promises a retry that cannot help.
      if (c.state !== "try-again" && c.state !== "could-not-read") expect(w[0]!.detail).not.toMatch(/retried/u);
      const [pw] = await repo.pendingWrites();
      expect(pw).toMatchObject({ projectId: pid, canRollBack: true, rollback: c.state, causes: c.causes(rel) });
      const err = await repo.resolvePendingWrite(pw!.txn, "roll-back").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PendingWriteIncompleteError);
      expect((err as Error).message).toBe(ROLLBACK_INCOMPLETE_ANSWER[c.state]);
      // Answered again by the list, from the latest attempt.
      expect((await repo.pendingWrites())[0]).toMatchObject({ rollback: c.state, causes: c.causes(rel) });
    });
  }

  it("a recorded choice to roll back that cannot be completed at the next opening: its warning and the list keep the state", async () => {
    const c = CASES[3]!;
    await c.make();
    await reopen();
    const [pw] = await repo.pendingWrites();
    await expect(repo.resolvePendingWrite(pw!.txn, "roll-back")).rejects.toBeInstanceOf(PendingWriteIncompleteError);
    await reopen();
    const w = mine().filter((x) => x.kind === "incomplete-write-pending");
    expect(w).toHaveLength(1);
    expect(w[0]!.rollback).toBe("lost");
    expect((await repo.pendingWrites())[0]).toMatchObject({ rollback: "lost", causes: [{ kind: "kept-copy-gone" }] });
  });

  it("a complete undo carries no state: its sentence stays the one that says it was undone", async () => {
    await crashed(async (tx) => {
      await tx.writeFile(`${folder}/written.txt`, "written by the change\n");
    });
    await reopen();
    const w = mine().filter((x) => x.kind === "rolled-back-incomplete-write");
    expect(w).toHaveLength(1);
    expect(w[0]!.rollback).toBeUndefined();
    expect(await repo.pendingWrites()).toEqual([]);
  });
});

describe("FR-736: a change whose own undo fails in the running app", () => {
  it("raises the warning with its state, so that the banner offers the list at once", async () => {
    const rel = `${folder}/written.txt`;
    seams.failUndo = "created";
    await expect(
      repo.mutate(pid, STORE, async (tx) => {
        await tx.writeFile(rel, "written by the change\n");
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    seams.failUndo = undefined;
    const w = mine().filter((x) => x.kind === "rolled-back-incomplete-write");
    expect(w).toHaveLength(1);
    expect(w[0]!.rollback).toBe("try-again");
    expect((await repo.pendingWrites())[0]).toMatchObject({ rollback: "try-again" });
    // Resolved from the list: its warning goes.
    await repo.resolvePendingWrite((await repo.pendingWrites())[0]!.txn, "roll-back");
    expect(mine().filter((x) => x.kind === "rolled-back-incomplete-write")).toEqual([]);
  });
});

describe("R528 M5: the command line's detail of a change whose own undo failed is true of its state", () => {
  it("a step that failed: retried on the next open (true: the opening tries it again)", async () => {
    seams.failUndo = "created";
    await expect(
      repo.mutate(pid, STORE, async (tx) => {
        await tx.writeFile(`${folder}/written.txt`, "written by the change\n");
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    const [w] = mine().filter((x) => x.kind === "rolled-back-incomplete-write");
    expect(w!.detail).toMatch(/^a change that failed could only be partly rolled back; the marker is kept and recovery is retried on the next open \(transaction [0-9a-f-]+\)$/u);
  });

  it("a file that could not be read: said so, with where the file is named", async () => {
    const rel = `${folder}/written.txt`;
    seams.failLook = rel;
    await expect(
      repo.mutate(pid, STORE, async (tx) => {
        await tx.writeFile(rel, "written by the change\n");
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    const [w] = mine().filter((x) => x.kind === "rolled-back-incomplete-write");
    expect(w!.rollback).toBe("could-not-read");
    expect(w!.detail).toMatch(
      /^a change that failed could only be partly rolled back, because the app could not read a file; the marker is kept, and recovery is retried on the next open or by rolling it back in the app's list of interrupted changes, which names the file \(transaction [0-9a-f-]+\)$/u,
    );
  });
});

describe("FR-736: a write refused while the undo is incomplete", () => {
  it("names no reopening, which cannot help while the cause stands", async () => {
    await CASES[2]!.make();
    await reopen();
    const err = await repo.mutate(pid, STORE, async () => undefined).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RecoveryPendingError);
    // R528 M3: held by an interrupted change (the service then says so, and points to its warning).
    expect((err as RecoveryPendingError).reason).toBe("interrupted-change");
    expect((err as Error).message).not.toMatch(/reopen/u);
    expect((err as Error).message).toMatch(/integrity warnings say which, and what to do/u);
  });
});

/** The library's sentence for a banner of this state (the screens say it as it is, with the project's name). */
const bannerOf = (state: string | undefined) => INCOMPLETE_ROLLBACK_BANNER[state as keyof typeof INCOMPLETE_ROLLBACK_BANNER]("P");
const standing = () => mine().filter((x) => x.kind === "rolled-back-incomplete-write");

describe("R528 I1, M2: the banner speaks of the worst thing true, and the words lead in order", () => {
  /** Probe P1/P2's change: it trashed a.txt (its kept copy then deleted: nothing at its place) and wrote b.txt. */
  async function lostAndWritten(): Promise<{ a: string; b: string }> {
    const a = `${folder}/a.txt`;
    const b = `${folder}/b.txt`;
    await writeFile(fromRel(lib.root, a), ORIGINAL);
    const m = await crashed(async (tx) => {
      await tx.trash(a);
      await tx.writeFile(b, "written by the change\n");
    });
    await rm(fromRel(lib.root, (m.entries[0] as { to: string }).to), { recursive: true, force: true });
    return { a, b };
  }

  it("probe P1: a lost file AND a file changed by hand: the banner never says nothing was lost; the list names both", async () => {
    const { a, b } = await lostAndWritten();
    await writeFile(fromRel(lib.root, b), HAND);
    await reopen();
    expect(standing().map((w) => w.rollback)).toEqual(["lost-and-blocked"]);
    expect(bannerOf(standing()[0]!.rollback)).toBe(
      "An interrupted change in P cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. Something else also stops the undo, and you can deal with it first: move the file the list names, or try again. After that, the list says whether the change can be closed as it is. Changes to P are off until then. Choose “Resolve…” to see what to do first.",
    );
    // R530: the command line's detail promises no close either.
    expect(standing()[0]!.detail).toMatch(
      /^a change interrupted before it was audited could only be partly rolled back: the copy the app kept of a file it removed is gone, so that file cannot be put back, and something else also stops the roll-back \(the app's list of interrupted changes names it\); the marker is kept, and once that is dealt with, that list says whether the change can be closed as it is \(transaction [^)]+\)$/u,
    );
    const [pw] = await repo.pendingWrites();
    expect(pw).toMatchObject({ rollback: "lost-and-blocked", canClose: false, causes: [{ kind: "kept-copy-gone", path: a }, { kind: "hand-changed-file", path: b }] });
    expect(pw!.causes!.map((c) => ROLLBACK_CAUSE_TEXT[c.kind](c.path))).toEqual([
      `The file this change removed from ${a} cannot be put back: the copy the app kept of it is gone, so it is lost.`,
      `${b} was changed or put there outside the app, so the app left it as it is. Move it somewhere outside the library (it is kept there as it is), then choose “Roll it back”.`,
    ]);
  });

  it("probe P2: a lost file AND a step that failed: the same banner; the list names the lost file", async () => {
    const { a } = await lostAndWritten();
    seams.failUndo = "created";
    await reopen();
    expect(standing().map((w) => w.rollback)).toEqual(["lost-and-blocked"]);
    expect(bannerOf(standing()[0]!.rollback)).not.toMatch(/Nothing was lost|a step failed/u);
    const [pw] = await repo.pendingWrites();
    expect(pw).toMatchObject({ rollback: "lost-and-blocked", canClose: false, causes: [{ kind: "kept-copy-gone", path: a }] });
    expect(pw!.causes!.map((c) => ROLLBACK_CAUSE_TEXT[c.kind](c.path))).toEqual([`The file this change removed from ${a} cannot be put back: the copy the app kept of it is gone, so it is lost.`]);
    // Tried again once the step passes: only the loss is left, and the close is offered.
    seams.failUndo = undefined;
    const err = await repo.resolvePendingWrite(pw!.txn, "roll-back").then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe("The change cannot be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back. You can now close the change as it is from the list.");
    expect((await repo.pendingWrites())[0]).toMatchObject({ rollback: "lost", canClose: true });
  });

  it("the mixed state step by step: a lost file and a copy kept behind a file in the way → move the file → \"Roll it back\" → the close", async () => {
    const a = `${folder}/a.txt`;
    const c = `${folder}/c.txt`;
    await writeFile(fromRel(lib.root, a), ORIGINAL);
    await writeFile(fromRel(lib.root, c), "the researcher's c\n");
    const m = await crashed(async (tx) => {
      await tx.trash(a);
      await tx.trash(c);
    });
    await rm(fromRel(lib.root, (m.entries[0] as { to: string }).to), { recursive: true, force: true });
    await writeFile(fromRel(lib.root, c), HAND);
    await reopen();
    // 1. The loss is said first, then what can be done (move the file the list names), then the close.
    expect(standing().map((w) => w.rollback)).toEqual(["lost-and-blocked"]);
    let [pw] = await repo.pendingWrites();
    expect(pw).toMatchObject({ rollback: "lost-and-blocked", canClose: false, causes: [{ kind: "kept-copy-gone", path: a }, { kind: "path-occupied", path: c }] });
    // 2. The researcher moves the file the list names out of the library.
    await rename(fromRel(lib.root, c), join(tmp, "moved-out.txt"));
    // 3. "Roll it back": c.txt is put back; only the loss is left, and the answer names the close.
    const err = await repo.resolvePendingWrite(pw!.txn, "roll-back").then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe(ROLLBACK_INCOMPLETE_ANSWER.lost);
    expect(await readFile(fromRel(lib.root, c), "utf8")).toBe("the researcher's c\n");
    [pw] = await repo.pendingWrites();
    expect(pw).toMatchObject({ rollback: "lost", canClose: true, causes: [{ kind: "kept-copy-gone", path: a }] });
    // R528 I2: the banner says the same as the list.
    expect(standing().map((w) => w.rollback)).toEqual(["lost"]);
    expect(bannerOf(standing()[0]!.rollback)).toBe(
      "An interrupted change in P cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. That file is lost. Changes to P are off until you close the change. Choose “Resolve…” to see what was lost.",
    );
    // 4. Closed: the project takes changes again.
    await repo.closePendingWrite(pw!.txn, pid);
    expect(await repo.pendingWrites()).toEqual([]);
    await repo.mutate(pid, STORE, async (tx) => tx.writeFile(`${folder}/after.txt`, "a later change\n"));
  });
});

describe("R528 I2: the warning follows every outcome of the list's acts", () => {
  it("probe P1 continued: the file moved away, \"Roll it back\": the list says lost and offers the close, and so does the warning", async () => {
    const a = `${folder}/a.txt`;
    const b = `${folder}/b.txt`;
    await writeFile(fromRel(lib.root, a), ORIGINAL);
    const m = await crashed(async (tx) => {
      await tx.trash(a);
      await tx.writeFile(b, "written by the change\n");
    });
    await rm(fromRel(lib.root, (m.entries[0] as { to: string }).to), { recursive: true, force: true });
    await writeFile(fromRel(lib.root, b), HAND);
    await reopen();
    expect(standing().map((w) => [w.rollback, w.causes?.map((c) => c.kind)])).toEqual([["lost-and-blocked", ["kept-copy-gone", "hand-changed-file"]]]);
    await rename(fromRel(lib.root, b), join(tmp, "b-moved-out.txt"));
    await expect(repo.resolvePendingWrite(m.txn, "roll-back")).rejects.toBeInstanceOf(PendingWriteIncompleteError);
    expect((await repo.pendingWrites())[0]).toMatchObject({ rollback: "lost", canClose: true });
    const w = standing();
    expect(w.map((x) => [x.rollback, x.causes?.map((c) => c.kind)])).toEqual([["lost", ["kept-copy-gone"]]]);
    // The command line's detail follows too (never "retried", never "in the way").
    expect(w[0]!.detail).toBe(
      `a change interrupted before it was audited could only be partly rolled back: the copy the app kept of a file it removed is gone, so that file cannot be put back; the marker is kept until the change is closed in the app's list of interrupted changes (transaction ${m.txn})`,
    );
  });

  it("a change whose own undo failed in the running app, then rolled back from the list with a file changed by hand: try-again → in-the-way", async () => {
    const rel = `${folder}/written.txt`;
    seams.failUndo = "created";
    await expect(
      repo.mutate(pid, STORE, async (tx) => {
        await tx.writeFile(rel, "written by the change\n");
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    seams.failUndo = undefined;
    expect(standing().map((x) => x.rollback)).toEqual(["try-again"]);
    await writeFile(fromRel(lib.root, rel), HAND);
    const [pw] = await repo.pendingWrites();
    await expect(repo.resolvePendingWrite(pw!.txn, "roll-back")).rejects.toBeInstanceOf(PendingWriteIncompleteError);
    const w = standing();
    expect(w.map((x) => [x.rollback, x.causes])).toEqual([["in-the-way", [{ kind: "hand-changed-file", path: rel }]]]);
    expect(w[0]!.detail).toBe(
      `a change that failed could only be partly rolled back, because a file changed or put there outside the app is in the way; the marker is kept, and the roll-back completes once that file is moved away (the app's list of interrupted changes names it) (transaction ${pw!.txn})`,
    );
    // Moved away and rolled back: the warning goes.
    await rm(fromRel(lib.root, rel));
    await repo.resolvePendingWrite(pw!.txn, "roll-back");
    expect(standing()).toEqual([]);
  });

  it("a recorded choice's warning (incomplete-write-pending) follows too", async () => {
    const a = `${folder}/a.txt`;
    const c = `${folder}/c.txt`;
    await writeFile(fromRel(lib.root, a), ORIGINAL);
    await writeFile(fromRel(lib.root, c), "c\n");
    const m = await crashed(async (tx) => {
      await tx.trash(a);
      await tx.trash(c);
    });
    await rm(fromRel(lib.root, (m.entries[0] as { to: string }).to), { recursive: true, force: true });
    await writeFile(fromRel(lib.root, c), HAND);
    await reopen();
    await expect(repo.resolvePendingWrite(m.txn, "roll-back")).rejects.toBeInstanceOf(PendingWriteIncompleteError);
    await reopen();
    const pending = () => mine().filter((x) => x.kind === "incomplete-write-pending");
    expect(pending().map((x) => x.rollback)).toEqual(["lost-and-blocked"]);
    await rm(fromRel(lib.root, c));
    await expect(repo.resolvePendingWrite(m.txn, "roll-back")).rejects.toBeInstanceOf(PendingWriteIncompleteError);
    expect(pending().map((x) => [x.rollback, x.causes?.map((k) => k.kind)])).toEqual([["lost", ["kept-copy-gone"]]]);
  });
});
