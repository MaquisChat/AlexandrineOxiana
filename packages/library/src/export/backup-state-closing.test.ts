/**
 * FR-749, R555 4 (with R554; R247 c): `Backups/backups-state.json` is never written once its library is closed. Every
 * write of it goes through one writer, which refuses once the library is closed and is counted in the close's wait
 * while it is being made, so nothing under Backups/ changes after `close()` resolved. A caller that meets the refusal
 * treats it as "cannot run now": nothing is recorded. Probed with a retention pass held just before it writes its notes
 * (of the backups still to remove; of the old copies still holding destroyed files), and with a write under way.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { resumeDestruction, retentionSeams } from "../retention.js";
import { KeyRing } from "../crypto/keys.js";
import { openLibrary } from "../library.js";
import { openTestRepo } from "../repo/testing.js";
import { BACKUPS_MANIFEST, BACKUPS_STATE, backupProject, backupSeams, listBackups, setRetentionRetry } from "./backup.js";
import { makeKit, makeProject, walk, type Kit } from "./test-kit.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-backup-state-closing-");
});
afterEach(async () => {
  retentionSeams.beforeNotes = undefined;
  backupSeams.stateWrite = undefined;
  backupSeams.crashAt = undefined;
  await kit.close().catch(() => {});
});

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;

/** Every file under the library with its bytes' digest (folders by name). */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const r of (await walk(root)).sort()) {
    let digest = "dir";
    try {
      digest = createHash("sha256").update(await readFile(join(root, r))).digest("hex");
    } catch {
      // a folder
    }
    out.push(`${r} ${digest}`);
  }
  return out;
}

const statePath = () => join(kit.lib.root, "Backups", BACKUPS_STATE);

/** A gate the test opens; `inside` resolves once the held code reached it. Opened when the test ends, whatever its end. */
function gate(): { wait: () => Promise<void>; inside: Promise<void>; open: () => void } {
  let open!: () => void;
  const g = new Promise<void>((r) => (open = r));
  onTestFinished(() => open());
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  return {
    wait: async () => {
      entered();
      await g;
    },
    inside,
    open,
  };
}

/**
 * A retention pass held just before it writes `which` notes; the library closed there, then the pass released. The
 * folder right after `close()` resolved and after the pass ended must be identical; the pass ends recording nothing.
 */
async function closeBeforeNotes(projectId: string, which: "destruction" | "old-copies") {
  const g = gate();
  retentionSeams.beforeNotes = async (w) => {
    if (w === which) await g.wait();
  };
  const pass = resumeDestruction(kit.repo, projectId).then(
    (ok) => ({ ok }),
    (err: unknown) => ({ err }),
  );
  await g.inside;
  const closing = kit.lib.close();
  g.open();
  await closing;
  const afterClose = await snapshot(kit.lib.root);
  const result = await pass;
  expect(await snapshot(kit.lib.root)).toEqual(afterClose);
  return { result, afterClose };
}

describe("the backups state file once its library is closed (FR-749, R555 4)", () => {
  it("a retention pass held just before it writes the notes of the backups still to remove: closed there, it writes nothing after close() resolved", async () => {
    const p = await makeProject(kit, GOV, false, "Harbour ledgers");
    // A stale note (no destruction of the audit log names it): a pass rewrites the notes from the audit log, dropping it.
    const stale = `${p.folder}/retention/destruction-2026-12-02 1015.json`;
    await writeFile(statePath(), `${JSON.stringify({ formatVersion: 1, pending: {}, failures: {}, owners: {}, retries: {}, undestroyed: { [p.id]: { [stale]: ["Backups/Harbour ledgers - backup - modified 2026-11-10 0930.zip"] } } }, null, 2)}\n`);
    const before = await readFile(statePath(), "utf8");
    const { result } = await closeBeforeNotes(p.id, "destruction");
    expect(result).toEqual({ ok: [] });
    expect(await readFile(statePath(), "utf8")).toBe(before);
  });

  it("a retention pass held just before it writes the notes of the old copies: closed there, it writes nothing after close() resolved", async () => {
    const p = await makeProject(kit, GOV, false, "Salt works");
    const stale = `${p.folder}/retention/destruction-2026-12-02 1015.json`;
    await writeFile(
      statePath(),
      `${JSON.stringify({ formatVersion: 1, pending: {}, failures: {}, owners: {}, retries: {}, oldCopiesUndestroyed: { [p.id]: { [stale]: { copies: [{ id: "a1b2c3", movedAt: "2026-11-01T10:00:00.000Z" }] } } } }, null, 2)}\n`,
    );
    const before = await readFile(statePath(), "utf8");
    const { result } = await closeBeforeNotes(p.id, "old-copies");
    expect(result).toHaveProperty("ok");
    expect(await readFile(statePath(), "utf8")).toBe(before);
  });

  it("a write under way when close() is called finishes before the lock is released", async () => {
    await makeProject(kit, GOV, false, "Nets and boats");
    const g = gate();
    backupSeams.stateWrite = g.wait;
    const log: string[] = [];
    const rec = { firstFailedAt: "2026-11-10T09:30:00.000Z", lastRecordedAt: "2026-11-10T09:30:00.000Z", attemptsSinceRecord: 0 };
    const writing = setRetentionRetry(kit.repo, "probe", rec).then(() => log.push("written"));
    await g.inside;
    const closing = kit.lib.close().then(() => log.push("closed"));
    await new Promise((r) => setImmediate(r));
    expect(log).toEqual([]);
    expect(existsSync(join(kit.lib.root, ".lock"))).toBe(true);
    g.open();
    await Promise.all([writing, closing]);
    expect(log).toEqual(["written", "closed"]);
    expect(existsSync(join(kit.lib.root, ".lock"))).toBe(false);
    expect(JSON.parse(await readFile(statePath(), "utf8")).retries).toEqual({ probe: rec });
    // And once closed, a write is refused: nothing written.
    const after = await readFile(statePath(), "utf8");
    await expect(setRetentionRetry(kit.repo, "later", rec)).rejects.toThrow(/closed/);
    expect(await readFile(statePath(), "utf8")).toBe(after);
  });
});

/**
 * R560 M1 (R247 c, with R555 4 and R558 a): the backups' manifest and the settling of an interrupted backup write nothing
 * under Backups/ once the library is closed — a caller still holding the old repository reads the manifest as it is (or
 * rebuilt in memory only) and leaves the interrupted backup's temporary file for the next opening, which heals both as
 * before.
 */
describe("the manifest and an interrupted backup once the library is closed (FR-749, R560 M1)", () => {
  async function openAgain() {
    const lib = await openLibrary(kit.lib.root, {
      clock: () => kit.clock.now,
      deviceId: "dev-A",
      hostname: "host-A",
      pid: process.pid,
      isPidAlive: () => true,
      appConfigDir: join(kit.tmp, "config"),
      settleMs: 0,
      setInterval: () => ({}),
      clearInterval: () => {},
    });
    onTestFinished(() => lib.close());
    const repo = await openTestRepo(lib, new KeyRing(), { clock: () => kit.clock.now, tz: "UTC", actor: "tester", scryptN: 2 ** 10 });
    return { lib, repo };
  }
  const manifestPath = () => join(kit.lib.root, "Backups", BACKUPS_MANIFEST);

  it("a missing manifest is rebuilt in memory only by a read of the closed library; the next opening writes it", async () => {
    const p = await makeProject(kit, GOV, false, "Ropes");
    const b = await backupProject(kit.repo, p.id);
    await rm(manifestPath());
    await kit.lib.close();
    const afterClose = await snapshot(kit.lib.root);
    const listed = await listBackups(kit.repo, p.id);
    expect(listed.map((x) => x.file)).toEqual([basename(b.path)]);
    expect(await snapshot(kit.lib.root)).toEqual(afterClose);
    expect(existsSync(manifestPath())).toBe(false);

    const again = await openAgain();
    expect((await listBackups(again.repo, p.id)).map((x) => x.file)).toEqual([basename(b.path)]);
    expect(existsSync(manifestPath())).toBe(true);
  });

  it("an interrupted backup's temporary file is left by a read of the closed library; the next opening settles it as before", async () => {
    const p = await makeProject(kit, GOV, false, "Sails");
    backupSeams.crashAt = "after-zip";
    await expect(backupProject(kit.repo, p.id)).rejects.toThrow();
    const pending = Object.values(JSON.parse(await readFile(statePath(), "utf8")).pending as Record<string, { tmp?: string }>);
    expect(pending).toHaveLength(1);
    const tmpFile = join(kit.lib.root, "Backups", pending[0]!.tmp!);
    expect(existsSync(tmpFile)).toBe(true);
    await kit.lib.close();
    const afterClose = await snapshot(kit.lib.root);
    expect(await listBackups(kit.repo, p.id)).toEqual([]);
    expect(await snapshot(kit.lib.root)).toEqual(afterClose);
    expect(existsSync(tmpFile)).toBe(true);

    const again = await openAgain();
    expect(await listBackups(again.repo, p.id)).toEqual([]);
    expect(existsSync(tmpFile)).toBe(false);
    const state = JSON.parse(await readFile(statePath(), "utf8")) as { pending: Record<string, unknown>; failures: Record<string, unknown> };
    expect(state.pending).toEqual({});
    expect(Object.keys(state.failures)).toEqual([p.id]);
  });
});
