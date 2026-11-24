/**
 * R484 c (R47, R479 b): the test seams FR-420 and FR-423 added — `retentionSeams.afterScan` (the retention's look)
 * and `confirmationSeams.onRun` (a read's confirmation in the write queue's turn) — do nothing when NODE_ENV is not
 * "test", and neither is exported from the package's entry. Each is shown to be reached under "test" first, so that
 * its silence outside it is the guard's doing.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { newId, type Annotation } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSource, makeKit, makeProject, type Kit } from "./export/test-kit.js";
import * as entry from "./index.js";
import { importChange } from "./repo/repo.js";
import { confirmationSeams } from "./repo/sources.js";
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
