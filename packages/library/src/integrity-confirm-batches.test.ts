/**
 * R484 e (FR-420, M5): the integrity check's confirmation in the write queue's turn reads each flagged source ONCE,
 * confirms at most CONFIRM_BATCH_SOURCES sources per turn and leaves the queue between batches (a write asked
 * meanwhile waits for one batch, not for every finding), honours the request's cancel signal between batches, and
 * ends with the error a closed or moved library gives when the library is closed or moved meanwhile: it never drops
 * the findings and answers "nothing missing". Source reads are counted through a wrapped `readSource`; nothing sleeps.
 * FR-749 (R546 1, R570 a): a closed library's write queue grants no further turn, and its `close()` resolves only once
 * the turn in progress has ended and the queue is empty; so after a close the queue is shown drained by `close()`
 * having resolved (and a turn asked then is refused without running), never by asking the closed library for a turn.
 */
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project, SourceFile } from "@ao/core";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { addSource, makeKit, makeProject, scratchFile, type Kit } from "./export/test-kit.js";
import { CONFIRM_BATCH_SOURCES, checkIntegrity } from "./reconnect.js";
import { isClosed } from "./library.js";
import { LibraryClosedError, ReadOnlyLibraryError } from "./repo/errors.js";
import { writeQueueTurn } from "./repo/repo.js";

const reads = vi.hoisted(() => ({ n: 0 }));
vi.mock("./index/load.js", async (orig) => {
  const m = await orig<typeof import("./index/load.js")>();
  return { ...m, readSource: (...a: Parameters<typeof m.readSource>) => (reads.n++, m.readSource(...a)) };
});

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-r484e-");
});
afterEach(async () => {
  await kit.close();
});

async function sourceWith(p: Project, title: string, files: number): Promise<SourceFile> {
  const paths = [];
  for (let i = 0; i < files; i++) paths.push({ path: await scratchFile(kit, `part ${i}.pdf`, `%PDF-1.7 ${title} ${i}`), role: "original" as const, handling: "copy" as const });
  return addSource(kit, p, { title, files: paths });
}

/** `n` sources whose single stored file is gone: one made through the app, the rest copies of its folder on disk. */
async function missingSources(p: Project, n: number): Promise<void> {
  const sf = await sourceWith(p, "Gone", 1);
  await rm(join(kit.lib.root, sf.assets[0]!.path));
  const dir = join(kit.lib.root, sf.source.folder);
  for (let i = 1; i < n; i++) await cp(dir, `${dir} copy ${String(i).padStart(3, "0")}`, { recursive: true });
}

/** The repo's way into the write queue, recording each turn the check takes, with `after` run as each turn ends. */
function confirmRecording(order: string[], after: (turn: number) => void | Promise<void> = () => {}) {
  const turn = writeQueueTurn(kit.repo);
  let asks = 0;
  let asked!: () => void;
  const askedOnce = new Promise<void>((r) => (asked = r));
  return {
    askedOnce,
    asks: () => asks,
    confirm: async <T,>(fn: () => Promise<T>): Promise<T> => {
      const k = ++asks;
      asked();
      const r = await turn(async () => {
        order.push(`batch ${k}`);
        return fn();
      });
      await after(k);
      return r;
    },
  };
}

/** A turn of the queue held by the test until `release` (released too when the test ends, whatever its end). */
function holdQueue(events: string[] = []) {
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  onTestFinished(() => release());
  const held = writeQueueTurn(kit.repo)(async () => {
    await open;
    events.push("held turn ended");
  });
  return { release, held };
}

/** The queue is free: a turn asked now runs at once. */
const queueFree = () => expect(writeQueueTurn(kit.repo)(async () => "free")).resolves.toBe("free");

/**
 * The closed library's queue is drained and takes no further turn (FR-749, R546 1): its `close()` has resolved — which
 * it does only once no turn runs or waits — the lock is gone, and a turn asked now is refused without running.
 */
async function queueDrainedAndClosed(): Promise<void> {
  await kit.lib.close();
  expect(isClosed(kit.lib)).toBe(true);
  expect(existsSync(join(kit.lib.root, ".lock"))).toBe(false);
  let ran = false;
  await expect(writeQueueTurn(kit.repo)(async () => void (ran = true))).rejects.toBeInstanceOf(LibraryClosedError);
  expect(ran).toBe(false);
}

describe("R484 e: the integrity check's confirmation", () => {
  it("reads a source with several findings once", async () => {
    const p = await makeProject(kit);
    const sf = await sourceWith(p, "Three files", 3);
    for (const a of sf.assets) await rm(join(kit.lib.root, a.path));
    const order: string[] = [];
    let atTurn = -1;
    const c = confirmRecording(order);
    const report = await checkIntegrity(kit.lib, "full", {
      keyRing: kit.ring,
      confirm: (fn) => c.confirm(async () => ((atTurn = reads.n), fn())),
    });
    expect(report.missing.map((e) => e.assetId).sort()).toEqual(sf.assets.map((a) => a.id).sort());
    expect(order).toEqual(["batch 1"]);
    expect(reads.n - atTurn).toBe(1);
  });

  it(`${450} flagged sources are confirmed in three turns of at most ${200} sources; a write asked meanwhile runs between two of them`, async () => {
    expect(CONFIRM_BATCH_SOURCES).toBe(200);
    const p = await makeProject(kit);
    await missingSources(p, 450);
    const order: string[] = [];
    const perTurn: number[] = [];
    const hold = holdQueue();
    const c = confirmRecording(order);
    const check = checkIntegrity(kit.lib, "full", {
      keyRing: kit.ring,
      confirm: (fn) =>
        c.confirm(async () => {
          const before = reads.n;
          const r = await fn();
          perTurn.push(reads.n - before);
          return r;
        }),
    });
    await c.askedOnce;
    // Asked while the check waits for its first turn: it must not wait for all three.
    const write = writeQueueTurn(kit.repo)(async () => void order.push("write"));
    hold.release();
    await hold.held;
    const report = await check;
    await write;
    expect(report.missing).toHaveLength(450);
    expect(order).toEqual(["batch 1", "write", "batch 2", "batch 3"]);
    expect(perTurn).toEqual([200, 200, 50]);
  }, 60_000);

  it("a cancel signal aborted between batches ends the check as a cancelled request; no further turn is taken", async () => {
    const p = await makeProject(kit);
    await missingSources(p, 250);
    const ac = new AbortController();
    const order: string[] = [];
    const c = confirmRecording(order, (k) => {
      if (k === 1) ac.abort(new Error("the request was cancelled"));
    });
    await expect(checkIntegrity(kit.lib, "full", { keyRing: kit.ring, confirm: c.confirm, signal: ac.signal })).rejects.toThrow("the request was cancelled");
    expect(order).toEqual(["batch 1"]);
    await queueFree();
  }, 60_000);

  it("a close in mid-confirmation ends the check with the closed library's error, never 'nothing missing'", async () => {
    const p = await makeProject(kit);
    await missingSources(p, 250);
    const order: string[] = [];
    const c = confirmRecording(order, async (k) => {
      if (k === 1) await kit.lib.close();
    });
    const err = await checkIntegrity(kit.lib, "full", { keyRing: kit.ring, confirm: c.confirm }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReadOnlyLibraryError);
    expect((err as ReadOnlyLibraryError).reason).not.toBe("moved");
    expect(order).toEqual(["batch 1"]);
    expect(c.asks()).toBe(1);
    await queueDrainedAndClosed();
  }, 60_000);

  /**
   * The test holds the turn in progress; the check waits behind it; the library is closed. The close waits for the
   * held turn (FR-749, R247 d), so the test releases it WHILE the close waits: the close resolves only after that turn
   * ended, the check's own turn never runs (refused as it comes up), and the check ends as a close mid-way does.
   */
  async function closeWhileWaiting(moved: boolean): Promise<unknown> {
    const p = await makeProject(kit);
    await missingSources(p, 3);
    const events: string[] = [];
    const hold = holdQueue(events);
    const order: string[] = [];
    const c = confirmRecording(order);
    const check = checkIntegrity(kit.lib, "full", { keyRing: kit.ring, confirm: c.confirm }).then(
      () => null,
      (e: unknown) => e,
    );
    await c.askedOnce;
    if (moved) await writeFile(join(kit.lib.root, "MOVED.json"), JSON.stringify({ libraryId: kit.lib.id, movedAt: "2026-11-10T09:31:00.000Z" }));
    const closing = kit.lib.close().then(() => void events.push("close resolved"));
    hold.release();
    await hold.held;
    await closing;
    expect(events).toEqual(["held turn ended", "close resolved"]);
    const err = await check;
    expect(order).toEqual([]);
    expect(c.asks()).toBe(1);
    await queueDrainedAndClosed();
    return err;
  }

  it("a close while the check waits for its first turn ends it the same way", async () => {
    const err = await closeWhileWaiting(false);
    expect(err).toBeInstanceOf(ReadOnlyLibraryError);
    expect((err as ReadOnlyLibraryError).reason).not.toBe("moved");
  });

  it("a move while the check waits for its first turn ends it with the moved library's error", async () => {
    const err = await closeWhileWaiting(true);
    expect(err).toBeInstanceOf(ReadOnlyLibraryError);
    expect((err as ReadOnlyLibraryError).reason).toBe("moved");
  });

  it("a move in mid-confirmation (the old copy marked as moved, its handle closed) ends the check with the moved library's error", async () => {
    const p = await makeProject(kit);
    await missingSources(p, 250);
    const project = kit.repo.getProject(p.id);
    const order: string[] = [];
    const c = confirmRecording(order, async (k) => {
      if (k !== 1) return;
      // What a move leaves at the old place: its marker, the sources no longer where they were, the handle closed.
      await writeFile(join(kit.lib.root, "MOVED.json"), JSON.stringify({ libraryId: kit.lib.id, movedAt: "2026-11-10T09:31:00.000Z" }));
      await mkdir(join(kit.tmp, "elsewhere"));
      await rename(join(kit.lib.root, project.folder, "Sources"), join(kit.tmp, "elsewhere", "Sources"));
      await kit.lib.close();
    });
    const err = await checkIntegrity(kit.lib, "full", { keyRing: kit.ring, confirm: c.confirm }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReadOnlyLibraryError);
    expect((err as ReadOnlyLibraryError).reason).toBe("moved");
    expect(order).toEqual(["batch 1"]);
    expect(c.asks()).toBe(1);
    expect(await readdir(join(kit.tmp, "elsewhere", "Sources"))).toHaveLength(250);
    await queueDrainedAndClosed();
  }, 60_000);
});
