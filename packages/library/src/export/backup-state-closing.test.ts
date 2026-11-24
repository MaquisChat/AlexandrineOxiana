/**
 * FR-749, R555 4 (with R554; R247 c): `Backups/backups-state.json` is never written once its library is closed. Every
 * write of it goes through one writer, which refuses once the library is closed and is counted in the close's wait
 * while it is being made, so nothing under Backups/ changes after `close()` resolved. A caller that meets the refusal
 * treats it as "cannot run now": nothing is recorded. Probed with a retention pass held just before it writes its notes
 * (of the backups still to remove; of the old copies still holding destroyed files), and with a write under way.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { resumeDestruction, retentionSeams } from "../retention.js";
import { BACKUPS_STATE, backupSeams, setRetentionRetry } from "./backup.js";
import { makeKit, makeProject, walk, type Kit } from "./test-kit.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-backup-state-closing-");
});
afterEach(async () => {
  retentionSeams.beforeNotes = undefined;
  backupSeams.stateWrite = undefined;
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
