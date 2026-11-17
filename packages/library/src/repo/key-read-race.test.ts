/**
 * R386 (FR-A13, round 2).
 * (a) A read made outside the write queue that a lock cuts short is refused as locked: a line opened with a wiped
 *     (all-zero) key is never "another project's line" nor "damaged"; nothing read under a wiped key is cached or
 *     written back; the watched-folders register's and the Find queue's caches are purged at lock.
 * (b) Locking is immediate for everyone but the change in progress: from the moment a lock is asked the project
 *     counts as locked for every read and every new change; the turn already running still has the key, which is
 *     wiped when that turn ends.
 * (c) The repeated unlock through the queue; lockProject rejects (never throws) for an unknown project.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { newId, type Project } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecryptionError, KeyNotAvailableError, decryptStream } from "../crypto/format.js";
import { openDecrypted } from "../crypto/random-access.js";
import { exportProjectOpenFormats } from "../export/project-export.js";
import { PASS, addSource, makeKit, makeProject, scratchFile, type Kit } from "../export/test-kit.js";
import type { FindEntry } from "../find/types.js";
import { parseJobJournal } from "../job-journal.js";
import { NotFoundError, ProjectLockedError } from "./errors.js";
import { decryptBytes, encryptBytes, openLine, sealLine } from "./io.js";
import { appendFindEntriesIn, importChange, projectDataKey, readFindQueueIn } from "./repo.js";
import { PURPOSE_CHANGES } from "./sealed-purposes.js";
import type { WatchRegisterEntry } from "./watch-register.js";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload, refman_import, downloader]
processing:
  metadata_lookup: []
`;
const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };
const ZERO = Buffer.alloc(32);
const KEY_ID = "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-key-read-race-");
});
afterEach(async () => {
  await kit.close();
});

const folderOf = (p: Project) => join(kit.lib.root, kit.repo.getProject(p.id).folder);
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const regEntry = (i: number): WatchRegisterEntry => ({
  key: `f-${i}.pdf`,
  file: `f-${i}.pdf`,
  sourceId: newId(),
  sha256: "a".repeat(64),
  size: 10,
  mtimeNs: "1763000000123456789",
  state: "in-library",
  at: "2026-11-10T09:30:00.000Z",
});
const findEntry = (p: Project): FindEntry => ({
  id: newId(),
  projectId: p.id,
  typed: "Quillfeather, Zorblatt Grammar",
  state: "looking-up",
  createdAt: "2026-11-10T09:30:00.000Z",
  updatedAt: "2026-11-10T09:30:00.000Z",
  attempts: 0,
});
async function collect(r: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of r) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

describe("(a) the opening primitives refuse a wiped key as locked (R386 a)", () => {
  it("openLine, decryptStream, decryptBytes and openDecrypted: KeyNotAvailableError, never a failed authentication", async () => {
    const k = Buffer.alloc(32, 9);
    const line = sealLine(k, KEY_ID, "p", "{}");
    expect(() => openLine(ZERO, "p", line)).toThrow(KeyNotAvailableError);
    const enc = await encryptBytes(k, KEY_ID, "hello");
    await expect(decryptBytes(() => ZERO, enc)).rejects.toBeInstanceOf(KeyNotAvailableError);
    await expect(collect(Readable.from([enc]).pipe(decryptStream(() => ZERO)))).rejects.toBeInstanceOf(KeyNotAvailableError);
    const file = await scratchFile(kit, "x.enc", enc);
    await expect(openDecrypted(file, () => ZERO)).rejects.toBeInstanceOf(KeyNotAvailableError);
    // A wrong (but live) key is still a failed authentication.
    await expect(decryptBytes(() => Buffer.alloc(32, 1), enc)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("the job journal: a line under a wiped key is not 'unreadable', the parse refuses as locked", () => {
    const k = Buffer.alloc(32, 9);
    const line = sealLine(k, KEY_ID, "p", JSON.stringify({ id: "x" }), "ao-jobs");
    expect(() => parseJobJournal(`${line}\n`, "p", ZERO)).toThrow(KeyNotAvailableError);
  });
});

describe("(a) a read cut short by a lock (R386 a)", () => {
  for (const n of [0, 1, 5, 39]) {
    it(`the watched-folders register, lock after ${n} ticks: the read rejects as locked; after the unlock all entries are read`, async () => {
      const p = await makeProject(kit, GOV, true);
      const watchId = newId();
      await kit.repo.recordWatchedFiles(p.id, watchId, Array.from({ length: 400 }, (_, i) => regEntry(i)));
      // A fresh repository: nothing is cached.
      await kit.reopen();
      await kit.repo.unlockProject(p.id, PASS);
      const read = kit.repo.watchRegister(p.id, watchId).then(
        (m) => m.size,
        (e: unknown) => e,
      );
      await ticks(n);
      await kit.repo.lockProject(p.id);
      const got = await read;
      if (typeof got === "number") expect(got).toBe(400);
      else expect(got).toBeInstanceOf(ProjectLockedError);
      await kit.repo.unlockProject(p.id, PASS);
      expect((await kit.repo.watchRegister(p.id, watchId)).size).toBe(400);
    });

    it(`the Find queue, lock after ${n} ticks: the read rejects as locked; after the unlock all entries are read`, async () => {
      const p = await makeProject(kit, GOV, true);
      await appendFindEntriesIn(kit.repo, p.id, Array.from({ length: 300 }, () => findEntry(p)), "add");
      await kit.reopen();
      await kit.repo.unlockProject(p.id, PASS);
      const read = readFindQueueIn(kit.repo, p.id).then(
        (m) => m.size,
        (e: unknown) => e,
      );
      await ticks(n);
      await kit.repo.lockProject(p.id);
      const got = await read;
      if (typeof got === "number") expect(got).toBe(300);
      else expect(got).toBeInstanceOf(ProjectLockedError);
      await kit.repo.unlockProject(p.id, PASS);
      expect((await readFindQueueIn(kit.repo, p.id)).size).toBe(300);
    });
  }

  it("an export interrupted by a lock answers 'locked', never 'damaged'", async () => {
    const p = await makeProject(kit, GOV, true);
    for (let i = 0; i < 6; i++) {
      const f = await scratchFile(kit, `doc-${i}.pdf`, Buffer.alloc(300_000 + i, 7));
      await addSource(kit, p, { title: `S${i}`, files: [{ path: f, role: "original", handling: "copy" }] });
    }
    for (const n of [0, 1, 3, 8, 20]) {
      const out = await scratchFile(kit, `out-${n}/.keep`, "");
      const run = exportProjectOpenFormats(kit.repo, p.id, join(out, "..", "export")).then(
        () => "done",
        (e: unknown) => e,
      );
      await ticks(n);
      await kit.repo.lockProject(p.id);
      const got = await run;
      if (got !== "done") expect(got instanceof KeyNotAvailableError || got instanceof ProjectLockedError, String(got)).toBe(true);
      await kit.repo.unlockProject(p.id, PASS);
    }
  });

  it("the caches are purged at lock: no decrypted register or queue stays behind it", async () => {
    const p = await makeProject(kit, GOV, true);
    const watchId = newId();
    await kit.repo.recordWatchedFiles(p.id, watchId, [regEntry(1)]);
    await appendFindEntriesIn(kit.repo, p.id, [findEntry(p)], "add");
    await kit.repo.watchRegister(p.id, watchId);
    await readFindQueueIn(kit.repo, p.id);
    const { watchCacheSize } = await import("./watch-register.js");
    const { findCacheSize } = await import("../find/queue-store.js");
    expect(watchCacheSize(kit.repo)).toBeGreaterThan(0);
    expect(findCacheSize(kit.repo)).toBeGreaterThan(0);
    await kit.repo.lockProject(p.id);
    expect(watchCacheSize(kit.repo)).toBe(0);
    expect(findCacheSize(kit.repo)).toBe(0);
  });
});

describe("(b) locking is immediate for everyone but the change in progress (R386 b)", () => {
  function held(p: Project, sourceId: string, note: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const done = importChange(
      kit.repo,
      p.id,
      STORE,
      async (ops) => {
        const cur = await ops.readSource(sourceId);
        entered();
        await gate;
        await ops.writeSource(cur, { ...cur, source: { ...cur.source, caseAttributes: { note } } });
      },
      { op: "test.note" },
    );
    return { done, inside, release };
  }
  const changeLines = async (p: Project) => {
    const dir = join(folderOf(p), "changes");
    const out: string[] = [];
    for (const f of await readdir(dir)) out.push(...(await readFile(join(dir, f), "utf8")).split("\n").filter((l) => l.trim()));
    return out;
  };

  it("the probe: a read 300 ms after the lock is refused while the change is held; the held change completes with the real key; a new change is refused", async () => {
    const p = await makeProject(kit, GOV, true);
    const sf = await addSource(kit, p, { title: "Secret title Jane Doe" });
    const key = Buffer.from(projectDataKey(kit.repo, p.id)!.key);
    const h = held(p, sf.source.id, "Participant Jane Doe, Leeds");
    await h.inside;
    let wiped = false;
    const lock = kit.repo.lockProject(p.id).then(() => (wiped = true));
    expect(kit.repo.isUnlocked(p.id)).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(wiped).toBe(false);
    await expect(kit.repo.getSource(p.id, sf.source.id)).rejects.toBeInstanceOf(ProjectLockedError);
    expect(() => projectDataKey(kit.repo, p.id)).toThrow(ProjectLockedError);
    const later = importChange(kit.repo, p.id, STORE, async () => {}, { op: "test.later" });
    later.catch(() => {});
    h.release();
    await h.done;
    await lock;
    await expect(later).rejects.toBeInstanceOf(ProjectLockedError);
    const opened = (await changeLines(p)).map((l) => {
      expect(() => openLine(ZERO, p.id, l, PURPOSE_CHANGES)).toThrow();
      return openLine(key, p.id, l, PURPOSE_CHANGES);
    });
    expect(opened.join("\n")).toContain("Participant Jane Doe, Leeds");
  });

  it("a stuck change: reads stay refused for as long as it is held", async () => {
    const p = await makeProject(kit, GOV, true);
    const sf = await addSource(kit, p, { title: "T" });
    const h = held(p, sf.source.id, "x");
    await h.inside;
    const lock = kit.repo.lockProject(p.id);
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 50));
      await expect(kit.repo.getSource(p.id, sf.source.id)).rejects.toBeInstanceOf(ProjectLockedError);
      expect(kit.repo.isUnlocked(p.id)).toBe(false);
    }
    h.release();
    await h.done;
    await lock;
  });

  it("a timer started inside the held change still gets the key until the change ends; a read from outside does not", async () => {
    const p = await makeProject(kit, GOV, true);
    let timerSaw: boolean | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const done = importChange(kit.repo, p.id, STORE, async () => {
      setTimeout(() => (timerSaw = kit.repo.isUnlocked(p.id)), 100);
      entered();
      await gate;
      expect(projectDataKey(kit.repo, p.id)!.key.some((b) => b !== 0)).toBe(true);
    }, { op: "test.timer" });
    await inside;
    const lock = kit.repo.lockProject(p.id);
    expect(kit.repo.isUnlocked(p.id)).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(timerSaw).toBe(true);
    release();
    await done;
    await lock;
    expect(kit.repo.isUnlocked(p.id)).toBe(false);
  });

  it("lock, then unlock, asked back to back while a change is held: unlocked with the same key, every line readable", async () => {
    const p = await makeProject(kit, GOV, true);
    const sf = await addSource(kit, p, { title: "T" });
    const key = Buffer.from(projectDataKey(kit.repo, p.id)!.key);
    const h = held(p, sf.source.id, "back to back");
    await h.inside;
    const lock = kit.repo.lockProject(p.id);
    const unlock = kit.repo.unlockProject(p.id, PASS);
    h.release();
    await h.done;
    await lock;
    await unlock;
    expect(kit.repo.isUnlocked(p.id)).toBe(true);
    expect(Buffer.from(projectDataKey(kit.repo, p.id)!.key).equals(key)).toBe(true);
    const opened = (await changeLines(p)).map((l) => openLine(key, p.id, l, PURPOSE_CHANGES));
    expect(opened.join("\n")).toContain("back to back");
    expect((await kit.repo.getSource(p.id, sf.source.id)).source.id).toBe(sf.source.id);
  });
});

describe("(c) the repeat unlock and an unknown project (R386 c)", () => {
  it("a different key under the same key id, added by an unlock while a change is being saved, never zeroes the key that change seals with", async () => {
    const p = await makeProject(kit, GOV, true);
    const sf = await addSource(kit, p, { title: "T" });
    const key = Buffer.from(projectDataKey(kit.repo, p.id)!.key);
    const keyId = kit.repo.getProject(p.id).encryption.keyId!;
    // The key file now wraps another key under the same id (a replaced key file).
    const { wrapKey, generateDataKey } = await import("../crypto/keys.js");
    const other = generateDataKey();
    const kf = join(folderOf(p), "keys", "project-key.json");
    const file = JSON.parse(await readFile(kf, "utf8")) as { passphrase: unknown };
    file.passphrase = await wrapKey(other, PASS, keyId, { N: 2 ** 10 });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(kf, JSON.stringify(file));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const done = importChange(kit.repo, p.id, STORE, async (ops) => {
      const cur = await ops.readSource(sf.source.id);
      entered();
      await gate;
      await ops.writeSource(cur, { ...cur, source: { ...cur.source, caseAttributes: { note: "kept" } } });
    }, { op: "test.note" });
    await inside;
    const unlock = kit.repo.unlockProject(p.id, PASS);
    await new Promise((r) => setTimeout(r, 200)); // the unwrap is done; the add waits its turn
    release();
    await done;
    await unlock;
    const lines = (await readdir(join(folderOf(p), "changes"))).length;
    expect(lines).toBeGreaterThan(0);
    const dir = join(folderOf(p), "changes");
    for (const f of await readdir(dir)) {
      for (const l of (await readFile(join(dir, f), "utf8")).split("\n").filter((x) => x.trim())) openLine(key, p.id, l, PURPOSE_CHANGES);
    }
  });

  it("lockProject rejects (never throws) for an unknown project", async () => {
    let p: Promise<void> | undefined;
    expect(() => (p = kit.repo.lockProject(newId()))).not.toThrow();
    await expect(p).rejects.toBeInstanceOf(NotFoundError);
  });
});
