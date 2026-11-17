/**
 * R379 (FR-A13): a change being saved is never sealed under a key that has been wiped. Locking an encrypted project,
 * or unlocking it a second time, while a change is being saved must not zero the key that change seals with: the
 * lock waits its turn in the write queue (after the change in progress, ahead of the changes waiting behind it),
 * adding the same key again keeps the ring's buffer, and sealing with an all-zero key is refused outright.
 */
import { statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { newId, type Project } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptStream } from "../crypto/format.js";
import { PASS, addSource, makeKit, makeProject, walk, type Kit } from "../export/test-kit.js";
import { ProjectLockedError } from "./errors.js";
import { encryptBytes, openLine, sealLine } from "./io.js";
import { importChange, projectDataKey } from "./repo.js";
import { PURPOSE_CHANGES, PURPOSE_WATCH_REGISTER, SEALED_LINE_PURPOSES } from "./sealed-purposes.js";
import { seams } from "./testing.js";
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

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-key-lock-race-");
});
afterEach(async () => {
  seams.failUndo = undefined;
  await kit.close();
});

const folderOf = (p: Project) => join(kit.lib.root, kit.repo.getProject(p.id).folder);
/** A copy of the project's real data key (the ring's buffer is zeroed at lock). */
const realKey = (p: Project) => Buffer.from(projectDataKey(kit.repo, p.id)!.key);

async function sealedLines(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: string[] = [];
  for (const n of names.filter((x) => x.endsWith(".jsonl")).sort()) {
    out.push(...(await readFile(join(dir, n), "utf8")).split("\n").filter((l) => l.trim()));
  }
  return out;
}

/** Every line opens with the real key and none with 32 zero bytes. */
function expectOpensWithRealKey(p: Project, key: Buffer, lines: string[], purpose: string): string[] {
  return lines.map((l) => {
    expect(() => openLine(ZERO, p.id, l, purpose)).toThrow();
    return openLine(key, p.id, l, purpose);
  });
}

/** A change recording a participant's details on a source; `during` runs as the change's function returns. */
function noteChange(p: Project, sourceId: string, note: string, during: () => void): Promise<void> {
  return importChange(
    kit.repo,
    p.id,
    STORE,
    async (ops) => {
      const cur = await ops.readSource(sourceId);
      await ops.writeSource(cur, { ...cur, source: { ...cur.source, caseAttributes: { ...cur.source.caseAttributes, note } } });
      during();
    },
    { op: "test.note" },
  );
}

describe("a lock or a second unlock while a change is being saved (R379)", () => {
  it("a lock on the next macrotask after the change's function returned: the change's lines open with the real key, never with zeros", async () => {
    const p = await makeProject(kit, GOV, true);
    const sf = await addSource(kit, p, { title: "A source" });
    const key = realKey(p);
    const changes = join(folderOf(p), "changes");
    const before = await sealedLines(changes);
    let lock: Promise<void> | undefined;
    const outcome = await noteChange(p, sf.source.id, "Participant Jane Doe, Leeds", () => {
      setImmediate(() => {
        lock = Promise.resolve(kit.repo.lockProject(p.id));
      });
    }).then(
      () => "committed" as const,
      (e: unknown) => e,
    );
    await new Promise((r) => setImmediate(r));
    await lock;
    expect(kit.repo.isUnlocked(p.id)).toBe(false);
    const after = await sealedLines(changes);
    if (outcome === "committed") {
      expect(after.length).toBeGreaterThan(before.length);
      const opened = expectOpensWithRealKey(p, key, after, PURPOSE_CHANGES);
      expect(opened.join("\n")).toContain("Participant Jane Doe, Leeds");
    } else {
      expect(outcome).toBeInstanceOf(ProjectLockedError);
      expect(after).toEqual(before);
    }
    // The change was in progress when the lock was asked: the lock waited for it.
    expect(outcome).toBe("committed");
  });

  it("the same key added again while a change is being saved keeps the ring's buffer: the line opens with the real key", async () => {
    const p = await makeProject(kit, GOV, true);
    const sf = await addSource(kit, p, { title: "A source" });
    const key = realKey(p);
    const keyId = kit.repo.getProject(p.id).encryption.keyId!;
    const held = projectDataKey(kit.repo, p.id)!.key;
    await noteChange(p, sf.source.id, "Participant Jane Doe, Leeds", () => {
      setImmediate(() => kit.ring.add(keyId, key));
    });
    await new Promise((r) => setImmediate(r));
    expect(kit.repo.isUnlocked(p.id)).toBe(true);
    expect(kit.ring.get(keyId)).toBe(held);
    expect(Buffer.from(held).equals(key)).toBe(true);
    const opened = expectOpensWithRealKey(p, key, await sealedLines(join(folderOf(p), "changes")), PURPOSE_CHANGES);
    expect(opened.join("\n")).toContain("Participant Jane Doe, Leeds");
  });

  it("a second unlock while a change is being saved: the line opens with the real key; the project stays unlocked", async () => {
    const p = await makeProject(kit, GOV, true);
    const sf = await addSource(kit, p, { title: "A source" });
    const key = realKey(p);
    let unlock: Promise<void> | undefined;
    await noteChange(p, sf.source.id, "Participant Jane Doe, Leeds", () => {
      unlock = kit.repo.unlockProject(p.id, PASS);
    });
    await unlock;
    expect(kit.repo.isUnlocked(p.id)).toBe(true);
    const opened = expectOpensWithRealKey(p, key, await sealedLines(join(folderOf(p), "changes")), PURPOSE_CHANGES);
    expect(opened.join("\n")).toContain("Participant Jane Doe, Leeds");
  });

  it("a lock waits only for the change in progress: a change waiting behind it is refused as locked, with nothing written", async () => {
    const p = await makeProject(kit, GOV, true);
    const sf = await addSource(kit, p, { title: "A source" });
    const key = realKey(p);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const first = importChange(kit.repo, p.id, STORE, async (ops) => {
      const cur = await ops.readSource(sf.source.id);
      entered();
      await gate;
      await ops.writeSource(cur, { ...cur, source: { ...cur.source, caseAttributes: { note: "first" } } });
    }, { op: "test.note" });
    await inside;
    let secondRan = false;
    const second = importChange(kit.repo, p.id, STORE, async () => {
      secondRan = true;
    }, { op: "test.note" });
    second.catch(() => {});
    const lock = Promise.resolve(kit.repo.lockProject(p.id));
    let locked = false;
    void lock.then(() => (locked = true));
    await new Promise((r) => setTimeout(r, 20));
    // The lock is waiting for the change in progress: the key is still there.
    expect(locked).toBe(false);
    expect(kit.repo.isUnlocked(p.id)).toBe(true);
    const filesBefore = await walk(folderOf(p));
    release();
    await first;
    await lock;
    await expect(second).rejects.toBeInstanceOf(ProjectLockedError);
    expect(secondRan).toBe(false);
    expect(kit.repo.isUnlocked(p.id)).toBe(false);
    const opened = expectOpensWithRealKey(p, key, await sealedLines(join(folderOf(p), "changes")), PURPOSE_CHANGES);
    expect(opened.join("\n")).toContain("first");
    // Only the first change wrote (its change-log line and audit entry); nothing new file-wise from the second.
    expect((await walk(folderOf(p))).filter((f) => !filesBefore.includes(f))).toEqual([]);
  });

  it("the watch register: a lock asked as its write starts waits for it; every line opens with the real key", async () => {
    const p = await makeProject(kit, GOV, true);
    const key = realKey(p);
    const watchId = newId();
    const entries: WatchRegisterEntry[] = Array.from({ length: 30 }, (_, i) => ({
      key: `f-${i}.pdf`,
      file: `f-${i}.pdf`,
      sourceId: newId(),
      sha256: "a".repeat(64),
      size: 10,
      mtimeNs: "1763000000123456789",
      state: "in-library",
      at: "2026-11-10T09:30:00.000Z",
    }));
    const write = kit.repo.recordWatchedFiles(p.id, watchId, entries);
    const lock = new Promise<void>((r) => setImmediate(() => r(kit.repo.lockProject(p.id))));
    await write;
    await lock;
    expect(kit.repo.isUnlocked(p.id)).toBe(false);
    const lines = await sealedLines(join(folderOf(p), "watched"));
    expect(lines).toHaveLength(30);
    expectOpensWithRealKey(p, key, lines, PURPOSE_WATCH_REGISTER);
  });

  it("a key wiped outside the queue (the ring cleared) mid-write: the change fails closed and no line under zeros is left, even when its rollback fails", async () => {
    const p = await makeProject(kit, GOV, true);
    const key = realKey(p);
    const entries: WatchRegisterEntry[] = Array.from({ length: 30 }, (_, i) => ({
      key: `f-${i}.pdf`,
      file: `f-${i}.pdf`,
      sourceId: newId(),
      sha256: "a".repeat(64),
      size: 10,
      mtimeNs: "1763000000123456789",
      state: "in-library",
      at: "2026-11-10T09:30:00.000Z",
    }));
    const watchId = newId();
    await kit.repo.recordWatchedFiles(p.id, watchId, entries.slice(0, 1));
    const file = join(folderOf(p), "watched", `${watchId}.jsonl`);
    const size = statSync(file).size;
    seams.failUndo = "append";
    const write = kit.repo.recordWatchedFiles(p.id, watchId, entries.slice(1));
    // The ring is cleared (as at app exit) once the write has appended its first line.
    const poll = () => (statSync(file).size > size ? kit.ring.clear() : setImmediate(poll));
    setImmediate(poll);
    await expect(write).rejects.toThrow();
    const lines = await sealedLines(join(folderOf(p), "watched"));
    expect(lines.length).toBeGreaterThan(1);
    // Whatever the failed rollback left: sealed under the real key, never under zeros.
    for (const l of lines) {
      expect(() => openLine(ZERO, p.id, l, PURPOSE_WATCH_REGISTER)).toThrow();
      openLine(key, p.id, l, PURPOSE_WATCH_REGISTER);
    }
  });

  it("the lock zeroes the ring's buffer once the change in progress is done (no key outlives the lock)", async () => {
    const p = await makeProject(kit, GOV, true);
    const sf = await addSource(kit, p, { title: "A source" });
    const held = projectDataKey(kit.repo, p.id)!.key;
    let lock: Promise<void> | undefined;
    await noteChange(p, sf.source.id, "x", () => {
      lock = Promise.resolve(kit.repo.lockProject(p.id));
    });
    await lock;
    expect(held.every((b) => b === 0)).toBe(true);
  });

  it("many changes, locks and unlocks interleaved: the audit chain verifies and every sealed line opens with the real key", async () => {
    const p = await makeProject(kit, GOV, true);
    const sf = await addSource(kit, p, { title: "A source" });
    const key = realKey(p);
    const pending: Array<Promise<unknown>> = [];
    for (let i = 0; i < 50; i++) {
      if (!kit.repo.isUnlocked(p.id)) await kit.repo.unlockProject(p.id, PASS);
      const c = noteChange(p, sf.source.id, `note ${i}`, () => {
        if (i % 3 === 0) setImmediate(() => void kit.repo.lockProject(p.id));
      }).catch((e: unknown) => {
        if (!(e instanceof ProjectLockedError)) throw e;
      });
      pending.push(c);
      if (i % 5 === 4) await Promise.all(pending.splice(0));
    }
    await Promise.all(pending);
    await new Promise((r) => setTimeout(r, 10));
    if (!kit.repo.isUnlocked(p.id)) await kit.repo.unlockProject(p.id, PASS);
    expect((await kit.repo.verifyAudit(p.id)).ok).toBe(true);
    const files = (await walk(folderOf(p))).filter((f) => f.endsWith(".jsonl") && !f.startsWith("audit/"));
    let sealed = 0;
    for (const f of files) {
      for (const l of (await readFile(join(folderOf(p), f), "utf8")).split("\n").filter((x) => x.trim())) {
        const env = JSON.parse(l) as { alg?: string };
        if (env.alg !== "aes-256-gcm") continue;
        sealed++;
        const opens = SEALED_LINE_PURPOSES.some((purpose) => {
          try {
            openLine(key, p.id, l, purpose);
            return true;
          } catch {
            return false;
          }
        });
        expect(opens, f).toBe(true);
      }
    }
    expect(sealed).toBeGreaterThan(0);
  });
});

describe("sealing with an all-zero key is refused (R379, the last line of defence)", () => {
  const keyId = "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7";
  it("sealLine throws", () => {
    expect(() => sealLine(ZERO, keyId, "p", "{}")).toThrow();
    expect(() => sealLine(new Uint8Array(32), keyId, "p", "{}")).toThrow();
  });
  it("encryptBytes and encryptStream throw", async () => {
    await expect(async () => encryptBytes(ZERO, keyId, "x")).rejects.toThrow();
    expect(() => encryptStream(ZERO, keyId)).toThrow();
  });
  it("a real key still seals", async () => {
    const k = Buffer.alloc(32, 7);
    expect(openLine(k, "p", sealLine(k, keyId, "p", "{}"))).toBe("{}");
    expect((await encryptBytes(k, keyId, "x")).length).toBeGreaterThan(0);
  });
});
