/**
 * R299 c (the review's I3): this computer's two Zotero sync files are changed by two processes — the app's service and
 * the command line — so every read-modify-write of them takes a lock that holds across processes. Two processes are
 * stood in for by two instances of the module (each with its own in-process turns, as two processes have), and the
 * overlap of their changes is forced: each read of a guarded file waits, after reading, for a read by the other
 * instance (or 30 ms), so without the lock both would change the same old content.
 */
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** While on, every read of a guarded file meets a read by the other instance before it returns (or gives up after 30 ms). */
const gate = { on: false, waiting: undefined as (() => void) | undefined };
async function meet(): Promise<void> {
  const other = gate.waiting;
  if (other) {
    gate.waiting = undefined;
    other();
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      if (gate.waiting === done) gate.waiting = undefined;
      resolve();
    }, 30);
    gate.waiting = done;
  });
}
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const got = await actual.readFile(...args);
      if (gate.on && typeof args[0] === "string" && /zotero-sync(?:-history)?\.json$/u.test(args[0])) await meet();
      return got;
    },
  };
});

type Module = typeof import("./zotero-sync-settings.js");
/** A fresh instance of the module and everything it imports: what another process would have. */
async function instance(): Promise<Module> {
  vi.resetModules();
  return import("./zotero-sync-settings.js");
}

let dir: string;
let A: Module;
let B: Module;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ao-zsync-processes-"));
  A = await instance();
  B = await instance();
  gate.on = false;
});
afterEach(async () => {
  gate.on = false;
  // After every case, nothing of the lock is left.
  expect((await readdir(dir)).filter((n) => n.includes(".lock"))).toEqual([]);
  await rm(dir, { recursive: true, force: true });
});

const link = (ref: string, projectId = "p1") => ({ ref, projectId, fullDone: false, options: { structure: "collections" as const, duplicates: "merge" as const } });
const runRec = (n: number, ref = "user:42") => ({
  id: `run-${String(n).padStart(4, "0")}`,
  ref,
  projectId: "p1",
  trigger: "automatic" as const,
  startedAt: new Date(Date.UTC(2027, 2, 12, 14, 32) + n * 60_000).toISOString(),
  finishedAt: new Date(Date.UTC(2027, 2, 12, 14, 33) + n * 60_000).toISOString(),
  outcome: "up-to-date" as const,
});
const ROUNDS = 20;

describe("R299 c: two processes change this computer's Zotero files at once", () => {
  it("the two instances really are two (each has its own in-process turns)", () => {
    expect(A).not.toBe(B);
    expect(A.updateZoteroSyncSettings).not.toBe(B.updateZoteroSyncSettings);
  });

  it("the review's probe: two changes for two libraries, forced to overlap, twenty rounds — no write lost, in either file", async () => {
    gate.on = true;
    for (let i = 1; i <= ROUNDS; i++) {
      await Promise.all([
        A.updateZoteroSyncSettings(dir, "lib-a", (cur) => ({ ...cur, links: [link(`user:${i}`)] })),
        B.updateZoteroSyncSettings(dir, "lib-b", (cur) => ({ ...cur, links: [link(`group:${i}`)] })),
      ]);
      gate.on = false;
      expect((await A.readZoteroSyncSettings(dir, "lib-a")).links.map((l) => l.ref), `round ${i}`).toEqual([`user:${i}`]);
      expect((await A.readZoteroSyncSettings(dir, "lib-b")).links.map((l) => l.ref), `round ${i}`).toEqual([`group:${i}`]);
      gate.on = true;
      await Promise.all([A.putZoteroSyncRun(dir, "lib-a", runRec(i)), B.putZoteroSyncRun(dir, "lib-b", runRec(i))]);
      gate.on = false;
      expect(await A.readZoteroSyncHistory(dir, "lib-a"), `round ${i}`).toHaveLength(i);
      expect(await A.readZoteroSyncHistory(dir, "lib-b"), `round ${i}`).toHaveLength(i);
      gate.on = true;
    }
  });

  it("a change to the settings beside an appended history record, in both processes at once: nothing lost in either file", async () => {
    await A.writeZoteroSyncSettings(dir, "lib-b", { automatic: true, everyMinutes: 60, links: [link("user:42")] });
    gate.on = true;
    for (let i = 1; i <= ROUNDS; i++) {
      await Promise.all([
        A.updateZoteroSyncSettings(dir, "lib-a", (cur) => ({ ...cur, links: [link(`user:${i}`)] })),
        A.putZoteroSyncRun(dir, "lib-a", runRec(i)),
        B.markZoteroSyncFullDone(dir, "lib-b", "user:42", "p1", {}, i % 2 === 1),
        B.putZoteroSyncRun(dir, "lib-b", runRec(i)),
      ]);
      gate.on = false;
      expect((await A.readZoteroSyncSettings(dir, "lib-a")).links.map((l) => l.ref), `round ${i}`).toEqual([`user:${i}`]);
      expect((await A.readZoteroSyncSettings(dir, "lib-b")).links[0]?.fullDone, `round ${i}`).toBe(i % 2 === 1);
      expect(await A.readZoteroSyncHistory(dir, "lib-a"), `round ${i}`).toHaveLength(i);
      expect(await A.readZoteroSyncHistory(dir, "lib-b"), `round ${i}`).toHaveLength(i);
      gate.on = true;
    }
  });

  it("a lock left behind by a process that died (older than 30 seconds) is taken over and the change goes through", async () => {
    for (const name of [A.ZOTERO_SYNC_FILE, A.ZOTERO_SYNC_HISTORY_FILE]) {
      const lock = join(dir, `${name}.lock`);
      await writeFile(lock, JSON.stringify({ token: "d".repeat(32), at: new Date(Date.now() - 60_000).toISOString() }), { mode: 0o600 });
      const old = new Date(Date.now() - 31_000);
      await utimes(lock, old, old);
    }
    await A.updateZoteroSyncSettings(dir, "lib-a", (cur) => ({ ...cur, links: [link("user:7")] }));
    await A.putZoteroSyncRun(dir, "lib-a", runRec(1));
    expect((await B.readZoteroSyncSettings(dir, "lib-a")).links.map((l) => l.ref)).toEqual(["user:7"]);
    expect(await B.readZoteroSyncHistory(dir, "lib-a")).toHaveLength(1);
  });

  it("a lock that stays taken: the change fails after 5 seconds with the sentence (no path), as a file that could not be changed; nothing is written; a read is not held up", async () => {
    await A.writeZoteroSyncSettings(dir, "lib-a", { automatic: true, everyMinutes: 60, links: [link("user:42")] });
    await A.putZoteroSyncRun(dir, "lib-a", runRec(1));
    const files = [A.ZOTERO_SYNC_FILE, A.ZOTERO_SYNC_HISTORY_FILE];
    const before = await Promise.all(files.map((n) => readFile(join(dir, n), "utf8")));
    const locks = files.map((n) => join(dir, `${n}.lock`));
    // Another process holds both, all along (its lock files are fresh).
    for (const l of locks) await writeFile(l, JSON.stringify({ token: "c".repeat(32), at: new Date().toISOString() }), { mode: 0o600 });
    try {
      const t0 = Date.now();
      const [settingsErr, historyErr, pauseErr] = await Promise.all([
        B.updateZoteroSyncSettings(dir, "lib-a", (cur) => ({ ...cur, everyMinutes: 240 })).catch((e: unknown) => e),
        B.putZoteroSyncRun(dir, "lib-a", runRec(2)).catch((e: unknown) => e),
        // (a third process: in one process the two changes of the settings would wait one after the other)
        A.pauseLink(dir, "lib-a", "user:42", "undone").catch((e: unknown) => e),
      ]);
      const waited = Date.now() - t0;
      expect(waited).toBeGreaterThanOrEqual(4_900);
      expect(waited).toBeLessThan(9_000);
      for (const err of [settingsErr, historyErr, pauseErr]) {
        expect((err as Error).name).toBe("ZoteroSyncFileBusyError");
        // The callers' existing handling of a file that could not be changed applies to it as it is.
        expect(err).toBeInstanceOf(err === pauseErr ? A.ZoteroSyncFileUnreadableError : B.ZoteroSyncFileUnreadableError);
        expect((err as Error).message).toBe("The Zotero sync settings are in use by another program. Try again.");
        expect((err as Error).message).not.toContain(dir);
      }
      expect(await Promise.all(files.map((n) => readFile(join(dir, n), "utf8")))).toEqual(before);
      // A read alone does not take the lock: it is not held up.
      const r0 = Date.now();
      expect((await B.readZoteroSyncSettings(dir, "lib-a")).everyMinutes).toBe(60);
      expect(await B.readZoteroSyncHistory(dir, "lib-a")).toHaveLength(1);
      expect(Date.now() - r0).toBeLessThan(1_000);
      // The other process's lock is its own: left as it was.
      for (const l of locks) expect(JSON.parse(await readFile(l, "utf8")).token).toBe("c".repeat(32));
    } finally {
      for (const l of locks) await rm(l, { force: true });
    }
  }, 20_000);

  it("damaged content found by a read is set aside under the lock too: with the lock taken it is left as it is", async () => {
    const file = join(dir, A.ZOTERO_SYNC_FILE);
    await writeFile(file, "{ damaged");
    const lock = `${file}.lock`;
    await writeFile(lock, JSON.stringify({ token: "c".repeat(32), at: new Date().toISOString() }), { mode: 0o600 });
    try {
      await expect(B.readZoteroSyncSettings(dir, "lib-a")).rejects.toBeInstanceOf(B.ZoteroSyncFileUnreadableError);
      expect(await readFile(file, "utf8")).toBe("{ damaged");
    } finally {
      await rm(lock, { force: true });
    }
    // Once free, the read sets it aside as before.
    expect((await B.readZoteroSyncSettings(dir, "lib-a")).links).toEqual([]);
    expect((await readdir(dir)).some((n) => n.startsWith(`${A.ZOTERO_SYNC_FILE}.unreadable-`))).toBe(true);
  }, 20_000);
});
