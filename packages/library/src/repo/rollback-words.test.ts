/**
 * FR-736 (R503 d, R509, R519): while the undo of an interrupted change is incomplete, what the library says is true of
 * the state it is in. Each incomplete undo carries its state (`try-again`, `in-the-way`, `lost`) on its warning and in
 * the list of interrupted changes, with the causes and their library-relative paths in the list; "Roll it back"
 * answers by the state; a write is refused without advice to reopen; an in-process undo that fails says so too.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Annotation, type Provenance, type SourceDraft, type SourceFile } from "@ao/core";
import { ROLLBACK_INCOMPLETE_ANSWER } from "@ao/shared";
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
const CASES: Array<{ name: string; state: "try-again" | "in-the-way" | "lost"; causes: (rel: string) => Array<{ kind: string; path: string }>; make: () => Promise<{ rel: string; before?: () => void }> }> = [
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
    name: "a trashed original whose kept copy is gone (kept-copy-gone)",
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
      return { rel };
    },
  },
  {
    name: "a file that could not be read (could-not-look)",
    state: "try-again",
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
      if (c.state !== "try-again") expect(w[0]!.detail).not.toMatch(/retried/u);
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
    const c = CASES[2]!;
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

describe("FR-736: a write refused while the undo is incomplete", () => {
  it("names no reopening, which cannot help while the cause stands", async () => {
    await CASES[2]!.make();
    await reopen();
    const err = await repo.mutate(pid, STORE, async () => undefined).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RecoveryPendingError);
    expect((err as Error).message).not.toMatch(/reopen/u);
    expect((err as Error).message).toMatch(/integrity warnings say which, and what to do/u);
  });
});
