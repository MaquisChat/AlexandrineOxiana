/**
 * R484 c (R47, R479 b): the test seams FR-420 and FR-423 added — `retentionSeams.afterScan` (the retention's look)
 * and `confirmationSeams.onRun` (a read's confirmation in the write queue's turn) — do nothing when NODE_ENV is not
 * "test", and neither is exported from the package's entry. Each is shown to be reached under "test" first, so that
 * its silence outside it is the guard's doing.
 */
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Annotation } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSource, makeKit, makeProject, type Kit } from "./export/test-kit.js";
import * as entry from "./index.js";
import { importChange } from "./repo/repo.js";
import { seams } from "./repo/seams.js";
import { confirmationSeams } from "./repo/sources.js";
import { fromRel, identityOf, lookNow, undoEntries } from "./repo/txn.js";
import { listDestructions, retentionSeams } from "./retention.js";

const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };

let kit: Kit;
const env = process.env.NODE_ENV;
beforeEach(async () => {
  kit = await makeKit("ao-r484c-");
});
afterEach(async () => {
  process.env.NODE_ENV = env;
  retentionSeams.afterScan = undefined;
  confirmationSeams.onRun = undefined;
  seams.failLook = undefined;
  seams.identityLook = undefined;
  await kit.close();
});

/** Runs `fn` with NODE_ENV set to `value`, then puts it back. */
async function under<T>(value: string, fn: () => Promise<T>): Promise<T> {
  process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = env;
  }
}

describe("R484 c: the new seams are inert outside NODE_ENV=test", () => {
  it("retentionSeams.afterScan is called by the retention's look under test, never under production", async () => {
    const p = await makeProject(kit);
    const calls: string[] = [];
    retentionSeams.afterScan = async (pid) => void calls.push(pid);
    await under("production", () => listDestructions(kit.repo, p.id));
    expect(calls).toEqual([]);
    await under("test", () => listDestructions(kit.repo, p.id));
    expect(calls).toEqual([p.id]);
  });

  it("confirmationSeams.onRun is called by a read's confirmation under test, never under production", async () => {
    const p = await makeProject(kit);
    const sf = await addSource(kit, p, { title: "Annotated" });
    const id = sf.source.id;
    const note = (body: string): Annotation => ({ id: newId(), sourceId: id, kind: "note", anchors: [], body, author: "tester", createdAt: kit.clock.now.toISOString() });
    await importChange(kit.repo, p.id, STORE, async (ops) => {
      const cur = await ops.readSource(id);
      await ops.writeSource(cur, { ...cur, annotations: [note("first")] });
    }, { op: "test.annotations" });
    // A real problem, so that a read outside the queue confirms it in the queue's turn.
    await rm(join(kit.lib.root, sf.source.folder, "annotations.json"));
    const runs: string[] = [];
    confirmationSeams.onRun = (sid) => void runs.push(sid);
    await under("production", () => kit.repo.getSource(p.id, id));
    expect(runs).toEqual([]);
    expect(kit.repo.integrityWarnings.map((w) => w.kind)).toEqual(["annotations-unreadable"]);
    await under("test", () => kit.repo.getSource(p.id, id));
    expect(runs).toEqual([id]);
  });

  it("neither seam is exported from the package's entry", () => {
    expect(Object.keys(entry)).not.toContain("retentionSeams");
    expect(Object.keys(entry)).not.toContain("confirmationSeams");
    expect(Object.values(entry)).not.toContain(retentionSeams);
    expect(Object.values(entry)).not.toContain(confirmationSeams);
  });
});

/**
 * R526 M5 (R47): the roll-back's look seam `seams.failLook` has three sites, the look at a file the change wrote (`look`),
 * the look at a trashed original's identity (`isOriginal`) and (R532 M1) the look at its kept copy; the identity look `seams.identityLook` (R526) replaces
 * what the file system gives. Each is reached under "test", and does nothing under "production".
 */
describe("R526 M5: the roll-back's look seams are inert outside NODE_ENV=test", () => {
  let root: string;
  const R = "Projects/P/kept.txt";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ao-r526m5-"));
    await mkdir(fromRel(root, "Projects/P"), { recursive: true });
    await writeFile(fromRel(root, R), "the original\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("seams.failLook at the look of a file the change wrote: could-not-look under test, the file removed under production", async () => {
    seams.failLook = R;
    expect(await under("test", () => undoEntries(root, [{ kind: "created", path: R }]))).toEqual({ ok: false, causes: [{ kind: "could-not-look", path: R }] });
    expect(await readFile(fromRel(root, R), "utf8")).toBe("the original\n");
    expect(await under("production", () => undoEntries(root, [{ kind: "created", path: R }]))).toEqual({ ok: true, causes: [] });
    expect(await readFile(fromRel(root, R)).catch(() => null)).toBeNull();
  });

  it("seams.failLook at the look of a trashed original's identity: could-not-look under test, the original found put back under production", async () => {
    const st = await stat(fromRel(root, R), { bigint: true });
    // The kept copy is gone (never made): only the identity look is reached at this path.
    const entries = [{ kind: "trashed" as const, from: R, to: ".tmp/trash-0-0", ino: st.ino.toString(), birthtimeNs: st.birthtimeNs.toString() }];
    seams.failLook = R;
    // R532 M1: the copy is gone, so the place the app could not look at may hold a loss (`copyGone`).
    expect(await under("test", () => undoEntries(root, entries))).toEqual({ ok: false, causes: [{ kind: "could-not-look", path: R, copyGone: true }] });
    expect(await under("production", () => undoEntries(root, entries))).toEqual({ ok: true, causes: [] });
    expect(await readFile(fromRel(root, R), "utf8")).toBe("the original\n");
  });

  it("R532 M1: seams.failLook at the look at a trashed original's kept copy: could-not-look under test, the copy put back under production", async () => {
    const to = ".tmp/trash-0-0";
    await mkdir(fromRel(root, ".tmp"), { recursive: true });
    await rename(fromRel(root, R), fromRel(root, to));
    const entries = [{ kind: "trashed" as const, from: R, to }];
    seams.failLook = to;
    expect(await under("test", () => undoEntries(root, entries))).toEqual({ ok: false, causes: [{ kind: "could-not-look", path: R, copyUnread: true }] });
    expect(await readFile(fromRel(root, to), "utf8")).toBe("the original\n");
    expect(await under("production", () => undoEntries(root, entries))).toEqual({ ok: true, causes: [] });
    expect(await readFile(fromRel(root, R), "utf8")).toBe("the original\n");
  });

  it("R528 M8: seams.failLook at the close's look at a lost file's place: could-not-look under test, what is there under production", async () => {
    seams.failLook = R;
    expect(await under("test", () => lookNow(root, R))).toBe("could-not-look");
    expect(await under("production", () => lookNow(root, R))).toBe("a file");
  });

  it("seams.identityLook replaces the identity the file system gives under test, never under production", async () => {
    const st = await stat(fromRel(root, R), { bigint: true });
    seams.identityLook = (_at, real) => ({ ino: real.ino, birthtimeNs: 0n });
    expect(await under("test", () => identityOf(fromRel(root, R), "trash-before"))).toBeUndefined();
    expect(await under("production", () => identityOf(fromRel(root, R), "trash-before"))).toEqual({ ino: st.ino.toString(), birthtimeNs: st.birthtimeNs.toString() });
  });

  it("the seams object is not exported from the package's entry", () => {
    expect(Object.values(entry)).not.toContain(seams);
    expect(Object.keys(entry)).not.toContain("seams");
  });
});
