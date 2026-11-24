/**
 * FR-423 (Ruling R469 c): a read of a source whose annotations file really does not match waits for the write
 * queue's turn to confirm it (D21) at most CONFIRM_WAIT_MS. If the turn does not come (a long write holds the queue,
 * such as a restore), the read answers WITHOUT the warning, and ONE confirmation for that source is left to run in
 * the queue's turn; it records the warning then, as the confirmation in the turn does. A lock, a close or a move of
 * the library meanwhile ends it, recording nothing. The long write is held open with the NODE_ENV=test seam in
 * writeSourceFile (R47).
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, type Annotation } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PSEUDO_GOV, addSource, makeKit, makeProject, type Kit } from "../export/test-kit.js";
import { importChange, writeQueueTurn } from "./repo.js";
import { CONFIRM_WAIT_MS, confirmationSeams, pauseBetweenSourceFilesForTests } from "./sources.js";

const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };
let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-fr423-");
});
afterEach(async () => {
  pauseBetweenSourceFilesForTests(undefined);
  confirmationSeams.onRun = undefined;
  await kit.close();
});

const note = (sourceId: string, body: string): Annotation => ({ id: newId(), sourceId, kind: "note", anchors: [], body, author: "tester", createdAt: kit.clock.now.toISOString() });
const setAnnotations = (pid: string, id: string, bodies: string[]) =>
  importChange(kit.repo, pid, STORE, async (ops) => {
    const cur = await ops.readSource(id);
    await ops.writeSource(cur, { ...cur, annotations: bodies.map((b) => note(id, b)) });
  }, { op: "test.annotations" });

/** A project with two annotated sources: `sid` (whose file is changed outside the app) and `other` (written by the long change). */
async function setUp(encrypted = false) {
  const p = await makeProject(kit, encrypted ? PSEUDO_GOV : undefined, encrypted);
  const a = await addSource(kit, p, { title: "Annotated" });
  const b = await addSource(kit, p, { title: "Other" });
  await setAnnotations(p.id, a.source.id, ["first", "second"]);
  await setAnnotations(p.id, b.source.id, ["other"]);
  return { pid: p.id, sid: a.source.id, folder: a.source.folder, other: b.source.id };
}

/** Holds a change of `other` between its two files: a long write holding the queue. */
function longWrite(pid: string, other: string) {
  let release!: () => void;
  let reach!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const open = new Promise<void>((r) => (release = r));
  let first = true;
  pauseBetweenSourceFilesForTests(async () => {
    if (!first) return;
    first = false;
    reach();
    await open;
  });
  const done = setAnnotations(pid, other, ["other", "more"]);
  return { reached, release, done };
}

/** Every turn queued before this one has run. */
const queueDrained = () => writeQueueTurn(kit.repo)(async () => {});
const warnings = () => kit.repo.integrityWarnings.filter((w) => w.kind.startsWith("annotations-"));

describe("FR-423: a read with a real mismatch waits for the queue at most CONFIRM_WAIT_MS", () => {
  it("the bound is two seconds", () => {
    expect(CONFIRM_WAIT_MS).toBe(2_000);
  });

  it("during a long write the read answers after the bound, with the source and no warning; the mismatch is recorded once when the write ends", async () => {
    const s = await setUp();
    // A real change outside the app: the file is removed.
    await rm(join(kit.lib.root, s.folder, "annotations.json"));
    let runs = 0;
    confirmationSeams.onRun = () => runs++;
    const w = longWrite(s.pid, s.other);
    await w.reached;
    const t0 = Date.now();
    const sf = await kit.repo.getSource(s.pid, s.sid); // answers while the write still holds the queue
    expect(Date.now() - t0).toBeGreaterThanOrEqual(CONFIRM_WAIT_MS - 50);
    expect(sf.source.id).toBe(s.sid);
    expect(warnings()).toEqual([]); // nothing unconfirmed is reported
    expect(runs).toBe(0);
    w.release();
    await w.done;
    await queueDrained();
    expect(runs).toBe(1);
    expect(warnings().map((x) => x.kind)).toEqual(["annotations-unreadable"]);
    // And at the next read (the queue free): the same one warning.
    await kit.repo.getSource(s.pid, s.sid);
    expect(warnings()).toHaveLength(1);
  });

  it("many reads of the source during the long write leave one confirmation", async () => {
    const s = await setUp();
    const file = join(kit.lib.root, s.folder, "annotations.json");
    const anns = JSON.parse(await readFile(file, "utf8")) as Annotation[];
    anns[0]!.body = "changed outside the app";
    await writeFile(file, JSON.stringify(anns));
    let runs = 0;
    confirmationSeams.onRun = () => runs++;
    const w = longWrite(s.pid, s.other);
    await w.reached;
    const reads = await Promise.all(Array.from({ length: 5 }, () => kit.repo.getSource(s.pid, s.sid)));
    expect(reads.map((r) => r.annotations[0]?.body)).toEqual(Array(5).fill("changed outside the app"));
    expect(warnings()).toEqual([]);
    w.release();
    await w.done;
    await queueDrained();
    expect(runs).toBe(1);
    expect(warnings().map((x) => x.kind)).toEqual(["annotations-hash-mismatch"]);
  });

  it("a lock while the confirmation waits ends it, recording nothing", async () => {
    const s = await setUp(true);
    await rm(join(kit.lib.root, s.folder, "annotations.json.enc"));
    const w = longWrite(s.pid, s.other);
    await w.reached;
    await kit.repo.getSource(s.pid, s.sid);
    const lock = kit.repo.lockProject(s.pid); // next, ahead of the confirmation (R379)
    w.release();
    await w.done;
    await lock;
    await queueDrained();
    expect(warnings()).toEqual([]);
  });

  it("a close of the library (as a move closes it) while the confirmation waits ends it, recording nothing", async () => {
    const s = await setUp();
    await rm(join(kit.lib.root, s.folder, "annotations.json"));
    let runs = 0;
    confirmationSeams.onRun = () => runs++;
    const w = longWrite(s.pid, s.other);
    await w.reached;
    await kit.repo.getSource(s.pid, s.sid);
    // FR-749 (R546 1): close() now waits for the change in its store turn before the lock goes, so the held write is
    // released while the close is under way (it used to be released after the close had returned).
    const closing = kit.lib.close();
    w.release();
    await closing;
    await w.done.catch(() => {});
    // The closed library's queue starts no further turn (R546 1): it is drained once close() has returned.
    await expect(queueDrained()).rejects.toThrow(/has been closed/);
    // The confirmation was still waiting for its turn when the library was closed: it never begins (R546 1; it used to
    // begin, find the library closed and record nothing). Either way nothing is recorded.
    expect(runs).toBe(0);
    expect(warnings()).toEqual([]);
  });

  it("the ordinary case is unchanged: with the queue free the warning comes with the read", async () => {
    const s = await setUp();
    await rm(join(kit.lib.root, s.folder, "annotations.json"));
    const t0 = Date.now();
    await kit.repo.getSource(s.pid, s.sid);
    expect(Date.now() - t0).toBeLessThan(CONFIRM_WAIT_MS);
    expect(warnings().map((x) => x.kind)).toEqual(["annotations-unreadable"]);
  });
});
