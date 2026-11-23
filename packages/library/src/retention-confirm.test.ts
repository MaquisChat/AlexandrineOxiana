/**
 * FR-420 (Ruling R469 b ii): the retention's look at a destruction's files reads the audit view first and the
 * retention folder after it, so an amendment the app records in between was taken for a file "named like an
 * amendment … the audit log does not record it". Such a file is now reported only if it is still so when looked at
 * in the write queue's turn, the audit view and the folder read together there. The interleaving is made with the
 * NODE_ENV=test seam after the audit view is taken (`retentionSeams.afterScan`); turns are held with the queue's own
 * entry; nothing here sleeps.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PSEUDO_GOV, addSource, makeKit, makeProject, scratchFile, type Kit } from "./export/test-kit.js";
import { ProjectLockedError } from "./repo/errors.js";
import { amendProjectDestruction, writeQueueTurn } from "./repo/repo.js";
import { destroyRaw, listDestructions, retentionSeams } from "./retention.js";

const RETAIN = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
  deidentifiedExportsOnly: true
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
retention:
  rawDataDestroyAfter: 2026-12-01
captureMethods: [manual_upload]
`;
const RETAIN_SEALED = `${PSEUDO_GOV}retention:
  rawDataDestroyAfter: 2026-12-01
`;
const STRAY = /named like an amendment/u;

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-fr420-ret-");
});
afterEach(async () => {
  retentionSeams.afterScan = undefined;
  await kit.close();
});

/** A destruction made at `at`; its certificate's name and recorded sha256. */
async function destruction(p: Project, title: string, at: string): Promise<{ name: string; sha: string }> {
  const f = await scratchFile(kit, "interview.mp3", `RAW interview audio bytes of ${title}`);
  const sf = await addSource(kit, p, { type: "interview", title, identifiable: true, files: [{ path: f, role: "original", handling: "copy" }] });
  kit.clock.now = new Date(at);
  const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
  const name = r.certificatePath.slice(r.certificatePath.lastIndexOf("/") + 1);
  const rec = (await listDestructions(kit.repo, p.id)).find((d) => d.certificateFile.endsWith(`/${name}`))!;
  return { name, sha: rec.certificateSha256! };
}
const amend = (p: Project, d: { name: string; sha: string }, number = 1) =>
  amendProjectDestruction(kit.repo, p.id, { certificate: d.name, certificateSha256: d.sha, number, content: { note: "recorded by the app" }, facts: {} });
const retentionDir = (p: Project) => join(kit.lib.root, kit.repo.getProject(p.id).folder, "retention");
const strayName = (d: { name: string }) => d.name.replace(/\.json(\.enc)?$/u, ".amendment-9.json$1");

/** Holds the write queue with a turn of its own until released. */
function holdQueue() {
  let release!: () => void;
  let holding!: () => void;
  const held = new Promise<void>((r) => (holding = r));
  const done = writeQueueTurn(kit.repo)(async () => {
    holding();
    await new Promise<void>((r) => (release = r));
  });
  return { held, release: () => release(), done };
}

describe("FR-420: a file named like an amendment is reported only if still so in the write queue's turn", () => {
  it("an amendment the app records between the audit view and the folder read is no finding", async () => {
    const p = await makeProject(kit, RETAIN);
    const d = await destruction(p, "One", "2026-12-02T10:00:00.000Z");
    let once = true;
    retentionSeams.afterScan = async () => {
      if (!once) return;
      once = false;
      await amend(p, d); // the whole governed change, after the audit view was taken
    };
    const [rec] = await listDestructions(kit.repo, p.id);
    expect(rec!.problem).toBeUndefined();
    expect(rec!.amendments).toEqual([]); // the view taken before it; the next look shows it
    retentionSeams.afterScan = undefined;
    expect((await listDestructions(kit.repo, p.id))[0]!.amendments).toHaveLength(1);
  });

  it("a real stray and a passing one in one look: only the real one is said; the look waits for a long turn, then answers", async () => {
    const p = await makeProject(kit, RETAIN);
    const real = await destruction(p, "One", "2026-12-02T10:00:00.000Z");
    const passing = await destruction(p, "Two", "2026-12-02T11:00:00.000Z");
    // A file named like an amendment, put there outside the app.
    await writeFile(join(retentionDir(p), strayName(real)), "{}\n");
    let hold: ReturnType<typeof holdQueue> | undefined;
    retentionSeams.afterScan = async () => {
      if (hold) return;
      await amend(p, passing);
      hold = holdQueue();
      await hold.held;
    };
    let settled = false;
    const look = listDestructions(kit.repo, p.id).finally(() => (settled = true));
    while (!hold) await new Promise<void>((r) => setImmediate(r));
    await hold.held;
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false); // waiting for the turn
    hold.release();
    await hold.done;
    const recs = await look;
    const of = (d: { name: string }) => recs.find((r) => r.certificateFile.endsWith(`/${d.name}`))!;
    expect(of(real).problem).toMatch(STRAY);
    expect(of(passing).problem).toBeUndefined();
  });

  it("a lock landing while the look waits for the turn ends it as locked: no hang, no finding", async () => {
    const p = await makeProject(kit, RETAIN_SEALED, true);
    const d = await destruction(p, "Sealed", "2026-12-02T10:00:00.000Z");
    await writeFile(join(retentionDir(p), strayName(d)), "{}\n");
    let hold: ReturnType<typeof holdQueue> | undefined;
    retentionSeams.afterScan = async () => {
      if (hold) return;
      hold = holdQueue();
      await hold.held;
    };
    const look = listDestructions(kit.repo, p.id);
    while (!hold) await new Promise<void>((r) => setImmediate(r));
    await hold.held;
    const lock = kit.repo.lockProject(p.id); // next, ahead of the look's turn (R379)
    hold.release();
    await lock;
    await expect(look).rejects.toBeInstanceOf(ProjectLockedError);
  });
});
