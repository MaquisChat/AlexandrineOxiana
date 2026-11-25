/**
 * FR-749 (R551 I2; R247 c): a backup in flight when its library is closed. It is CANCELLED: it stops at its next step,
 * removes its own temporary file, records neither a success nor a failure, and the close waits for that before the
 * lock goes — so nothing under Backups/ changes after `close()` resolved, and the next opening shows no `backup-failed`.
 * Its asker reads one sentence. A backup that finishes before the close begins is recorded as before.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import type { LocationEnv } from "../location.js";
import { addSource, makeKit, makeProject, scratchFile, walk, type Kit } from "./test-kit.js";
import { BackupCancelledError, backupFailure, backupIfDue, backupProject, backupSeams, listBackups } from "./backup.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-backup-closing-");
});
afterEach(async () => {
  backupSeams.afterSnapshot = undefined;
  backupSeams.zipChunk = undefined;
  await kit.close().catch(() => {});
});

const onDisk = (): LocationEnv => ({ homeDir: kit.tmp, platform: "linux", mounts: [{ path: "/", removable: false, network: false }] });
const SENTENCE = (name: string) => `The library was closed or went offline before the backup of ${name} was finished, so no backup was made. Back it up again when the library is open.`;

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

/** The state file as written (failures and pending records), or undefined when there is none. */
async function stateFile(): Promise<{ failures: Record<string, unknown>; pending: Record<string, unknown> } | undefined> {
  try {
    return JSON.parse(await readFile(join(kit.lib.root, "Backups", "backups-state.json"), "utf8"));
  } catch {
    return undefined;
  }
}

const temps = async () => (await readdir(join(kit.lib.root, "Backups")).catch(() => [] as string[])).filter((n) => /\.tmp-[0-9a-f]+$/u.test(n));

/** A hold for a seam: `inside` resolves when the seam is reached; `release` lets it go (also when the test ends). */
function hold(): { seam: () => Promise<void>; inside: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  onTestFinished(() => release());
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  let first = true;
  const seam = async () => {
    if (!first) return;
    first = false;
    entered();
    await gate;
  };
  return { seam, inside, release };
}

async function projectWithSources(name: string) {
  const p = await makeProject(kit, undefined, false, name);
  for (let i = 0; i < 3; i++) {
    const f = await scratchFile(kit, `doc-${i}.pdf`, `%PDF-1.7\n${"x".repeat(200_000)}${i}\n%%EOF\n`);
    await addSource(kit, p, { title: `Document ${i}`, files: [{ path: f, role: "original", handling: "copy" }] });
  }
  return p;
}

/** Closes the library while the backup is held at `seam`; returns what the backup and the folder show. */
async function closeDuring(start: () => Promise<unknown>, h: ReturnType<typeof hold>) {
  const root = kit.lib.root;
  const outcome = start().then(
    (r) => ({ ok: r }),
    (err: unknown) => ({ err }),
  );
  await h.inside;
  const closing = kit.lib.close();
  h.release();
  await closing;
  const afterClose = await snapshot(root);
  // Everything settled: the backup's own promise (it ends after its clean-up and its maintenance lock's release).
  const result = await outcome;
  expect(await snapshot(root)).toEqual(afterClose);
  return { result, afterClose };
}

describe("a backup in flight when its library is closed (FR-749, R551 I2)", () => {
  it("the reviewer's probe: held after its snapshot, the close waits; nothing under the library changes after close() resolved; nothing recorded; no temp file", async () => {
    const p = await projectWithSources("Harbour ledgers");
    const before = await stateFile();
    const h = hold();
    backupSeams.afterSnapshot = h.seam;
    const { result } = await closeDuring(() => backupProject(kit.repo, p.id, { locationEnv: onDisk() }), h);
    expect((result as { err: unknown }).err).toBeInstanceOf(BackupCancelledError);
    expect(((result as { err: Error }).err).message).toBe(SENTENCE("Harbour ledgers"));
    expect(await backupFailure(kit.repo, p.id)).toBeUndefined();
    const st = await stateFile();
    expect(st?.failures ?? {}).toEqual(before?.failures ?? {});
    expect(st?.pending ?? {}).toEqual({});
    expect(await temps()).toEqual([]);
    expect((await readdir(join(kit.lib.root, "Backups"))).filter((n) => n.endsWith(".zip"))).toEqual([]);
  });

  it("cut in the middle of its zip: the zip's stream ends, the temp file is removed, nothing recorded", async () => {
    const p = await projectWithSources("Salt works");
    const h = hold();
    let tempWhileHeld: string[] = [];
    backupSeams.zipChunk = async () => {
      if (tempWhileHeld.length === 0) tempWhileHeld = await temps();
      await h.seam();
    };
    const { result } = await closeDuring(() => backupProject(kit.repo, p.id, { locationEnv: onDisk() }), h);
    expect(tempWhileHeld).toHaveLength(1); // the zip had begun: its temp file was there
    expect((result as { err: unknown }).err).toBeInstanceOf(BackupCancelledError);
    expect(await temps()).toEqual([]);
    expect(await backupFailure(kit.repo, p.id)).toBeUndefined();
    expect((await stateFile())?.pending ?? {}).toEqual({});
  });

  it("the scheduler's automatic backup is cut the same way: nothing made, nothing recorded (it could not run now)", async () => {
    const p = await projectWithSources("Nets and boats");
    const h = hold();
    backupSeams.afterSnapshot = h.seam;
    const { result } = await closeDuring(() => backupIfDue(kit.repo, p.id, kit.clock.now, { locationEnv: onDisk() }), h);
    expect(result).toEqual({ ok: null });
    expect(await backupFailure(kit.repo, p.id)).toBeUndefined();
    expect(await temps()).toEqual([]);
  });

  it("the session's closing signal stops it the same way, the library still open", async () => {
    const p = await projectWithSources("Tide tables");
    const h = hold();
    backupSeams.afterSnapshot = h.seam;
    const closing = new AbortController();
    const outcome = backupProject(kit.repo, p.id, { locationEnv: onDisk(), signal: closing.signal }).then(
      () => "made",
      (err: unknown) => err,
    );
    await h.inside;
    closing.abort();
    h.release();
    const err = await outcome;
    expect(err).toBeInstanceOf(BackupCancelledError);
    expect(await backupFailure(kit.repo, p.id)).toBeUndefined();
    expect(await temps()).toEqual([]);
    expect(await listBackups(kit.repo, p.id)).toEqual([]);
    // Still open: a backup made now is made and recorded.
    await backupProject(kit.repo, p.id, { locationEnv: onDisk() });
    expect(await listBackups(kit.repo, p.id)).toHaveLength(1);
  });

  it("a backup that finishes before the close begins is recorded as before", async () => {
    const p = await projectWithSources("Ledger of 1932");
    const r = await backupProject(kit.repo, p.id, { locationEnv: onDisk() });
    await kit.lib.close();
    expect(await listBackups(kit.repo, p.id)).toEqual([expect.objectContaining({ file: r.path.split("/").at(-1) })]);
    expect(await backupFailure(kit.repo, p.id)).toBeUndefined();
    expect(await temps()).toEqual([]);
  });
});
