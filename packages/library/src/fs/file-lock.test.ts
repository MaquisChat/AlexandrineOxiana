/**
 * R299 c: the lock that holds across processes around a read-modify-write of a small file (the per-computer Zotero sync
 * files). A file created exclusively beside the guarded one; held only while the step runs; a waiter tries again for a
 * bounded time and then fails in its own error; a lock left by a process that died (older than the stale bound) is taken
 * over, by one waiter only; released only by its holder.
 */
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILE_LOCK_STALE_MS, FILE_LOCK_WAIT_MS, FileLockBusyError, fileLockPath, withFileLock } from "./file-lock.js";

let dir: string;
let guarded: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ao-file-lock-"));
  guarded = join(dir, "settings.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Nothing of the lock is left in the folder: no lock file, no take-over file. */
const leftovers = async () => (await readdir(dir)).filter((n) => n.includes(".lock"));
/** A lock file written as another process would write it, `ageMs` old by the file's own time. */
async function foreignLock(path: string, ageMs: number, content = JSON.stringify({ token: "f".repeat(32), at: new Date(Date.now() - ageMs).toISOString() })) {
  await writeFile(path, content, { mode: 0o600 });
  const t = new Date(Date.now() - ageMs);
  await utimes(path, t, t);
}

describe("withFileLock", () => {
  it("the bounds are the ruling's: a waiter waits 5 seconds; a lock is left by a dead process after 30", () => {
    expect(FILE_LOCK_WAIT_MS).toBe(5_000);
    expect(FILE_LOCK_STALE_MS).toBe(30_000);
  });

  it("holds a lock file beside the guarded file while the step runs: created exclusively, 0600, a token and a time only; removed after", async () => {
    let seen: { mode: number; doc: Record<string, unknown> } | undefined;
    const out = await withFileLock(guarded, async () => {
      const lock = fileLockPath(guarded);
      expect(lock).toBe(join(dir, "settings.json.lock"));
      const st = await stat(lock);
      seen = { mode: st.mode & 0o777, doc: JSON.parse(await readFile(lock, "utf8")) as Record<string, unknown> };
      return 7;
    });
    expect(out).toBe(7);
    if (process.platform !== "win32") expect(seen!.mode).toBe(0o600);
    expect(Object.keys(seen!.doc).sort()).toEqual(["at", "token"]);
    expect(seen!.doc.token).toMatch(/^[0-9a-f]{32}$/u);
    expect(Number.isNaN(Date.parse(String(seen!.doc.at)))).toBe(false);
    expect(JSON.stringify(seen!.doc)).not.toContain(dir);
    expect(await leftovers()).toEqual([]);
  });

  it("is released when the step fails, and the step's own error comes out unchanged", async () => {
    const boom = new Error("the step's own failure");
    await expect(withFileLock(guarded, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(await leftovers()).toEqual([]);
  });

  it("two holders never overlap: the second waits until the first has released", async () => {
    let active = 0;
    let most = 0;
    const step = async () => {
      active++;
      most = Math.max(most, active);
      await sleep(30);
      active--;
    };
    await Promise.all(Array.from({ length: 6 }, () => withFileLock(guarded, step, { retryMs: 5 })));
    expect(most).toBe(1);
    expect(await leftovers()).toEqual([]);
  });

  it("a lock that stays taken: the waiter fails after the bound with its own error, the step never runs, the holder's lock is left", async () => {
    const lock = fileLockPath(guarded);
    await foreignLock(lock, 0);
    const before = await readFile(lock, "utf8");
    let ran = false;
    const t0 = Date.now();
    const err = await withFileLock(guarded, async () => void (ran = true), { waitMs: 300, retryMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileLockBusyError);
    expect(String((err as Error).message)).not.toContain(dir);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    expect(ran).toBe(false);
    expect(await readFile(lock, "utf8")).toBe(before);
  });

  it("a lock older than the stale bound (by the file's time) was left by a process that died: it is taken over and the step runs", async () => {
    await foreignLock(fileLockPath(guarded), FILE_LOCK_STALE_MS + 1_000);
    let ran = false;
    await withFileLock(guarded, async () => void (ran = true), { waitMs: 300, retryMs: 10 });
    expect(ran).toBe(true);
    expect(await leftovers()).toEqual([]);
  });

  it("a lock just under the stale bound is not taken over", async () => {
    await foreignLock(fileLockPath(guarded), FILE_LOCK_STALE_MS - 5_000);
    await expect(withFileLock(guarded, async () => undefined, { waitMs: 100, retryMs: 10 })).rejects.toBeInstanceOf(FileLockBusyError);
  });

  it("R306 c: a lock dated more than the stale bound AHEAD of now (the clock was set back after it was left) is taken over; one just inside the bound is not", async () => {
    await foreignLock(fileLockPath(guarded), -(FILE_LOCK_STALE_MS - 1_000));
    await expect(withFileLock(guarded, async () => undefined, { waitMs: 100, retryMs: 10 })).rejects.toBeInstanceOf(FileLockBusyError);
    await foreignLock(fileLockPath(guarded), -(FILE_LOCK_STALE_MS + 1_000));
    let ran = false;
    await withFileLock(guarded, async () => void (ran = true), { waitMs: 300, retryMs: 10 });
    expect(ran).toBe(true);
    expect(await leftovers()).toEqual([]);
  });

  it("the file's time decides, not the time written in it: an old time in a fresh file is not stale", async () => {
    await foreignLock(fileLockPath(guarded), 0, JSON.stringify({ token: "e".repeat(32), at: "2001-01-01T00:00:00.000Z" }));
    await expect(withFileLock(guarded, async () => undefined, { waitMs: 100, retryMs: 10 })).rejects.toBeInstanceOf(FileLockBusyError);
  });

  it("an empty or unreadable lock (a process that died between creating and writing it) is taken over once it is old, and only then", async () => {
    const lock = fileLockPath(guarded);
    await foreignLock(lock, 0, "");
    await expect(withFileLock(guarded, async () => undefined, { waitMs: 100, retryMs: 10 })).rejects.toBeInstanceOf(FileLockBusyError);
    await foreignLock(lock, FILE_LOCK_STALE_MS + 1_000, "{ not json");
    let ran = false;
    await withFileLock(guarded, async () => void (ran = true), { waitMs: 300, retryMs: 10 });
    expect(ran).toBe(true);
    expect(await leftovers()).toEqual([]);
  });

  it("two waiters that both see the same stale lock do not both take it (twenty rounds, both made to look before either acts)", async () => {
    for (let round = 0; round < 20; round++) {
      await foreignLock(fileLockPath(guarded), FILE_LOCK_STALE_MS + 1_000);
      // Both waiters have read the stale lock before either acts on it.
      let looked = 0;
      let open!: () => void;
      const both = new Promise<void>((r) => (open = r));
      const seenStale = async () => {
        if (++looked === 2) open();
        await Promise.race([both, sleep(200)]);
      };
      let active = 0;
      let most = 0;
      const step = async () => {
        active++;
        most = Math.max(most, active);
        await sleep(15);
        active--;
      };
      await Promise.all([withFileLock(guarded, step, { retryMs: 5, seenStale }), withFileLock(guarded, step, { retryMs: 5, seenStale })]);
      expect(looked, `round ${round}`).toBeGreaterThanOrEqual(2);
      expect(most, `round ${round}`).toBe(1);
      expect(await leftovers()).toEqual([]);
    }
  });

  it("R306 c: two waiters that both see the same FUTURE-dated stale lock do not both take it", async () => {
    for (let round = 0; round < 10; round++) {
      await foreignLock(fileLockPath(guarded), -(FILE_LOCK_STALE_MS + 1_000));
      let looked = 0;
      let open!: () => void;
      const both = new Promise<void>((r) => (open = r));
      const seenStale = async () => {
        if (++looked === 2) open();
        await Promise.race([both, sleep(200)]);
      };
      let active = 0;
      let most = 0;
      const step = async () => {
        active++;
        most = Math.max(most, active);
        await sleep(15);
        active--;
      };
      await Promise.all([withFileLock(guarded, step, { retryMs: 5, seenStale }), withFileLock(guarded, step, { retryMs: 5, seenStale })]);
      expect(looked, `round ${round}`).toBeGreaterThanOrEqual(2);
      expect(most, `round ${round}`).toBe(1);
      expect(await leftovers()).toEqual([]);
    }
  });

  it("a take-over left half done by a process that died (its take-over file is old too) is itself taken over", async () => {
    const lock = fileLockPath(guarded);
    const token = "a".repeat(32);
    await foreignLock(lock, FILE_LOCK_STALE_MS + 1_000, JSON.stringify({ token, at: new Date(0).toISOString() }));
    await foreignLock(`${lock}.break-${token}`, FILE_LOCK_STALE_MS + 1_000);
    let ran = false;
    await withFileLock(guarded, async () => void (ran = true), { waitMs: 500, retryMs: 10 });
    expect(ran).toBe(true);
    expect(await leftovers()).toEqual([]);
  });

  it("only the holder releases: a lock that is no longer this holder's (taken over meanwhile) is left as it is", async () => {
    const lock = fileLockPath(guarded);
    const other = JSON.stringify({ token: "b".repeat(32), at: new Date().toISOString() });
    await withFileLock(guarded, async () => {
      await writeFile(lock, other);
    });
    expect(await readFile(lock, "utf8")).toBe(other);
  });
});
