/**
 * R147 (Task 49 round 4): which backups must be removed after a destruction is decided once, at the
 * destruction, and recorded in the hash-chained audit log; the retry acts on that record alone. An
 * entry leaves the list only when its file is verifiably gone (removed by the app, or found
 * missing and recorded as no longer present). The certificate written at the destruction is never
 * rewritten: later facts are amendment files beside it, each with its sha256 in the audit log.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sealEvent, verifyChain, type AuditEvent, type Project, type SourceFile } from "@ao/core";
import type { LocationEnv } from "../location.js";
import { shredSeams } from "../fs/shred.js";
import { newAttentionId, writeAttention, type UnrecordedAudit } from "../repo/attention.js";
import { projectWarnings } from "../repo/repo.js";
import { SimulatedCrash, seams } from "../repo/testing.js";
import { destroyRaw, listDestructions, readDestruction, resumeDestruction } from "../retention.js";
import { backupProject, backupSeams, holdingNotRemoved, type BackupResult } from "./backup.js";
import { addSource, auditEvents, makeKit, makeProject, plainOf, scratchFile, type Kit } from "./test-kit.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-retention-r147-");
});
afterEach(async () => {
  shredSeams.failFor = undefined;
  backupSeams.crashAt = undefined;
  backupSeams.failBackup = false;
  seams.crashAt = undefined;
  seams.failAuditAppendFor = undefined;
  await kit.close();
});

const HOUR = 3_600_000;
const WARNING = "destruction-backups-pending";
const backupsDir = () => join(kit.lib.root, "Backups");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const nameOf = (x: { path: string }) => x.path.slice(x.path.lastIndexOf("/") + 1);
const rel = (x: { path: string }) => `Backups/${nameOf(x)}`;
const later = (ms: number) => {
  kit.clock.now = new Date(kit.clock.now.getTime() + ms);
};
/** The library on this computer's own disk, certainly. */
const onDisk = (): LocationEnv => ({ homeDir: kit.tmp, platform: "linux", mounts: [{ path: "/", removable: false, network: false }] });

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

async function rawSource(p: Project, title = "Interview one"): Promise<SourceFile> {
  const f = await scratchFile(kit, "interview.mp3", `RAW interview audio bytes of ${title}`);
  return addSource(kit, p, { type: "interview", title, identifiable: true, files: [{ path: f, role: "original", handling: "copy" }] });
}

type Details = Record<string, unknown> & {
  op?: string;
  certificate?: string;
  certificateSha256?: string;
  amendment?: string;
  amendmentSha256?: string;
  removed?: string[];
  noLongerPresent?: string[];
  notHolding?: string[];
  notRemoved?: string[];
  status?: string;
  problem?: string;
  summary?: boolean;
};
const detailsOf = (e: AuditEvent) => (e.details ?? {}) as Details;
/** The governed changes that amended a destruction's record (each carries the amendment's sha256). */
const amendmentEvents = async (p: Project) => (await auditEvents(kit, p)).filter((e) => e.action === "delete" && detailsOf(e).op === "retention.backups");
const reports = async (p: Project) => (await auditEvents(kit, p)).filter((e) => e.action === "retention.backups");
/** Every event that says the backups step is finished. */
const completions = async (p: Project) =>
  (await auditEvents(kit, p)).filter((e) => (e.action === "retention.backups" || detailsOf(e).op === "retention.backups") && ["deleted", "no-longer-present"].includes(String(detailsOf(e).status)));

/** How many times the audit log records a backup as removed by the app, and as no longer present. */
async function recordedAs(p: Project, file: string): Promise<{ removed: number; gone: number }> {
  const ev = await amendmentEvents(p);
  return { removed: ev.filter((e) => detailsOf(e).removed?.includes(file)).length, gone: ev.filter((e) => detailsOf(e).noLongerPresent?.includes(file)).length };
}

interface Stuck {
  p: Project;
  sf: SourceFile;
  x: BackupResult;
  certificatePath: string;
}

/** A destruction (2026-12-02 10:00) whose one holding backup X could not be removed. */
async function stuck(name = "Stuck"): Promise<Stuck> {
  const p = await makeProject(kit, RETAIN, false, name);
  const sf = await rawSource(p);
  const x = await backupProject(kit.repo, p.id);
  kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
  shredSeams.failFor = (path) => path.endsWith(nameOf(x));
  const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
  shredSeams.failFor = undefined;
  return { p, sf, x, certificatePath: r.certificatePath };
}

/** Edits every JSON file in the project's retention folder (the certificate and anything kept beside it). */
async function editRetentionFiles(p: Project, edit: (json: Record<string, any>, name: string) => void): Promise<void> {
  const dir = join(kit.lib.root, kit.repo.getProject(p.id).folder, "retention");
  for (const n of await readdir(dir)) {
    const json = JSON.parse(await readFile(join(dir, n), "utf8")) as Record<string, any>;
    edit(json, n);
    await writeFile(join(dir, n), `${JSON.stringify(json, null, 2)}\n`);
  }
}

describe("P3 (R3-C1): the list of backups to remove is decided once, at the destruction", () => {
  it("the source is deleted after a destruction left a backup in place: the backup stays outstanding, the step pending and the warning raised until it is really removed", async () => {
    const { p, sf, x, certificatePath } = await stuck();
    expect((await readDestruction(kit.repo, p.id, certificatePath)).status).toBe("pending");
    await kit.repo.deleteSource(p.id, sf.source.id);

    // The retry runs; the removal still fails.
    later(HOUR);
    shredSeams.failFor = (path) => path.endsWith(nameOf(x));
    await resumeDestruction(kit.repo, p.id);
    shredSeams.failFor = undefined;
    expect(existsSync(x.path)).toBe(true);
    let rec = await readDestruction(kit.repo, p.id, certificatePath);
    expect(rec.status).toBe("pending");
    expect(rec.outstanding).toEqual([rel(x)]);
    expect(await holdingNotRemoved(kit.repo, p.id)).toEqual([rel(x)]);
    expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
    expect(await completions(p)).toEqual([]);

    // The removal works at last: removed, recorded with its time, and only then is the warning cleared.
    later(HOUR);
    const at = kit.clock.now.toISOString();
    await resumeDestruction(kit.repo, p.id);
    expect(existsSync(x.path)).toBe(false);
    rec = await readDestruction(kit.repo, p.id, certificatePath);
    expect(rec.status).toBe("deleted");
    expect(rec.outstanding).toEqual([]);
    const bk = rec.certificate!.backups as { deleted: string[]; removedAt: Record<string, string> };
    expect(bk.deleted).toEqual([rel(x)]);
    expect(bk.removedAt).toEqual({ [rel(x)]: at });
    const last = (await amendmentEvents(p)).at(-1)!;
    expect(last.at).toBe(at);
    expect(detailsOf(last)).toMatchObject({ removed: [rel(x)], noLongerPresent: [], notRemoved: [], status: "deleted" });
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
    expect(await holdingNotRemoved(kit.repo, p.id)).toEqual([]);
    expect(verifyChain(await auditEvents(kit, p)).ok).toBe(true);
  });

  it("the destruction's own audit event names the backups to remove, and the certificate by name and sha256", async () => {
    const { p, x, certificatePath } = await stuck();
    const commit = (await auditEvents(kit, p)).find((e) => e.action === "delete" && detailsOf(e).op === "retention.destroy")!;
    expect(detailsOf(commit)).toMatchObject({
      certificate: certificatePath.slice(certificatePath.lastIndexOf("/") + 1),
      certificateSha256: sha(await readFile(certificatePath)),
      backupsToRemove: [rel(x)],
      backupsUnreadable: [],
    });
  });
});

describe("the certificate and backups-state.json are conveniences; the audit log is the authority", () => {
  /** A stuck backup holding a destroyed and a live file, and a later backup holding only live data. */
  async function forged(): Promise<Stuck & { liveOnly: BackupResult; live: SourceFile }> {
    const p = await makeProject(kit, RETAIN, false, "Forged");
    const sf = await rawSource(p, "to be destroyed");
    const live = await rawSource(p, "kept");
    const x = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
    shredSeams.failFor = (path) => path.endsWith(nameOf(x));
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    shredSeams.failFor = undefined;
    kit.clock.now = new Date("2026-12-02T10:30:00.000Z");
    const liveOnly = await backupProject(kit.repo, p.id, { prune: false });
    return { p, sf, x, certificatePath: r.certificatePath, liveOnly, live };
  }
  const without = (list: unknown, file: string) => (Array.isArray(list) ? list.filter((e) => (typeof e === "string" ? e : (e as { file?: string }).file) !== file) : list);

  const edits: Array<[string, (f: Awaited<ReturnType<typeof forged>>) => (json: Record<string, any>) => void]> = [
    [
      "its assets emptied",
      () => (json) => {
        if (Array.isArray(json.assets)) json.assets = [];
      },
    ],
    [
      "a backup that holds only live data added to the not-removed list",
      (f) => (json) => {
        const b = json.backups as Record<string, any> | undefined;
        if (!b) return;
        for (const k of ["containing", "outstanding"]) if (Array.isArray(b[k])) b[k].push(rel(f.liveOnly));
        if (Array.isArray(b.notRemoved)) b.notRemoved.push({ file: rel(f.liveOnly), reason: "It could not be overwritten and removed (forged).", at: "2026-12-02T10:00:00.000Z" });
      },
    ],
    [
      "the stuck backup dropped from the list",
      (f) => (json) => {
        const b = json.backups as Record<string, any> | undefined;
        if (!b) return;
        for (const k of ["containing", "outstanding", "notRemoved"]) b[k] = without(b[k], rel(f.x));
        if (typeof b.status === "string") b.status = "deleted";
      },
    ],
  ];

  for (const [what, edit] of edits) {
    it(`a certificate edited on disk (${what}): nothing outside the audited list is deleted, the stuck backup stays outstanding, the warning stands and the disagreement is reported`, async () => {
      const f = await forged();
      await editRetentionFiles(f.p, edit(f));
      // The removal would work now.
      kit.clock.now = new Date("2026-12-02T11:30:00.000Z");
      await resumeDestruction(kit.repo, f.p.id);
      // Nothing was deleted for this destruction: not the backup of live data, not the stuck one.
      expect(existsSync(f.liveOnly.path)).toBe(true);
      expect(existsSync(f.x.path)).toBe(true);
      const stored = await kit.repo.getSource(f.p.id, f.live.source.id);
      expect(existsSync(join(kit.lib.root, ...stored.assets[0]!.path.split("/")))).toBe(true);
      expect(await holdingNotRemoved(kit.repo, f.p.id)).toEqual([rel(f.x)]);
      expect(await projectWarnings(kit.repo, f.p.id)).toContain(WARNING);
      const rec = await readDestruction(kit.repo, f.p.id, f.certificatePath);
      expect(rec.status).toBe("pending");
      expect(rec.outstanding).toEqual([rel(f.x)]);
      expect(rec.verified && rec.amendments.every((a) => a.verified)).toBe(false);
      expect(rec.problem).toMatch(/audit log/u);
      expect(rec.problem).not.toContain(kit.lib.root);
      expect(await completions(f.p)).toEqual([]);
      // Said once in the audit log, in plain words; later passes do not repeat it.
      for (let i = 0; i < 3; i++) {
        later(HOUR);
        await resumeDestruction(kit.repo, f.p.id);
      }
      const said = (await reports(f.p)).filter((e) => typeof detailsOf(e).problem === "string");
      expect(said).toHaveLength(1);
      expect(detailsOf(said[0]!).problem).toBe(rec.problem);
      expect(detailsOf(said[0]!)).toMatchObject({ status: "pending", removed: [], notRemoved: [rel(f.x)] });
      expect(existsSync(f.x.path)).toBe(true);
      expect(existsSync(f.liveOnly.path)).toBe(true);
    });
  }

  it("a certificate that was removed: the retry deletes nothing for it, keeps the warning and says why", async () => {
    const { p, x, certificatePath } = await stuck();
    await rm(certificatePath);
    later(HOUR);
    await resumeDestruction(kit.repo, p.id);
    expect(existsSync(x.path)).toBe(true);
    expect(await holdingNotRemoved(kit.repo, p.id)).toEqual([rel(x)]);
    expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
    const [rec] = await listDestructions(kit.repo, p.id);
    expect(rec).toMatchObject({ status: "pending", outstanding: [rel(x)], verified: false });
    expect(rec!.problem).toMatch(/missing/u);
  });

  it("an amendment removed, or a file put beside the certificate under an amendment's name: the same (nothing deleted, the warning stands, the reason given)", async () => {
    for (const tamper of ["remove", "add"] as const) {
      const { p, x, certificatePath } = await stuck(`Beside ${tamper}`);
      const rec0 = await readDestruction(kit.repo, p.id, certificatePath);
      const first = join(kit.lib.root, ...rec0.amendments[0]!.file.split("/"));
      if (tamper === "remove") await rm(first);
      else await writeFile(first.replace(".amendment-1.", ".amendment-2."), await readFile(first));
      later(HOUR);
      await resumeDestruction(kit.repo, p.id);
      expect(existsSync(x.path)).toBe(true);
      expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
      const rec = await readDestruction(kit.repo, p.id, certificatePath);
      expect(rec).toMatchObject({ status: "pending", outstanding: [rel(x)] });
      expect(rec.problem).toMatch(tamper === "remove" ? /amendment .* is missing.*audit log/u : /named like an amendment.*audit log does not record it/u);
      // The file the app did not write is left alone, and no amendment is written over it.
      if (tamper === "add") expect(await readFile(first.replace(".amendment-1.", ".amendment-2."))).toEqual(await readFile(first));
    }
  });

  it("while a certificate disagrees with the audit log, a listed backup removed by hand is still recorded as gone, and the warning then clears", async () => {
    const { p, x, certificatePath } = await stuck();
    await editRetentionFiles(p, (json) => {
      if (Array.isArray(json.assets)) json.assets = [];
    });
    later(HOUR);
    await resumeDestruction(kit.repo, p.id);
    expect(existsSync(x.path)).toBe(true);
    expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
    await rm(x.path);
    later(HOUR);
    await resumeDestruction(kit.repo, p.id);
    const rec = await readDestruction(kit.repo, p.id, certificatePath);
    expect(rec).toMatchObject({ status: "no-longer-present", outstanding: [], verified: false });
    expect(detailsOf((await amendmentEvents(p)).at(-1)!)).toMatchObject({ removed: [], noLongerPresent: [rel(x)] });
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
  });

  it("a certificate the audit log does not record (an earlier version's, or not the app's) is never acted on: its backups stay, the warning says so while they are there", async () => {
    const p = await makeProject(kit, RETAIN, false, "Unrecorded");
    await rawSource(p);
    const x = await backupProject(kit.repo, p.id);
    const dir = join(kit.lib.root, kit.repo.getProject(p.id).folder, "retention");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    const name = "destruction-2026-11-30 0900.json";
    await writeFile(join(dir, name), JSON.stringify({ formatVersion: 1, kind: "destruction-certificate", projectId: p.id, assets: [], backups: { status: "pending", containing: [rel(x)], deleted: [] } }));
    kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
    const before = (await auditEvents(kit, p)).length;
    expect(await resumeDestruction(kit.repo, p.id)).toEqual([]);
    expect(existsSync(x.path)).toBe(true);
    expect(await holdingNotRemoved(kit.repo, p.id)).toEqual([rel(x)]);
    expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
    const [rec] = await listDestructions(kit.repo, p.id);
    expect(rec).toMatchObject({ verified: false, status: "pending", outstanding: [rel(x)], amendments: [] });
    expect(rec!.problem).toMatch(/audit log does not record/u);
    expect((await auditEvents(kit, p)).length).toBe(before);
    // Removed by hand: nothing is left to warn about.
    await rm(x.path);
    later(HOUR);
    await resumeDestruction(kit.repo, p.id);
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
  });

  it("an audit log whose chain no longer verifies: nothing is deleted on its word, the reason is given once, and the log is not read in full at every pass", async () => {
    const { p, x, certificatePath } = await stuck();
    // An early entry is changed on disk (the last entry, and so the head, is untouched).
    const dir = join(kit.lib.root, kit.repo.getProject(p.id).folder, "audit");
    const segment = join(dir, (await readdir(dir)).sort()[0]!);
    const lines = (await readFile(segment, "utf8")).split("\n");
    const firstEvent = JSON.parse(lines[0]!) as { actor: string };
    firstEvent.actor = "someone else";
    lines[0] = JSON.stringify(firstEvent);
    await writeFile(segment, lines.join("\n"));
    for (let i = 0; i < 3; i++) {
      later(HOUR / 2);
      await resumeDestruction(kit.repo, p.id);
      expect(existsSync(x.path)).toBe(true);
      expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
    }
    const said = (await reports(p)).filter((e) => typeof detailsOf(e).problem === "string");
    expect(said).toHaveLength(1);
    expect(detailsOf(said[0]!).problem).toMatch(/audit log .* does not hold together/u);
    expect((await readDestruction(kit.repo, p.id, certificatePath)).outstanding).toEqual([rel(x)]);
    // Removed by hand: recorded as gone (never as removed by the app), and the warning ends.
    await rm(x.path);
    later(HOUR / 2);
    await resumeDestruction(kit.repo, p.id);
    expect(await recordedAs(p, rel(x))).toEqual({ removed: 0, gone: 1 });
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
  });

  it("backups-state.json deleted: the retry still knows what is outstanding from the audit log, and writes nothing more to it for a retry that changes nothing", async () => {
    const { p, x, certificatePath } = await stuck();
    later(HOUR);
    shredSeams.failFor = (path) => path.endsWith(nameOf(x));
    await resumeDestruction(kit.repo, p.id);
    const before = (await auditEvents(kit, p)).length;
    await rm(join(backupsDir(), "backups-state.json"));
    later(HOUR);
    await resumeDestruction(kit.repo, p.id);
    shredSeams.failFor = undefined;
    expect(existsSync(x.path)).toBe(true);
    expect(await holdingNotRemoved(kit.repo, p.id)).toEqual([rel(x)]);
    expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
    expect((await readDestruction(kit.repo, p.id, certificatePath)).outstanding).toEqual([rel(x)]);
    // The failure is already on record in the audit log: losing the bookkeeping adds no event.
    expect((await auditEvents(kit, p)).slice(before).map((e) => e.action)).toEqual([]);
    // And the removal still happens once it can.
    later(HOUR);
    await resumeDestruction(kit.repo, p.id);
    expect(existsSync(x.path)).toBe(false);
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
  });

  it("backups-state.json edited to name another backup: nothing extra is deleted, the disagreement is reported, and the note is corrected from the audit log", async () => {
    const { p, x, certificatePath } = await stuck();
    kit.clock.now = new Date("2026-12-02T10:30:00.000Z");
    const liveOnly = await backupProject(kit.repo, p.id, { prune: false });
    const statePath = join(backupsDir(), "backups-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as { undestroyed: Record<string, Record<string, string[]>> };
    const mine = state.undestroyed[p.id]!;
    for (const k of Object.keys(mine)) mine[k]!.push(rel(liveOnly));
    await writeFile(statePath, JSON.stringify(state));
    kit.clock.now = new Date("2026-12-02T11:30:00.000Z");
    await resumeDestruction(kit.repo, p.id);
    // This pass deletes nothing for that destruction and says why.
    expect(existsSync(liveOnly.path)).toBe(true);
    expect(existsSync(x.path)).toBe(true);
    expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
    const said = (await reports(p)).filter((e) => typeof detailsOf(e).problem === "string");
    expect(said).toHaveLength(1);
    expect(detailsOf(said[0]!).problem).toMatch(/audit log/u);
    // The note now says what the audit log says.
    expect(await holdingNotRemoved(kit.repo, p.id)).toEqual([rel(x)]);
    // The next pass removes what the audit log names, and only that.
    later(HOUR);
    await resumeDestruction(kit.repo, p.id);
    expect(existsSync(x.path)).toBe(false);
    expect(existsSync(liveOnly.path)).toBe(true);
    expect((await readDestruction(kit.repo, p.id, certificatePath)).status).toBe("deleted");
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
  });

  it("an event added to the audit log outside the app (a forged list naming a backup of live data): nothing is deleted, and the reason is given", async () => {
    const { p, x } = await stuck();
    kit.clock.now = new Date("2026-12-02T10:30:00.000Z");
    const liveOnly = await backupProject(kit.repo, p.id, { prune: false });
    // A forged destruction, with a certificate file that matches it, chained correctly onto the log.
    const dir = join(kit.lib.root, kit.repo.getProject(p.id).folder);
    const fake = `${JSON.stringify({ formatVersion: 1, kind: "destruction-certificate", projectId: p.id, assets: [], backups: { status: "pending", containing: [rel(liveOnly)], deleted: [] } }, null, 2)}\n`;
    await writeFile(join(dir, "retention", "destruction-2026-12-02 1031.json"), fake);
    const events = await auditEvents(kit, p);
    const head = events.at(-1)!;
    const forgedEvent = sealEvent(
      {
        at: "2026-12-02T10:31:00.000Z",
        actor: "tester",
        device: "dev-A",
        projectId: p.id,
        action: "delete",
        entity: { type: "project", id: p.id },
        decision: { result: "allow" },
        details: { op: "retention.destroy", certificate: "destruction-2026-12-02 1031.json", certificateSha256: sha(fake), backupsToRemove: [rel(liveOnly)], backupsUnreadable: [] },
      },
      { seq: head.seq, hash: head.hash },
    );
    const segment = (await readdir(join(dir, "audit"))).sort().at(-1)!;
    await appendFile(join(dir, "audit", segment), `${JSON.stringify(forgedEvent)}\n`);
    kit.clock.now = new Date("2026-12-02T11:30:00.000Z");
    await resumeDestruction(kit.repo, p.id);
    expect(existsSync(liveOnly.path)).toBe(true);
    expect(existsSync(x.path)).toBe(true);
    expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
    const recs = await listDestructions(kit.repo, p.id);
    expect(recs.every((r) => /audit log/u.test(r.problem ?? ""))).toBe(true);
  });
});

describe("what is recorded late from a mark (Task 50) is never a destruction's list, nor a record of a removal", () => {
  it("marks left on disk that claim a removal and a destruction of their own: recorded late as what a mark may be, and the retry reads nothing from them", async () => {
    const { p, x, certificatePath } = await stuck();
    kit.clock.now = new Date("2026-12-02T10:30:00.000Z");
    const liveOnly = await backupProject(kit.repo, p.id, { prune: false });
    const folder = kit.repo.getProject(p.id).folder;
    const certificate = basename(certificatePath);
    const certificateSha256 = sha(await readFile(certificatePath));
    // Written outside the app, in the form of the app's own marks (an action a mark may name), with
    // the details of the events the retry trusts.
    const mark = (details: Record<string, unknown>): UnrecordedAudit => ({
      formatVersion: 1,
      id: newAttentionId(),
      kind: "audit-unrecorded",
      occurredAt: "2026-12-02T10:31:00.000Z",
      actor: "tester",
      device: "dev-A",
      action: "library.relink",
      details,
      state: "ready",
    });
    // The stuck backup is said to be removed, and to be gone.
    await writeAttention(kit.lib.root, folder, mark({ op: "retention.backups", certificate, certificateSha256, stepAt: "2026-12-02T10:31:00.000Z", status: "deleted", removed: [rel(x)], noLongerPresent: [rel(x)], notRemoved: [] }));
    // A destruction of its own, whose list names the backup of live data.
    await writeAttention(kit.lib.root, folder, mark({ op: "retention.destroy", certificate: "destruction-2026-12-02 1031.json", certificateSha256: sha("forged"), backupsToRemove: [rel(liveOnly)], backupsUnreadable: [] }));
    const again = await kit.reopen();
    // Both are in the audit log now, recorded late under the action a mark may name; the chain holds.
    const late = (await auditEvents(kit, p)).filter((e) => detailsOf(e).recordedLate !== undefined);
    expect(late.map((e) => e.action)).toEqual(["library.relink", "library.relink"]);
    expect(late.map((e) => detailsOf(e).op).sort()).toEqual(["retention.backups", "retention.destroy"]);
    expect(verifyChain(await auditEvents(kit, p)).ok).toBe(true);

    // The retry runs and the removal still fails: nothing was taken from the marks.
    kit.clock.now = new Date("2026-12-02T11:30:00.000Z");
    shredSeams.failFor = (path) => path.endsWith(nameOf(x));
    await resumeDestruction(again, p.id);
    shredSeams.failFor = undefined;
    expect(existsSync(x.path)).toBe(true);
    expect(existsSync(liveOnly.path)).toBe(true);
    const all = await listDestructions(again, p.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "pending", outstanding: [rel(x)], verified: true });
    expect(all[0]!.problem).toBeUndefined();
    expect(await holdingNotRemoved(again, p.id)).toEqual([rel(x)]);
    expect(await projectWarnings(again, p.id)).toContain(WARNING);
    // Nothing but the mark itself says the step is finished.
    expect((await completions(p)).filter((e) => detailsOf(e).recordedLate === undefined)).toEqual([]);
    expect(await recordedAs(p, rel(x))).toEqual({ removed: 0, gone: 0 });

    // The removal works at last: only the listed backup goes, and it is recorded once, as removed.
    later(HOUR);
    await resumeDestruction(again, p.id);
    expect(existsSync(x.path)).toBe(false);
    expect(existsSync(liveOnly.path)).toBe(true);
    expect((await readDestruction(again, p.id, certificatePath)).status).toBe("deleted");
    expect(await recordedAs(p, rel(x))).toEqual({ removed: 1, gone: 0 });
    expect(await projectWarnings(again, p.id)).not.toContain(WARNING);
  });
});

describe("an entry leaves the list only when its file is verifiably gone", () => {
  it("found missing: recorded as no longer present with the time it was noticed (audit event and amendment), its manifest entry cleared, and only then is the step done; nothing says the app removed it", async () => {
    const { p, x, certificatePath } = await stuck();
    await rm(x.path); // outside the app
    later(HOUR);
    const noticed = kit.clock.now.toISOString();
    await resumeDestruction(kit.repo, p.id);
    const rec = await readDestruction(kit.repo, p.id, certificatePath);
    expect(rec.status).toBe("no-longer-present");
    expect(rec.outstanding).toEqual([]);
    const bk = rec.certificate!.backups as { status: string; deleted: string[]; removedAt?: Record<string, string>; noLongerPresent?: Array<{ file: string; at: string }> };
    expect(bk.noLongerPresent).toEqual([{ file: rel(x), at: noticed }]);
    expect(bk.deleted).toEqual([]);
    expect(bk.removedAt ?? {}).toEqual({});
    // The amendment beside the certificate says the same, and the audit event that reports it carries its sha256.
    const last = rec.amendments.at(-1)!;
    expect(last.verified).toBe(true);
    expect((last.content!.backups as { noLongerPresent: unknown; removed: unknown }).noLongerPresent).toEqual([{ file: rel(x), at: noticed }]);
    expect((last.content!.backups as { removed: unknown }).removed).toEqual([]);
    const ev = (await amendmentEvents(p)).at(-1)!;
    expect(ev.at).toBe(noticed);
    expect(detailsOf(ev)).toMatchObject({ removed: [], noLongerPresent: [rel(x)], notRemoved: [], status: "no-longer-present", amendmentSha256: last.sha256 });
    expect(detailsOf((await reports(p)).at(-1)!)).toMatchObject({ removed: [], noLongerPresent: [rel(x)], status: "no-longer-present" });
    // No event and no amendment says the app removed it.
    for (const e of await auditEvents(kit, p)) expect(detailsOf(e).removed ?? []).not.toContain(rel(x));
    for (const a of rec.amendments) expect(JSON.stringify((a.content!.backups as { removed: unknown }).removed)).not.toContain(nameOf(x));
    // The manifest no longer lists it.
    const manifest = JSON.parse(await readFile(join(backupsDir(), "backups-manifest.json"), "utf8")) as { backups: Array<{ file: string }> };
    expect(manifest.backups.map((b) => b.file)).not.toContain(nameOf(x));
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
    // Nothing is left for a later pass, and nothing is recorded twice.
    const count = (await auditEvents(kit, p)).length;
    later(HOUR);
    expect(await resumeDestruction(kit.repo, p.id)).toEqual([]);
    expect((await auditEvents(kit, p)).length).toBe(count);
  });

  it("a listed name given to a later backup: the later backup is never deleted; the listed one is recorded as no longer present", async () => {
    const p = await makeProject(kit, RETAIN, false, "Renamed");
    const sf = await rawSource(p);
    kit.clock.now = new Date("2026-12-02T09:59:00.000Z");
    const x = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
    shredSeams.failFor = (path) => path.endsWith(nameOf(x));
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    shredSeams.failFor = undefined;
    await rm(x.path); // outside the app
    // A backup made by hand gets the same name (same minute on the clock; the name is free again).
    kit.clock.now = new Date("2026-12-02T09:59:30.000Z");
    const again = await backupProject(kit.repo, p.id, { prune: false });
    expect(nameOf(again)).toBe(nameOf(x));
    kit.clock.now = new Date("2026-12-02T11:00:00.000Z");
    await resumeDestruction(kit.repo, p.id);
    expect(existsSync(again.path)).toBe(true);
    expect(sha(await readFile(again.path))).toBe(again.sha256);
    const rec = await readDestruction(kit.repo, p.id, r.certificatePath);
    expect(rec.status).toBe("no-longer-present");
    expect((rec.certificate!.backups as { noLongerPresent?: Array<{ file: string }> }).noLongerPresent?.map((e) => e.file)).toEqual([rel(x)]);
    expect((rec.certificate!.backups as { deleted: string[] }).deleted).toEqual([]);
  });

  describe("a backup that could not be read at the destruction (it may hold the destroyed files)", () => {
    /** The project's one readable backup is removed; a file under its name that cannot be read stays listed. */
    async function unreadable(): Promise<{ p: Project; certificatePath: string; garbage: string; holding: Buffer; fresh: string }> {
      const p = await makeProject(kit, RETAIN, false, "Corrupt");
      const sf = await rawSource(p);
      const b = await backupProject(kit.repo, p.id);
      const holding = await readFile(b.path);
      const garbage = join(backupsDir(), "Corrupt - backup - modified 2026-01-01 0000.zip");
      await writeFile(garbage, "not a zip at all");
      await writeFile(join(backupsDir(), "backups-manifest.json"), "garbage");
      kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
      const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
      const bk = r.certificate.backups as { status: string; freshBackup?: string };
      expect(bk.status).toBe("unknown-pending");
      expect(existsSync(b.path)).toBe(false);
      return { p, certificatePath: r.certificatePath, garbage, holding, fresh: join(kit.lib.root, ...bk.freshBackup!.split("/")) };
    }
    const G = "Backups/Corrupt - backup - modified 2026-01-01 0000.zip";

    it("stays listed, never deleted blindly, and the warning stands; once it is gone it is recorded as no longer present and the step is done", async () => {
      const { p, certificatePath, garbage } = await unreadable();
      const commit = (await auditEvents(kit, p)).find((e) => detailsOf(e).op === "retention.destroy")!;
      expect(detailsOf(commit).backupsUnreadable).toEqual([G]);
      later(HOUR);
      await resumeDestruction(kit.repo, p.id);
      expect(existsSync(garbage)).toBe(true);
      let rec = await readDestruction(kit.repo, p.id, certificatePath);
      expect(rec.status).toBe("unknown-pending");
      expect(rec.outstanding).toEqual([G]);
      expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
      await rm(garbage);
      later(HOUR);
      await resumeDestruction(kit.repo, p.id);
      rec = await readDestruction(kit.repo, p.id, certificatePath);
      expect(rec.status).toBe("no-longer-present");
      expect((rec.certificate!.backups as { noLongerPresent?: Array<{ file: string; at: string }> }).noLongerPresent).toEqual([{ file: G, at: kit.clock.now.toISOString() }]);
      expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
    });

    it("once it can be read and holds a destroyed file, it is removed by the app and recorded as removed", async () => {
      const { p, certificatePath, garbage, holding } = await unreadable();
      await writeFile(garbage, holding);
      later(HOUR);
      await resumeDestruction(kit.repo, p.id);
      expect(existsSync(garbage)).toBe(false);
      const rec = await readDestruction(kit.repo, p.id, certificatePath);
      expect(rec.status).toBe("deleted");
      expect((rec.certificate!.backups as { removedAt: Record<string, string> }).removedAt[G]).toBe(kit.clock.now.toISOString());
      expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
    });

    it("once it can be read and holds none of the destroyed files, it is kept and recorded as examined", async () => {
      const { p, certificatePath, garbage, fresh } = await unreadable();
      await writeFile(garbage, await readFile(fresh));
      later(HOUR);
      await resumeDestruction(kit.repo, p.id);
      expect(existsSync(garbage)).toBe(true);
      const rec = await readDestruction(kit.repo, p.id, certificatePath);
      expect(rec.status).toBe("deleted");
      expect(rec.outstanding).toEqual([]);
      expect((rec.certificate!.backups as { notHolding?: Array<{ file: string; at: string }> }).notHolding).toEqual([{ file: G, at: kit.clock.now.toISOString() }]);
      expect(detailsOf((await amendmentEvents(p)).at(-1)!)).toMatchObject({ removed: [], noLongerPresent: [], notHolding: [G] });
      expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
    });
  });
});

describe("the certificate written at the destruction is never rewritten", () => {
  it("after one, two and three amendments its bytes are the same and its sha256 is the one in retention.destroyed; each amendment's sha256 is in the audit event that reports it", async () => {
    const p = await makeProject(kit, RETAIN, false, "Bytes");
    const sf = await rawSource(p);
    const a = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-11-10T09:31:00.000Z");
    const b = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
    shredSeams.failFor = (path) => path.endsWith(nameOf(a)) || path.endsWith(nameOf(b));
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    const written = await readFile(r.certificatePath);
    const destroyed = (await auditEvents(kit, p)).find((e) => e.action === "retention.destroyed")!;
    const recordedSha = detailsOf(destroyed).certificateSha256;

    const check = async (amendments: number, status: string) => {
      expect((await readFile(r.certificatePath)).equals(written)).toBe(true);
      expect(sha(await readFile(r.certificatePath))).toBe(recordedSha);
      const rec = await readDestruction(kit.repo, p.id, r.certificatePath);
      expect(rec.verified).toBe(true);
      expect(rec.certificateSha256).toBe(recordedSha);
      expect(rec.original).toEqual(JSON.parse(written.toString("utf8")));
      expect(rec.status).toBe(status);
      expect(rec.amendments).toHaveLength(amendments);
      const inAudit = (await amendmentEvents(p)).map((e) => detailsOf(e).amendmentSha256);
      const inReports = (await reports(p)).map((e) => detailsOf(e).amendmentSha256);
      for (const am of rec.amendments) {
        // Every amendment file on disk is the one the audit log vouches for.
        expect(sha(await readFile(join(kit.lib.root, ...am.file.split("/"))))).toBe(am.sha256);
        expect(am.verified).toBe(true);
        expect(inAudit).toContain(am.sha256);
        expect(inReports).toContain(am.sha256);
        expect(am.content).toMatchObject({ kind: "destruction-certificate-amendment", certificateSha256: recordedSha });
      }
      expect(new Set(rec.amendments.map((am) => am.file)).size).toBe(amendments);
    };
    await check(1, "pending");

    // One of the two can be removed.
    later(HOUR);
    shredSeams.failFor = (path) => path.endsWith(nameOf(b));
    await resumeDestruction(kit.repo, p.id);
    expect(existsSync(a.path)).toBe(false);
    await check(2, "pending");

    later(HOUR);
    shredSeams.failFor = undefined;
    await resumeDestruction(kit.repo, p.id);
    expect(existsSync(b.path)).toBe(false);
    await check(3, "deleted");
    const rec = await readDestruction(kit.repo, p.id, r.certificatePath);
    expect((rec.certificate!.backups as { deleted: string[] }).deleted.sort()).toEqual([rel(a), rel(b)].sort());
    // What the destruction returned at the time was the same presentation.
    expect((r.certificate.backups as { status: string }).status).toBe("pending");
    expect(r.original).toEqual(JSON.parse(written.toString("utf8")));
  });

  it("an encrypted project: the sealed certificate keeps verifying, and the sealed amendment's sha256 (of its text) is in the audit log", async () => {
    const p = await makeProject(kit, RETAIN.replace("atRest: optional", "atRest: required"), true, "Sealed");
    const sf = await rawSource(p);
    const x = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
    shredSeams.failFor = (path) => path.endsWith(nameOf(x));
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    shredSeams.failFor = undefined;
    const sealedBytes = await readFile(r.certificatePath);
    later(HOUR);
    await resumeDestruction(kit.repo, p.id);
    expect((await readFile(r.certificatePath)).equals(sealedBytes)).toBe(true);
    const toRel = (abs: string) => abs.slice(kit.lib.root.length + 1);
    const recordedSha = detailsOf((await auditEvents(kit, p)).find((e) => e.action === "retention.destroyed")!).certificateSha256;
    expect(sha(await plainOf(kit, p, toRel(r.certificatePath)))).toBe(recordedSha);
    const rec = await readDestruction(kit.repo, p.id, r.certificatePath);
    expect(rec).toMatchObject({ verified: true, status: "deleted" });
    expect(rec.amendments).toHaveLength(2);
    for (const am of rec.amendments) {
      expect(am.file.endsWith(".json.enc")).toBe(true);
      expect(sha(await plainOf(kit, p, am.file))).toBe(am.sha256);
      expect((await readFile(join(kit.lib.root, ...am.file.split("/")))).includes(Buffer.from(nameOf(x)))).toBe(false);
    }
  });
});

describe("crash safety: a removal that was not recorded", () => {
  const recorded = recordedAs;

  const cases: Array<[string, () => void]> = [
    ["between removing the backup and recording it", () => (backupSeams.crashAt = "before-removal-record")],
    ["while the record is being written (before its audit event)", () => (seams.crashAt = "before-audit")],
    ["right after the record's audit event", () => (seams.crashAt = "before-marker-delete")],
  ];
  for (const [when, arm] of cases) {
    it(`a crash ${when}: the next retry settles it; the file is recorded once, as removed or as no longer present, and never left listed`, async () => {
      const { p, x, certificatePath } = await stuck();
      later(HOUR);
      arm();
      await expect(resumeDestruction(kit.repo, p.id)).rejects.toBeInstanceOf(SimulatedCrash);
      expect(existsSync(x.path)).toBe(false);
      const again = await kit.reopen();
      later(HOUR);
      await resumeDestruction(again, p.id);
      const rec = await readDestruction(again, p.id, certificatePath);
      expect(["deleted", "no-longer-present"]).toContain(rec.status);
      expect(rec.outstanding).toEqual([]);
      const n = await recorded(p, rel(x));
      expect(n.removed + n.gone).toBe(1);
      // Recorded as removed by the app only when the app's own record of the removal was committed.
      if (rec.status === "deleted") expect(n).toEqual({ removed: 1, gone: 0 });
      else expect(n).toEqual({ removed: 0, gone: 1 });
      expect(rec.amendments.every((a) => a.verified)).toBe(true);
      expect(await holdingNotRemoved(again, p.id)).toEqual([]);
      expect(await projectWarnings(again, p.id)).not.toContain(WARNING);
      // Later passes add nothing.
      const count = (await auditEvents(kit, p)).length;
      later(HOUR);
      expect(await resumeDestruction(again, p.id)).toEqual([]);
      expect((await auditEvents(kit, p)).length).toBe(count);
      expect(await recorded(p, rel(x))).toEqual(n);
      expect(verifyChain(await auditEvents(kit, p)).ok).toBe(true);
    });
  }

  it("the record cannot be written (the audit log refuses the entry): the backup still counts as outstanding and the warning stands until a later pass records it", async () => {
    const { p, x, certificatePath } = await stuck();
    later(HOUR);
    seams.failAuditAppendFor = p.id;
    try {
      await expect(resumeDestruction(kit.repo, p.id)).rejects.toThrow();
    } finally {
      seams.failAuditAppendFor = undefined;
    }
    // The file went, but nothing says so yet: not an amendment, not the audit log, not the warning.
    expect(existsSync(x.path)).toBe(false);
    let rec = await readDestruction(kit.repo, p.id, certificatePath);
    expect(rec).toMatchObject({ status: "pending", outstanding: [rel(x)] });
    expect(rec.amendments).toHaveLength(1);
    expect(rec.problem).toBeUndefined();
    expect(await holdingNotRemoved(kit.repo, p.id)).toEqual([rel(x)]);
    expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
    later(HOUR);
    await resumeDestruction(kit.repo, p.id);
    rec = await readDestruction(kit.repo, p.id, certificatePath);
    expect(rec).toMatchObject({ status: "no-longer-present", outstanding: [] });
    expect(await recorded(p, rel(x))).toEqual({ removed: 0, gone: 1 });
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
  });

  it("a crash right after the destruction, before its backups were touched: the retry works from the audit log's list", async () => {
    const p = await makeProject(kit, RETAIN, false, "Early");
    const sf = await rawSource(p);
    const x = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
    seams.crashAt = "before-marker-delete";
    await expect(destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester")).rejects.toBeInstanceOf(SimulatedCrash);
    const again = await kit.reopen();
    const [before] = await listDestructions(again, p.id);
    expect(before).toMatchObject({ status: "pending", outstanding: [rel(x)], verified: true, amendments: [] });
    later(HOUR);
    await resumeDestruction(again, p.id);
    expect(existsSync(x.path)).toBe(false);
    const [after] = await listDestructions(again, p.id);
    expect(after).toMatchObject({ status: "deleted", outstanding: [] });
    expect(after!.amendments).toHaveLength(1);
  });
});

describe("nothing reviewed regresses: a removal that fails for good, retried every hour", () => {
  /** Audit events written after the destruction, at 48 hours and at 30 days; the repository is reopened every hour for the first 72. */
  async function measure(refused: boolean): Promise<{ h48: string[]; d30: string[]; attempts: number }> {
    const p = await makeProject(kit, RETAIN, false, refused ? "Refused" : "Made");
    const sf = await rawSource(p);
    const x = await backupProject(kit.repo, p.id, { locationEnv: onDisk() });
    if (refused) {
      const g = await kit.repo.getGovernance(p.id);
      await kit.repo.setGovernance(p.id, `${RETAIN}residency:\n  allowed: [removable]\n`, { baseSha256: g.sha256 });
    }
    const t0 = new Date("2026-12-02T10:00:00.000Z").getTime();
    kit.clock.now = new Date(t0);
    shredSeams.failFor = (path) => path.endsWith(nameOf(x));
    await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    const before = (await auditEvents(kit, p)).length;
    let h48: string[] = [];
    let attempts = 0;
    for (let h = 1; h <= 720; h++) {
      kit.clock.now = new Date(t0 + h * HOUR);
      if (h <= 72) await kit.reopen();
      attempts += (await resumeDestruction(kit.repo, p.id)).length;
      if (h % 24 === 0) expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
      if (h === 48) h48 = (await auditEvents(kit, p)).slice(before).map((e) => e.action);
    }
    expect(existsSync(x.path)).toBe(true);
    return { h48, d30: (await auditEvents(kit, p)).slice(before).map((e) => e.action), attempts };
  }

  it("a fresh backup was made: 1 audit event in 48 hours, 29 in 30 days; restarts add none", async () => {
    const m = await measure(false);
    expect(m.h48).toEqual(["retention.backups"]);
    expect(m.d30).toHaveLength(29);
    expect(new Set(m.d30)).toEqual(new Set(["retention.backups"]));
    expect(m.attempts).toBe(23 + 29);
  }, 120_000);

  it("the fresh backup was refused: 2 audit events in 48 hours, 58 in 30 days", async () => {
    const m = await measure(true);
    expect(m.h48.sort()).toEqual(["backup", "retention.backups"]);
    expect(m.d30).toHaveLength(58);
    expect(m.d30.filter((a) => a === "retention.backups")).toHaveLength(29);
    expect(m.d30.filter((a) => a === "backup")).toHaveLength(29);
  }, 120_000);
});
