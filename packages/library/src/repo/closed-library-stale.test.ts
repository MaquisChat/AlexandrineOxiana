/**
 * FR-749, R560/R562 (R546 1, R247 c): a callback set up inside a change carries that change's context after the change
 * ended. Run after the library was closed and its lock released, it can still write nothing: a governed change, a
 * library event and the write queue's inline turn (`writeQueueTurn`, which runs its function inline for a caller that
 * seems to hold a turn) are all refused at the start of a turn (`repo/state.ts`, `enqueue` → `refusesNewChanges`),
 * whatever context the caller carries; `assertWritable` alone would let the stale context through.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { makeKit, makeProject, walk, type Kit } from "../export/test-kit.js";
import { appendLibraryEvent, importChange, writeQueueTurn } from "./repo.js";

const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };
let kit: Kit | undefined;
afterEach(async () => {
  await kit?.close().catch(() => {});
  kit = undefined;
});

/** Every file under the library with its bytes' digest (folders by name). */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const rel of (await walk(root)).sort()) {
    let digest = "dir";
    try {
      digest = createHash("sha256").update(await readFile(join(root, rel))).digest("hex");
    } catch {
      // a folder
    }
    out.push(`${rel} ${digest}`);
  }
  return out;
}

const outcome = (p: Promise<unknown>) => p.then(() => "done", (e: unknown) => (e instanceof Error ? e.name : String(e)));

describe("a stale callback of an ended change, run after close() (FR-749, R560, R562)", () => {
  it("a governed change, a library event and the write queue's inline turn — from a promise chain and from a timer — are all refused; the folder is byte-identical", async () => {
    kit = await makeKit("ao-closed-stale-");
    const p = await makeProject(kit);
    const repo = kit.repo;
    let open!: () => void;
    const go = new Promise<void>((r) => (open = r));
    onTestFinished(() => open());
    let timerGo = false;
    const log: string[] = [];
    let all!: Promise<unknown>;
    await importChange(
      repo,
      p.id,
      STORE,
      async () => {
        const a = go.then(() => outcome(importChange(repo, p.id, STORE, async () => void log.push("a ran"), { op: "test.stale-a" }))).then((r) => log.push(`change: ${r}`));
        const b = go
          .then(() =>
            outcome(
              writeQueueTurn(repo)(async () => {
                log.push("inline turn ran");
                await appendLibraryEvent(repo, p.id, "test.stale-b", {});
              }),
            ),
          )
          .then((r) => log.push(`inline turn: ${r}`));
        const c = go.then(() => outcome(appendLibraryEvent(repo, p.id, "test.stale-c", {}))).then((r) => log.push(`event: ${r}`));
        const d = new Promise<void>((done) => {
          const t = setInterval(() => {
            if (!timerGo) return;
            clearInterval(t);
            void outcome(importChange(repo, p.id, STORE, async () => void log.push("d ran"), { op: "test.stale-d" })).then((r) => {
              log.push(`timer: ${r}`);
              done();
            });
          }, 1);
        });
        all = Promise.all([a, b, c, d]);
      },
      { op: "test.stale-setup" },
    );
    await kit.lib.close();
    const after = await snapshot(kit.lib.root);
    open();
    timerGo = true;
    await all;
    expect([...log].sort()).toEqual(
      ["change: LibraryClosedError", "event: LibraryClosedError", "inline turn ran", "inline turn: LibraryClosedError", "timer: LibraryClosedError"].sort(),
    );
    expect(await snapshot(kit.lib.root)).toEqual(after);
  });
});
