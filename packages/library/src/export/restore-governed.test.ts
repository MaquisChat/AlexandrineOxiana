/**
 * Task 50b: restoring a backup is a governed operation.
 *   1. The policy engine decides before anything is written, and again in the commit turn; a
 *      refusal is audited (in the project's log when the backup's project is in this library, else
 *      in the library's own log) and said in plain words without paths; any failure to decide refuses.
 *   3. What a restore does not bring back is read from the destruction record as the audit log gives
 *      it (R174 d), whatever the certificate files on disk say; while an audit log does not verify,
 *      the restore is refused rather than guessing.
 *   4. A restored project that inherits backups still to be removed shows its warning from the
 *      restore itself (R175).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sealEvent, verifyChain, type AuditEvent, type Project, type SourceFile } from "@ao/core";
import { shredSeams } from "../fs/shred.js";
import type { LocationEnv } from "../location.js";
import { newAttentionId, writeAttention, type UnrecordedAudit } from "../repo/attention.js";
import { AuditStore } from "../repo/audit-store.js";
import { PolicyDeniedError } from "../repo/errors.js";
import { encryptBytes } from "../repo/io.js";
import { projectDataKey, projectWarnings } from "../repo/repo.js";
import { restoreSeams as seamsOfRestore } from "../repo/restore.js";
import { seams } from "../repo/testing.js";
import { backupsAwaitingRemoval, destroyRaw, listDestructions, readDestruction, resumeDestruction, type DestroyResult } from "../retention.js";
import {
  BACKUPS_STATE,
  DestructionRecordError,
  RestoreError,
  backupProject,
  backupSeams,
  holdingNotRemoved,
  restoreBackup,
  withProjectMaintenance,
  type BackupResult,
  type RestoreOptions,
  type RestoreResult,
} from "./backup.js";
import { exportProjectOpenFormats } from "./project-export.js";
import { OPEN_GOV, PSEUDO_GOV, addSource, auditEvents, makeKit, makeProject, scratchFile, type Kit } from "./test-kit.js";

type Restored = RestoreResult;
const restore = (path: string, opts: RestoreOptions = {}, repo = kit.repo) => restoreBackup(repo, path, opts);

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-restore-gov-");
});
afterEach(async () => {
  shredSeams.failFor = undefined;
  backupSeams.failBackup = false;
  backupSeams.freeBytes = undefined;
  seams.failAuditAppendFor = undefined;
  seamsOfRestore.beforeAdopt = undefined;
  seamsOfRestore.failBeforeRename = false;
  seamsOfRestore.crashAfterRename = false;
  await kit.close();
});

const HOUR = 3_600_000;
const WARNING = "destruction-backups-pending";
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const nameOf = (x: { path: string }) => x.path.slice(x.path.lastIndexOf("/") + 1);
const rel = (x: { path: string }) => `Backups/${nameOf(x)}`;
const abs = (libraryRelative: string) => join(kit.lib.root, ...libraryRelative.split("/"));
const at = (iso: string) => {
  kit.clock.now = new Date(iso);
};
const later = (ms: number) => {
  kit.clock.now = new Date(kit.clock.now.getTime() + ms);
};
/** Where the library is, as the location classifier would see it. */
const onDisk = (): LocationEnv => ({ homeDir: kit.tmp, platform: "linux", mounts: [{ path: "/", removable: false, network: false }] });
const onNetwork = (): LocationEnv => ({ homeDir: kit.tmp, platform: "linux", mounts: [{ path: kit.lib.root, removable: false, network: true }] });
const unknownPlace = (): LocationEnv => ({ homeDir: kit.tmp, platform: "linux", mounts: [], mountsKnown: false });
const NETWORK_REASON = "The project would be restored into the library's folder, which is on a network drive. The rule on where data may live in this backup's own rules does not allow its data there. Restore the backup into another library, on storage that rule allows.";

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

type Details = Record<string, unknown> & { op?: string; problem?: string; destroyedAssets?: string[] };
const detailsOf = (e: AuditEvent) => (e.details ?? {}) as Details;
const eventsOf = (projectId: string) => auditEvents(kit, kit.repo.getProject(projectId));
/** Refused restores in a project's own audit log. */
const refusalsIn = async (projectId: string) => (await eventsOf(projectId)).filter((e) => e.action === "restore");
/** Refused restores in the library's own audit log. */
const libraryRefusals = async (k: Kit = kit) => (await k.repo.libraryAudit()).events.filter((e) => e.action === "restore");
/** The folders in Projects/ (a restore in progress would show as `.creating-<id>`). */
const projectFolders = async () => (await readdir(join(kit.lib.root, "Projects")).catch(() => [] as string[])).sort();
const ids = () => kit.repo.listProjects().map((p) => p.id).sort();

/** Asserts that a refused restore left nothing behind: no project, no staging folder. */
async function expectNothingRestored(foldersBefore: string[], idsBefore: string[]): Promise<void> {
  expect(await projectFolders()).toEqual(foldersBefore);
  expect(ids()).toEqual(idsBefore);
}

/** A copy of a backup with some of its files replaced (or removed, with `null`), kept outside the library. */
async function craft(b: { path: string }, changes: Record<string, string | null>, name = "crafted.zip"): Promise<string> {
  const files = unzipSync(new Uint8Array(await readFile(b.path)));
  for (const [n, text] of Object.entries(changes)) {
    if (text === null) delete files[n];
    else files[n] = strToU8(text);
  }
  const out = join(kit.tmp, name);
  await writeFile(out, zipSync(files));
  return out;
}

async function rawSource(p: Project, bytes = "RAW interview audio bytes"): Promise<SourceFile> {
  const f = await scratchFile(kit, "interview.mp3", bytes);
  return addSource(kit, p, { type: "interview", title: "Interview one", identifiable: true, files: [{ path: f, role: "original", handling: "copy" }] });
}
async function keptSource(p: Project): Promise<SourceFile> {
  const f = await scratchFile(kit, "paper.pdf", "%PDF-1.4 a paper that is kept");
  return addSource(kit, p, { title: "Kept paper", files: [{ path: f, role: "original", handling: "copy" }] });
}

/** The restored project's sources by title, and whether each one's original came back. */
async function restoredFiles(projectId: string): Promise<Record<string, { status: string | undefined; onDisk: boolean; assetId: string; sourceId: string }>> {
  const out: Record<string, { status: string | undefined; onDisk: boolean; assetId: string; sourceId: string }> = {};
  for (const id of kit.repo.listSourceIds(projectId)) {
    const sf = await kit.repo.getSource(projectId, id);
    const a = sf.assets[0]!;
    out[sf.source.title.variants[0]!.value] = { status: a.status, onDisk: existsSync(abs(a.path)), assetId: a.id, sourceId: id };
  }
  return out;
}

// ------------------------------------------------------------------------------------------
describe("1. a restore is decided by the policy engine before anything is written", () => {
  it("an allowed restore: the new project's log records the decision with the restore, with its conditions", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Open");
    await addSource(kit, p, { title: "x" });
    const b = await backupProject(kit.repo, p.id);
    const r = await restore(b.path, { locationEnv: onDisk() });
    const last = (await eventsOf(r.projectId)).at(-1)!;
    expect(last).toMatchObject({ action: "project.restored", projectId: r.projectId, decision: { result: "allow" } });
    expect(last.details).toMatchObject({ op: "project.restore", backupSha256: b.sha256, restoredFrom: p.id });
    expect(verifyChain(await eventsOf(r.projectId)).ok).toBe(true);
    expect(await refusalsIn(p.id)).toEqual([]);

    const e = await makeProject(kit, PSEUDO_GOV, true, "Sealed");
    await addSource(kit, e, { title: "y" });
    const sealed = await backupProject(kit.repo, e.id);
    const r2 = await restore(sealed.path, { locationEnv: onDisk() });
    const last2 = (await eventsOf(r2.projectId)).at(-1)!;
    expect(last2.action).toBe("project.restored");
    expect(last2.decision).toEqual({ result: "allow_with_conditions", conditions: [{ type: "encrypt" }] });
    expect(kit.repo.getProject(r2.projectId).encryption.enabled).toBe(true);
  });

  it("a library on storage the backup's rules exclude: refused before anything is written, in plain words, and audited in the project's log", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Net");
    await addSource(kit, p, { title: "x" });
    const b = await backupProject(kit.repo, p.id);
    const folders = await projectFolders();
    const before = ids();
    let spaceAsked = false;
    backupSeams.freeBytes = async () => {
      spaceAsked = true; // asked right before the first file would be written
      return Number.MAX_SAFE_INTEGER;
    };
    const err = (await restore(b.path, { locationEnv: onNetwork() }).catch((e: unknown) => e)) as PolicyDeniedError;
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect(err.reason).toBe(NETWORK_REASON);
    expect(spaceAsked).toBe(false);
    await expectNothingRestored(folders, before);
    const denied = await refusalsIn(p.id);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.decision).toEqual({ result: "deny", reason: NETWORK_REASON });
    expect(denied[0]!.details).toMatchObject({ op: "project.restore", backupSha256: b.sha256, file: nameOf(b), at: "decision" });
    expect(denied[0]!.entity).toEqual({ type: "project", id: p.id });
    expect(JSON.stringify(denied[0])).not.toContain(kit.tmp);
    expect(await libraryRefusals()).toEqual([]);
    expect(verifyChain(await eventsOf(p.id)).ok).toBe(true);
  });

  it("where the library is cannot be determined: refused when it may be storage the rules exclude (fail closed)", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Unknown");
    const b = await backupProject(kit.repo, p.id);
    const folders = await projectFolders();
    await expect(restore(b.path, { locationEnv: unknownPlace() })).rejects.toMatchObject({
      reason: "Where the library's folder is stored could not be determined (it may be a network drive), and the rule on where data may live in this backup's own rules does not allow its data there. Restore the backup into another library, on storage that rule allows.",
    });
    await expectNothingRestored(folders, [p.id]);
    expect(await refusalsIn(p.id)).toHaveLength(1);
  });

  it("rules in the backup that require encryption at rest, for a project that is not encrypted: nothing comes back unencrypted", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Plain");
    await addSource(kit, p, { title: "x" });
    const b = await backupProject(kit.repo, p.id);
    const copy = await craft(b, { "governance.yaml": OPEN_GOV.replace("atRest: optional", "atRest: required") });
    const folders = await projectFolders();
    const err = (await restore(copy).catch((e: unknown) => e)) as PolicyDeniedError;
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect(err.reason).toMatch(/require encryption at rest/u);
    expect(err.reason).toMatch(/not encrypted/u);
    await expectNothingRestored(folders, [p.id]);
    const denied = await refusalsIn(p.id);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.decision).toEqual({ result: "deny", reason: err.reason });
    // A file from elsewhere: its sha256 is recorded, never its name or where it was.
    expect(denied[0]!.details).toMatchObject({ op: "project.restore", backupSha256: sha(await readFile(copy)) });
    expect(JSON.stringify(denied[0])).not.toContain("crafted");
  });

  it("a sealed backup whose project is not an encrypted one would come back unencrypted: refused", async () => {
    const plain = await makeProject(kit, OPEN_GOV, false, "Plain Inside");
    await addSource(kit, plain, { title: "x" });
    const b = await backupProject(kit.repo, plain.id);
    const e = await makeProject(kit, PSEUDO_GOV, true, "Key Owner");
    const k = projectDataKey(kit.repo, e.id)!;
    const sealed = join(kit.tmp, "sealed by hand.zip.enc");
    await writeFile(sealed, await encryptBytes(k.key, k.keyId, await readFile(b.path)));
    const folders = await projectFolders();
    const before = ids();
    const err = (await restore(sealed).catch((x: unknown) => x)) as PolicyDeniedError;
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect(err.reason).toMatch(/sealed/u);
    await expectNothingRestored(folders, before);
    expect(await refusalsIn(plain.id)).toHaveLength(1);
  });

  it("rules that cannot be read (no governance.yaml in the backup, or one that is not YAML): refused, the reason without a path", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "No Rules");
    const b = await backupProject(kit.repo, p.id);
    const folders = await projectFolders();
    for (const [n, text] of [["none.zip", null], ["bad.zip", "identifiability: [unclosed\n  nope: {"]] as const) {
      const copy = await craft(b, { "governance.yaml": text }, n);
      const err = (await restore(copy).catch((e: unknown) => e)) as PolicyDeniedError;
      expect(err).toBeInstanceOf(PolicyDeniedError);
      expect(err.reason).toMatch(/^Policy could not be evaluated/u);
      expect(err.reason).not.toContain(kit.tmp);
      await expectNothingRestored(folders, [p.id]);
    }
    const denied = await refusalsIn(p.id);
    expect(denied).toHaveLength(2);
    for (const d of denied) expect(d.decision?.result).toBe("deny");
  });

  it("a backup of a project that is not in this library: a refusal is recorded in the library's own audit log, once a day for the same refusal; an allowed one restores", async () => {
    const other = await makeKit("ao-restore-other-");
    try {
      const theirs = await makeProject(other, OPEN_GOV, false, "Elsewhere");
      await addSource(other, theirs, { title: "from another library" });
      const b = await backupProject(other.repo, theirs.id);
      const folders = await projectFolders();
      for (let n = 0; n < 2; n++) {
        const err = (await restore(b.path, { locationEnv: onNetwork() }).catch((e: unknown) => e)) as PolicyDeniedError;
        expect(err).toBeInstanceOf(PolicyDeniedError);
        expect(err.reason).toBe(NETWORK_REASON);
      }
      await expectNothingRestored(folders, []);
      const denied = await libraryRefusals();
      expect(denied).toHaveLength(1);
      expect(denied[0]!.decision).toEqual({ result: "deny", reason: NETWORK_REASON });
      expect(denied[0]!.details).toMatchObject({ op: "project.restore", name: "Elsewhere", encrypted: false, backupSha256: b.sha256 });
      expect(JSON.stringify(denied[0])).not.toContain(other.tmp);
      expect(JSON.stringify(denied[0])).not.toContain(kit.tmp);
      expect((await kit.repo.libraryAudit()).verify.ok).toBe(true);
      // Nothing was written to the library the backup came from.
      expect(await libraryRefusals(other)).toEqual([]);

      const r = await restore(b.path, { locationEnv: onDisk() });
      expect(kit.repo.getProject(r.projectId).name).toBe("Elsewhere (restored 2026-11-10)");
      expect((await eventsOf(r.projectId)).at(-1)).toMatchObject({ action: "project.restored", decision: { result: "allow" } });
    } finally {
      await other.close();
    }
  });

  it("fix round 1 (M4): a refusal by policy is never appended to a project log that no longer verifies: it goes to the library's log, which says so", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Changed Outside");
    await addSource(kit, p, { title: "x" });
    const b = await backupProject(kit.repo, p.id);
    await addSource(kit, p, { title: "y" });
    // Changed outside the app while it runs: the open found nothing wrong with this log.
    await breakAudit(p, (l) => l.includes('"action":"backup.create"'));
    const count = (await eventsOf(p.id)).length;
    const folders = await projectFolders();
    const err = (await restore(b.path, { locationEnv: onNetwork() }).catch((e: unknown) => e)) as PolicyDeniedError;
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect(err.reason).toBe(NETWORK_REASON);
    await expectNothingRestored(folders, [p.id]);
    expect((await eventsOf(p.id)).length).toBe(count);
    const denied = await libraryRefusals();
    expect(denied).toHaveLength(1);
    expect(denied[0]!.decision).toEqual({ result: "deny", reason: NETWORK_REASON });
    expect(denied[0]!.details).toMatchObject({ op: "project.restore", name: "Changed Outside", backupSha256: b.sha256, at: "decision", projectLogNotIntact: true });
  });

  it("fix round 1 (M4): a refusal the project's log cannot take for another reason goes to the library's log too, and is not said to be a log that does not hold together", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Not Writable");
    await addSource(kit, p, { title: "x" });
    const b = await backupProject(kit.repo, p.id);
    // The audit folder now lies outside the project folder, behind a link: read as before, but never written through.
    const dir = join(kit.lib.root, p.folder, "audit");
    const outside = join(kit.tmp, "audit kept elsewhere");
    await rename(dir, outside);
    await symlink(outside, dir);
    const count = (await eventsOf(p.id)).length;
    await expect(restore(b.path, { locationEnv: onNetwork() })).rejects.toBeInstanceOf(PolicyDeniedError);
    expect((await eventsOf(p.id)).length).toBe(count);
    const denied = await libraryRefusals();
    expect(denied).toHaveLength(1);
    expect(denied[0]!.details).toMatchObject({ op: "project.restore", name: "Not Writable", projectLogNotWritable: true });
    expect(denied[0]!.details).not.toHaveProperty("projectLogNotIntact");
  });

  it("a refusal that neither audit log can take still refuses, and the library warns", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Unrecorded");
    const b = await backupProject(kit.repo, p.id);
    const folders = await projectFolders();
    const count = (await eventsOf(p.id)).length;
    seams.failAuditAppendFor = p.id;
    const err = await restore(b.path, { locationEnv: onNetwork() }).catch((e: unknown) => e);
    seams.failAuditAppendFor = undefined;
    expect(err).toBeInstanceOf(PolicyDeniedError);
    await expectNothingRestored(folders, [p.id]);
    expect((await eventsOf(p.id)).length).toBe(count);
    expect(await libraryRefusals()).toEqual([]);
    const warned = kit.repo.integrityWarnings.filter((w) => w.kind === "refusal-unrecorded");
    expect(warned).toHaveLength(1);
    expect(warned[0]!.detail).toMatch(/refused restore/u);
    expect(warned[0]!.detail).not.toContain(kit.tmp);
  });

  it("a file that is not a readable project backup is refused in plain words, before anything is written", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Not A Backup");
    const b = await backupProject(kit.repo, p.id);
    const folders = await projectFolders();
    let spaceAsked = false;
    backupSeams.freeBytes = async () => {
      spaceAsked = true;
      return Number.MAX_SAFE_INTEGER;
    };
    await expect(restore(await craft(b, { "project.json": "{ not json" }, "torn.zip"))).rejects.toThrow(/project\.json cannot be read/u);
    await expect(restore(await craft(b, { "project.json": null }, "other.zip"))).rejects.toThrow(/not a project backup/u);
    for (const n of ["torn.zip", "other.zip"]) await expect(restore(join(kit.tmp, n))).rejects.toBeInstanceOf(RestoreError);
    expect(spaceAsked).toBe(false);
    await expectNothingRestored(folders, [p.id]);
  });

  it("R179: a file that is not a readable backup is refused with an entry in the library's audit log: its name, its SHA-256, the plain reason, no path", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Audited Refusals");
    await addSource(kit, p, { title: "x" });
    const b = await backupProject(kit.repo, p.id);
    const folders = await projectFolders();
    const count = (await eventsOf(p.id)).length;
    // No project.json; a project.json that cannot be read; not an archive at all; an audit log inside that does not verify.
    const files = unzipSync(new Uint8Array(await readFile(b.path)));
    const auditName = Object.keys(files).find((n) => n.startsWith("audit/"))!;
    const cases: Array<[string, RegExp]> = [
      [await craft(b, { "project.json": null }, "no project.zip"), /not a project backup/u],
      [await craft(b, { "project.json": "{ not json" }, "torn project.zip"), /project\.json cannot be read/u],
      [join(kit.tmp, "holiday photos.zip"), /could not be read|cannot be read/u],
      [await craft(b, { [auditName]: Buffer.from(files[auditName]!).toString("utf8").replace('"actor":"tester"', '"actor":"mallory"') }, "tampered log.zip"), /audit log does not verify/u],
    ];
    await writeFile(cases[2]![0], "these bytes are not an archive");
    for (const [path, words] of cases) {
      const err = (await restore(path).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(words);
      expect(err.message).not.toContain(kit.tmp);
      // Asked again the same day: refused again, and listed once (R157).
      await expect(restore(path)).rejects.toBeInstanceOf(Error);
      const mine = (await libraryRefusals()).filter((e) => detailsOf(e).file === basename(path));
      expect(mine).toHaveLength(1);
      expect(mine[0]!.decision).toEqual({ result: "deny", reason: err.message });
      expect(mine[0]!.details).toMatchObject({ op: "project.restore", notABackup: true, file: basename(path), backupSha256: sha(await readFile(path)), sha256Covers: "the whole file" });
      expect(JSON.stringify(mine[0])).not.toContain(kit.tmp);
    }
    // A file that is not there at all: a plain refusal, recorded by its name; there is nothing to hash.
    const missing = (await restore(join(kit.tmp, "never existed.zip")).catch((e: unknown) => e)) as Error;
    expect(missing).toBeInstanceOf(RestoreError);
    expect(missing.message).not.toContain(kit.tmp);
    const [gone] = (await libraryRefusals()).filter((e) => detailsOf(e).file === "never existed.zip");
    expect(gone!.details).toMatchObject({ op: "project.restore", notABackup: true, sha256Covers: "nothing: the file could not be read" });
    expect(gone!.details).not.toHaveProperty("backupSha256");
    await expectNothingRestored(folders, [p.id]);
    // The project's own log is not where these go: the file is no backup of any project here.
    expect((await eventsOf(p.id)).length).toBe(count);
    expect((await kit.repo.libraryAudit()).verify.ok).toBe(true);
  });

  it("a copy of a backup kept elsewhere is restored holding the maintenance lock of the project it is a backup of", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Elsewhere Copy");
    await addSource(kit, p, { title: "x" });
    const b = await backupProject(kit.repo, p.id);
    const copy = join(kit.tmp, "kept elsewhere.zip");
    await writeFile(copy, await readFile(b.path));
    let finished = false;
    let pass: Promise<unknown> = Promise.resolve();
    await withProjectMaintenance(kit.repo, p.id, async () => {
      // As if the project were being backed up, pruned or having raw data destroyed.
      pass = restore(copy).then(() => {
        finished = true;
      });
      await new Promise((r) => setTimeout(r, 1500));
      expect(finished).toBe(false);
      expect(ids()).toEqual([p.id]);
    });
    await pass;
    expect(finished).toBe(true);
    expect(ids()).toHaveLength(2);
  });

  describe("the project the backup was made from is in this library: the rules it has now must allow the restore too", () => {
    const NOW_REASON = "The project would be restored into the library's folder, which is on this computer's disk. The rule on where data may live that the original project has now does not allow its data there. Restore the backup into another library on storage that rule allows, or allow this kind of storage in the original project's rules.";
    async function tighten(p: Project, yaml: string): Promise<void> {
      const g = await kit.repo.getGovernance(p.id);
      await kit.repo.setGovernance(p.id, yaml, { baseSha256: g.sha256 });
    }

    it("rules tightened after the backup was made (the library's place no longer allowed): refused, the reason says whose rules, audited in that project's log", async () => {
      const p = await makeProject(kit, OPEN_GOV, false, "Tightened");
      await addSource(kit, p, { title: "x" });
      const b = await backupProject(kit.repo, p.id, { locationEnv: onDisk() });
      await tighten(p, `${OPEN_GOV}residency:\n  allowed: [removable]\n`);
      const folders = await projectFolders();
      const err = (await restore(b.path, { locationEnv: onDisk() }).catch((e: unknown) => e)) as PolicyDeniedError;
      expect(err).toBeInstanceOf(PolicyDeniedError);
      expect(err.reason).toBe(NOW_REASON);
      await expectNothingRestored(folders, [p.id]);
      const denied = await refusalsIn(p.id);
      expect(denied).toHaveLength(1);
      expect(denied[0]!.decision).toEqual({ result: "deny", reason: NOW_REASON });
      expect(denied[0]!.details).toMatchObject({ op: "project.restore", at: "decision" });
    });

    it("rules tightened while the backup was being unpacked: decided again in the commit turn against the governance then in force (R138 c); the refusal is audited and nothing is restored", async () => {
      const p = await makeProject(kit, OPEN_GOV, false, "Tightened Meanwhile");
      await addSource(kit, p, { title: "x" });
      const b = await backupProject(kit.repo, p.id, { locationEnv: onDisk() });
      const folders = await projectFolders();
      let staged = "";
      seamsOfRestore.beforeAdopt = async (staging) => {
        staged = staging;
        // An ordinary change, which a restore does not hold up.
        await tighten(p, `${OPEN_GOV}residency:\n  allowed: [removable]\n`);
      };
      const err = (await restore(b.path, { locationEnv: onDisk() }).catch((e: unknown) => e)) as PolicyDeniedError;
      expect(err).toBeInstanceOf(PolicyDeniedError);
      expect(err.reason).toBe(NOW_REASON);
      expect(staged).not.toBe("");
      expect(existsSync(staged)).toBe(false);
      await expectNothingRestored(folders, [p.id]);
      const denied = await refusalsIn(p.id);
      expect(denied).toHaveLength(1);
      expect(denied[0]!.details).toMatchObject({ op: "project.restore", backupSha256: b.sha256, at: "commit" });
    });

    it("its rules cannot be read now: refused (fail closed), without a path in the reason", async () => {
      const p = await makeProject(kit, OPEN_GOV, false, "Unreadable Now");
      const b = await backupProject(kit.repo, p.id);
      await writeFile(join(kit.lib.root, p.folder, "governance.yaml"), "identifiability: [unclosed\n  nope: {");
      const folders = await projectFolders();
      const err = (await restore(b.path).catch((e: unknown) => e)) as PolicyDeniedError;
      expect(err).toBeInstanceOf(PolicyDeniedError);
      expect(err.reason).toMatch(/^Policy could not be evaluated: the rules the original project has now cannot be read/u);
      // Which rules, and the two ways out (R179).
      expect(err.reason).toMatch(/Repair that project's rules in the governance editor, or restore this backup into another library\.$/u);
      expect(err.reason).not.toContain(kit.tmp);
      await expectNothingRestored(folders, [p.id]);
      expect(await refusalsIn(p.id)).toHaveLength(1);

      await rm(join(kit.lib.root, p.folder, "governance.yaml"));
      await expect(restore(b.path)).rejects.toMatchObject({ reason: expect.stringMatching(/^Policy could not be evaluated: the rules the original project has now cannot be read/u) });
      await expectNothingRestored(folders, [p.id]);
    });

    it("its rules now require encryption at rest (the file was edited outside the app) and the project in the backup is not encrypted: refused", async () => {
      const p = await makeProject(kit, OPEN_GOV, false, "Required Now");
      const b = await backupProject(kit.repo, p.id);
      await writeFile(join(kit.lib.root, p.folder, "governance.yaml"), OPEN_GOV.replace("atRest: optional", "atRest: required"));
      const folders = await projectFolders();
      const err = (await restore(b.path).catch((e: unknown) => e)) as PolicyDeniedError;
      expect(err).toBeInstanceOf(PolicyDeniedError);
      expect(err.reason).toMatch(/the original project has now require encryption at rest/u);
      expect(err.reason).toMatch(/Restore the backup into another library, or change that rule in the original project's rules\.$/u);
      await expectNothingRestored(folders, [p.id]);
    });

    it("the backup's own, older rules exclude the library's present place although the original's rules allow it: refused by the backup's own rule, with the way out", async () => {
      const p = await makeProject(kit, OPEN_GOV, false, "Older Rules");
      const b = await backupProject(kit.repo, p.id, { locationEnv: onDisk() });
      // The backup as it would be had it been made while the project's rules allowed removable drives only.
      const older = await craft(b, { "governance.yaml": `${OPEN_GOV}residency:\n  allowed: [removable]\n` }, "older rules.zip");
      const folders = await projectFolders();
      const err = (await restore(older, { locationEnv: onDisk() }).catch((e: unknown) => e)) as PolicyDeniedError;
      expect(err).toBeInstanceOf(PolicyDeniedError);
      expect(err.reason).toBe(
        "The project would be restored into the library's folder, which is on this computer's disk. The rule on where data may live in this backup's own rules does not allow its data there. Restore the backup into another library, on storage that rule allows.",
      );
      await expectNothingRestored(folders, [p.id]);
    });
  });

  it("decided again in the commit turn, against the rules that would go live: a refusal there is audited, and nothing is restored", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Changed Meanwhile");
    await addSource(kit, p, { title: "x" });
    const b = await backupProject(kit.repo, p.id);
    const folders = await projectFolders();
    let staged = "";
    seamsOfRestore.beforeAdopt = async (staging) => {
      // Between unpacking and the commit: the rules that would go live now require encryption.
      staged = staging;
      await writeFile(join(staging, "governance.yaml"), OPEN_GOV.replace("atRest: optional", "atRest: required"));
    };
    const err = (await restore(b.path).catch((e: unknown) => e)) as PolicyDeniedError;
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect(err.reason).toMatch(/require encryption at rest/u);
    expect(staged).not.toBe("");
    expect(existsSync(staged)).toBe(false);
    await expectNothingRestored(folders, [p.id]);
    const denied = await refusalsIn(p.id);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.decision).toEqual({ result: "deny", reason: err.reason });
    expect(denied[0]!.details).toMatchObject({ op: "project.restore", backupSha256: b.sha256, at: "commit" });
  });
});

// ------------------------------------------------------------------------------------------
interface Scene {
  p: Project;
  raw: SourceFile;
  kept: SourceFile;
  /** The backup made before the destruction, as a copy kept outside the library. */
  offline: string;
  r: DestroyResult;
}

/** A project with a raw file and a paper, backed up at 09:59; a copy of that backup is kept elsewhere; with `destroy`, the raw file is destroyed at 10:00. */
async function scene(opts: { destroy?: boolean; name?: string } = {}): Promise<Scene> {
  const p = await makeProject(kit, RETAIN, false, opts.name ?? "Origin");
  const raw = await rawSource(p);
  const kept = await keptSource(p);
  at("2026-12-02T09:59:00.000Z");
  const b = await backupProject(kit.repo, p.id);
  const offline = join(kit.tmp, `${opts.name ?? "Origin"} offline copy.zip`);
  await writeFile(offline, await readFile(b.path));
  at("2026-12-02T10:00:00.000Z");
  const r = opts.destroy === false ? (undefined as unknown as DestroyResult) : await destroyRaw(kit.repo, p.id, [raw.assets[0]!.id], "tester");
  return { p, raw, kept, offline, r };
}

/** What the restore says of one file left out only because records the app cannot vouch for name it (R182 d): never that it was destroyed. */
const UNVERIFIED_ONE = "1 file was left out because unverified records name it as destroyed; the app cannot confirm that it was destroyed.";

/**
 * The raw file was left out and marked destroyed; the paper came back. `on`: a verified record (it
 * was destroyed), or records the app cannot vouch for, which is said and counted apart (R182 d).
 */
async function expectRawLeftOut(r: Restored, on: "verified" | "unverified" = "verified"): Promise<void> {
  const files = await restoredFiles(r.projectId);
  expect(files["Interview one"]).toMatchObject({ status: "destroyed", onDisk: false });
  expect(files["Kept paper"]!.onDisk).toBe(true);
  expect(files["Kept paper"]!.status).not.toBe("destroyed");
  const entry = { sourceId: files["Interview one"]!.sourceId, assetId: files["Interview one"]!.assetId, destroyedAt: "2026-12-02T10:00:00.000Z" };
  const details = detailsOf((await eventsOf(r.projectId)).at(-1)!);
  expect(details.op).toBe("project.restore");
  if (on === "verified") {
    expect(r.notes[0]).toBe("1 file was destroyed earlier under a retention rule and was not restored.");
    expect(r.leftOut).toEqual([entry]);
    expect(details).toMatchObject({ leftOutDestroyed: 1 });
    expect(details).not.toHaveProperty("leftOutUnverified");
  } else {
    expect(r.notes[0]).toBe(UNVERIFIED_ONE);
    expect(r.notes.join(" ")).not.toMatch(/destroyed earlier under a retention rule/u);
    expect(r.leftOut).toEqual([{ ...entry, unverified: true }]);
    expect(details).toMatchObject({ leftOutUnverified: 1 });
    expect(details).not.toHaveProperty("leftOutDestroyed");
  }
}

/** Rewrites the project's audit log on disk with `edit` applied to each entry and the chain made whole again (one segment). */
async function rewriteAudit(p: Project, edit: (e: AuditEvent) => void): Promise<void> {
  const dir = join(kit.lib.root, kit.repo.getProject(p.id).folder, "audit");
  const names = (await readdir(dir)).sort();
  expect(names).toHaveLength(1);
  const events = (await readFile(join(dir, names[0]!), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as AuditEvent);
  let prev: { seq: number; hash: string } | null = null;
  const lines = events.map((e) => {
    edit(e);
    const { seq: _s, hash: _h, prevHash: _p, ...rest } = e;
    const sealed = sealEvent(rest, prev);
    prev = { seq: sealed.seq, hash: sealed.hash };
    return JSON.stringify(sealed);
  });
  await writeFile(join(dir, names[0]!), `${lines.join("\n")}\n`);
}

/** Changes one entry of the project's audit log on disk (not the last): the chain no longer verifies. Returns how to put it back. */
async function breakAudit(p: Project, pick: (line: string) => boolean): Promise<() => Promise<void>> {
  const dir = join(kit.lib.root, kit.repo.getProject(p.id).folder, "audit");
  const segment = join(dir, (await readdir(dir)).sort().at(-1)!);
  const lines = (await readFile(segment, "utf8")).split("\n");
  const i = lines.findIndex(pick);
  expect(i).toBeGreaterThan(-1);
  expect(i).toBeLessThan(lines.filter((l) => l.trim()).length - 1);
  const original = lines[i]!;
  const e = JSON.parse(original) as { details: Record<string, unknown> };
  e.details = { ...e.details, changedOutside: true };
  lines[i] = JSON.stringify(e);
  await writeFile(segment, lines.join("\n"));
  expect(verifyChain(await auditEvents(kit, p)).ok).toBe(false);
  return async () => {
    const now = (await readFile(segment, "utf8")).split("\n");
    now[i] = original;
    await writeFile(segment, now.join("\n"));
  };
}

describe("3. what a restore does not bring back is read from the audit log's record of destructions", () => {
  it("a backup made before a destruction: the destroyed file does not come back, and the restore says what it left out and why", async () => {
    const s = await scene();
    // What the destruction's own audit entry says was destroyed.
    const commit = (await eventsOf(s.p.id)).find((e) => e.action === "delete" && detailsOf(e).op === "retention.destroy")!;
    expect(detailsOf(commit).destroyedAssets).toEqual([s.raw.assets[0]!.id]);
    const r = await restore(s.offline);
    await expectRawLeftOut(r);
    expect(r.notes).toHaveLength(1);
  });

  it("the same with the certificate file deleted: the file still does not come back", async () => {
    const s = await scene();
    await rm(s.r.certificatePath);
    const r = await restore(s.offline);
    await expectRawLeftOut(r);
    // It says where the knowledge came from, without a path.
    expect(r.notes.join(" ")).toMatch(/certificate/u);
    expect(r.notes.join(" ")).toMatch(/audit log/u);
    expect(r.notes.join(" ")).not.toContain(kit.tmp);
  });

  it("the same with the certificate edited to name nothing, or to name the kept file in place of the destroyed one", async () => {
    const s = await scene();
    const cert = JSON.parse(await readFile(s.r.certificatePath, "utf8")) as { assets: Array<Record<string, unknown>> };
    await writeFile(s.r.certificatePath, `${JSON.stringify({ ...cert, assets: [] }, null, 2)}\n`);
    await expectRawLeftOut(await restore(s.offline));
    await writeFile(
      s.r.certificatePath,
      `${JSON.stringify({ ...cert, assets: [{ ...cert.assets[0], assetId: s.kept.assets[0]!.id, sha256: s.kept.assets[0]!.sha256 }] }, null, 2)}\n`,
    );
    await expectRawLeftOut(await restore(s.offline));
  });

  it("a forged extra certificate that names a file never destroyed: that file comes back, and the restore says the certificate was not taken into account", async () => {
    const s = await scene();
    const forged = join(kit.lib.root, kit.repo.getProject(s.p.id).folder, "retention", "destruction-2026-12-03 1000.json");
    await writeFile(
      forged,
      `${JSON.stringify({ formatVersion: 1, kind: "destruction-certificate", projectId: s.p.id, at: "2026-12-03T10:00:00.000Z", assets: [{ assetId: s.kept.assets[0]!.id, sha256: s.kept.assets[0]!.sha256 }] }, null, 2)}\n`,
    );
    const r = await restore(s.offline);
    await expectRawLeftOut(r);
    expect(r.notes.join(" ")).toMatch(/destruction-2026-12-03 1000\.json/u);
    expect(r.notes.join(" ")).toMatch(/not recorded/u);
    expect(r.notes.join(" ")).not.toContain(kit.tmp);
  });

  it("a destruction in a project restored from the same data is honoured by what its certificate says (the same file under other ids)", async () => {
    const s = await scene({ destroy: false });
    const copy = await restore(s.offline);
    const mine = await restoredFiles(copy.projectId);
    expect(mine["Interview one"]!.onDisk).toBe(true);
    await destroyRaw(kit.repo, copy.projectId, [mine["Interview one"]!.assetId], "tester");
    const again = await restore(s.offline);
    const files = await restoredFiles(again.projectId);
    expect(files["Interview one"]).toMatchObject({ status: "destroyed", onDisk: false });
    expect(files["Kept paper"]!.onDisk).toBe(true);
  });

  it("the original is gone from the library: a copy that inherited its audit log still keeps the destroyed file out of an older backup of the original, with the copy's certificate deleted too", async () => {
    const s = await scene();
    const fresh = abs((s.r.certificate.backups as { freshBackup: string }).freshBackup);
    const copy = await restore(fresh);
    // Outside the app the original's folder is removed, and so is the certificate the copy kept.
    await rm(join(kit.lib.root, s.p.folder), { recursive: true, force: true });
    await rm(join(kit.lib.root, kit.repo.getProject(copy.projectId).folder, "retention", basename(s.r.certificatePath)));
    await kit.reopen();
    expect(ids()).toEqual([copy.projectId]);
    // The copy's log holds the original's destruction entry, which names the destroyed asset by the id the old backup holds.
    await expectRawLeftOut(await restore(s.offline));
  });

  it("a destruction recorded between unpacking and the commit is seen in the commit turn", async () => {
    const s = await scene({ destroy: false });
    const copy = await restore(s.offline);
    const mine = await restoredFiles(copy.projectId);
    seamsOfRestore.beforeAdopt = async () => {
      seamsOfRestore.beforeAdopt = undefined;
      // In the copy made earlier (its own maintenance lock): the same file, destroyed now.
      await destroyRaw(kit.repo, copy.projectId, [mine["Interview one"]!.assetId], "tester");
    };
    const again = await restore(s.offline);
    const files = await restoredFiles(again.projectId);
    expect(files["Interview one"]).toMatchObject({ status: "destroyed", onDisk: false });
    expect(files["Kept paper"]!.onDisk).toBe(true);
  });

  it("an audit log that does not hold together: the restore is refused in plain words, nothing is written, and the refusal is recorded in the library's log", async () => {
    const s = await scene();
    await breakAudit(s.p, (l) => l.includes('"op":"retention.destroy"'));
    const folders = await projectFolders();
    const count = (await eventsOf(s.p.id)).length;
    let spaceAsked = false;
    backupSeams.freeBytes = async () => {
      spaceAsked = true;
      return Number.MAX_SAFE_INTEGER;
    };
    const err = (await restore(s.offline).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(RestoreError);
    expect(err).toBeInstanceOf(DestructionRecordError);
    expect(err.message).toMatch(/audit log of the project "Origin" does not hold together/u);
    expect(err.message).toMatch(/[Nn]othing was restored/u);
    // The backup belongs to that project, and the way out is named (R179).
    expect(err.message).toMatch(/This backup belongs to that project/u);
    expect(err.message).toMatch(/can be restored into another library/u);
    expect(err.message).not.toContain(kit.tmp);
    expect(spaceAsked).toBe(false);
    await expectNothingRestored(folders, [s.p.id]);
    // Never into the log that does not hold together.
    expect((await eventsOf(s.p.id)).length).toBe(count);
    const denied = await libraryRefusals();
    expect(denied).toHaveLength(1);
    expect(denied[0]!.decision).toEqual({ result: "deny", reason: err.message });
    expect(denied[0]!.details).toMatchObject({ op: "project.restore", name: "Origin", backupSha256: sha(await readFile(s.offline)) });

    // The same after a restart (the open reports the log, and the restore still does not guess).
    await kit.reopen();
    await expect(restore(s.offline)).rejects.toBeInstanceOf(RestoreError);
    await expectNothingRestored(folders, [s.p.id]);
  });

  it("the log holds again: the restore goes ahead and leaves the destroyed file out", async () => {
    const s = await scene();
    const putBack = await breakAudit(s.p, (l) => l.includes('"op":"retention.destroy"'));
    await expect(restore(s.offline)).rejects.toBeInstanceOf(RestoreError);
    await putBack();
    await expectRawLeftOut(await restore(s.offline));
  });

  it("an entry added to a project's audit log outside the app while it runs: refused (the log is not as the app left it), whatever the entry says", async () => {
    const s = await scene({ destroy: false });
    const dir = join(kit.lib.root, kit.repo.getProject(s.p.id).folder, "audit");
    const events = await eventsOf(s.p.id);
    const head = events.at(-1)!;
    // Correctly chained, naming the kept paper as destroyed.
    const forged = sealEvent(
      {
        at: "2026-12-02T10:30:00.000Z",
        actor: "tester",
        device: "dev-A",
        projectId: s.p.id,
        action: "delete",
        entity: { type: "project", id: s.p.id },
        decision: { result: "allow" },
        details: { op: "retention.destroy", certificate: "destruction-2026-12-02 1030.json", certificateSha256: sha("forged"), backupsToRemove: [], backupsUnreadable: [], destroyedAssets: [s.kept.assets[0]!.id] },
      },
      { seq: head.seq, hash: head.hash },
    );
    await appendFile(join(dir, (await readdir(dir)).sort().at(-1)!), `${JSON.stringify(forged)}\n`);
    const folders = await projectFolders();
    const err = (await restore(s.offline).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toMatch(/audit log of the project "Origin"/u);
    await expectNothingRestored(folders, [s.p.id]);
  });

  describe("R179: another project's audit log does not hold together (the backup's own project's does)", () => {
    interface Bystander {
      s: Scene;
      z: Project;
      /** The bystander's destruction of a file with the same bytes as the raw file in the backup. */
      zr: DestroyResult;
    }
    /** Project "Origin" with its backup kept elsewhere (nothing destroyed in it), and an unrelated project that destroyed the same file and whose audit log was then changed outside the app. */
    async function bystander(): Promise<Bystander> {
      const z = await makeProject(kit, RETAIN, false, "Bystander");
      const zRaw = await rawSource(z); // the same bytes as Origin's raw file: another copy of the same recording
      await addSource(kit, z, { title: "something else" });
      const s = await scene({ destroy: false });
      backupSeams.failBackup = true; // the bystander has no backups, and makes none
      const zr = await destroyRaw(kit.repo, z.id, [zRaw.assets[0]!.id], "tester");
      backupSeams.failBackup = false;
      await breakAudit(z, (l) => l.includes('"op":"retention.destroy"'));
      return { s, z, zr };
    }
    const notVerified = async (projectId: string) => (detailsOf((await eventsOf(projectId)).at(-1)!).destructionsNotVerified ?? []) as Array<Record<string, unknown>>;

    it("the restore is not refused; a file the bystander's certificate names as destroyed is left out, and the notes and the audit entry say that the log did not verify and what the exclusion rests on", async () => {
      const { s, z } = await bystander();
      const r = await restore(s.offline);
      const files = await restoredFiles(r.projectId);
      expect(files["Interview one"]).toMatchObject({ status: "destroyed", onDisk: false });
      expect(files["Kept paper"]!.onDisk).toBe(true);
      expect(r.leftOut).toHaveLength(1);
      // Not said to have been destroyed: the only ground is evidence nothing vouches for (R182 d).
      expect(r.leftOut[0]).toMatchObject({ unverified: true });
      expect(r.notes[0]).toBe(UNVERIFIED_ONE);
      const said = r.notes.join(" ");
      expect(said).not.toMatch(/destroyed earlier under a retention rule/u);
      expect(said).toMatch(/audit log of the project "Bystander" does not hold together/u);
      // Both kinds of evidence were there to read, and neither is vouched for (fix round 1, ruling 2).
      expect(said).toMatch(/rests on the destruction entries that can still be read in its audit log and its certificate files/u);
      expect(said).toMatch(/1 file of this backup/u);
      expect(said).not.toContain(kit.tmp);
      expect(await notVerified(r.projectId)).toEqual([{ projectId: z.id, basis: "unverified-log-and-certificate-files", leftOut: 1 }]);
      expect(detailsOf((await eventsOf(r.projectId)).at(-1)!)).toMatchObject({ op: "project.restore", leftOutUnverified: 1 });
      expect(detailsOf((await eventsOf(r.projectId)).at(-1)!)).not.toHaveProperty("leftOutDestroyed");
      // Nothing was refused, so nothing is recorded as refused.
      expect(await libraryRefusals()).toEqual([]);
      expect(await refusalsIn(s.p.id)).toEqual([]);
    });

    it("unverified evidence still excludes: whatever that project's certificate files name is left out, also after they were edited", async () => {
      const { s, zr } = await bystander();
      const cert = JSON.parse(await readFile(zr.certificatePath, "utf8")) as { assets: Array<Record<string, unknown>> };
      await writeFile(zr.certificatePath, `${JSON.stringify({ ...cert, assets: [...cert.assets, { assetId: "someone-else", sha256: s.kept.assets[0]!.sha256 }] }, null, 2)}\n`);
      const r = await restore(s.offline);
      const files = await restoredFiles(r.projectId);
      expect(files["Interview one"]).toMatchObject({ status: "destroyed", onDisk: false });
      expect(files["Kept paper"]).toMatchObject({ status: "destroyed", onDisk: false });
      expect(r.notes.join(" ")).toMatch(/2 files of this backup/u);
    });

    it("with that project's certificate deleted as well: the restore goes ahead on the destruction entries that can still be read in its log, which name no file of this backup (the bystander's copy had another id), and says so", async () => {
      const { s, z, zr } = await bystander();
      await rm(zr.certificatePath);
      const r = await restore(s.offline);
      const files = await restoredFiles(r.projectId);
      expect(files["Interview one"]!.onDisk).toBe(true);
      expect(files["Kept paper"]!.onDisk).toBe(true);
      expect(r.leftOut).toEqual([]);
      const said = r.notes.join(" ");
      expect(said).toMatch(/audit log of the project "Bystander" does not hold together/u);
      expect(said).toMatch(/rests on the destruction entries that can still be read in its audit log \(no certificate file of it could be read\)/u);
      expect(said).toMatch(/they name no file of this backup, so nothing was left out/u);
      expect(await notVerified(r.projectId)).toEqual([{ projectId: z.id, basis: "unverified-log-entries", leftOut: 0 }]);
    });

    it("fix round 1, ruling 2: the certificate gone and the log not verifying, but its destruction entry still names the file: the file stays out, and the notes say why", async () => {
      // The reviewer's probe: the original destroyed the raw file; a copy restored from its fresh backup inherits that entry.
      const s = await scene();
      const fresh = abs((s.r.certificate.backups as { freshBackup: string }).freshBackup);
      const copy = await restore(fresh);
      const c = kit.repo.getProject(copy.projectId);
      // Outside the app: the original's folder is removed, the certificate the copy kept is deleted, and the copy's log is changed.
      await rm(join(kit.lib.root, s.p.folder), { recursive: true, force: true });
      await rm(join(kit.lib.root, c.folder, "retention", basename(s.r.certificatePath)));
      await kit.reopen();
      expect(ids()).toEqual([c.id]);
      await breakAudit(c, (l) => l.includes('"op":"retention.destroy"'));
      const r = await restore(s.offline);
      const files = await restoredFiles(r.projectId);
      expect(files["Interview one"]).toMatchObject({ status: "destroyed", onDisk: false });
      expect(files["Kept paper"]!.onDisk).toBe(true);
      expect(r.leftOut).toEqual([{ sourceId: files["Interview one"]!.sourceId, assetId: files["Interview one"]!.assetId, destroyedAt: "2026-12-02T10:00:00.000Z", unverified: true }]);
      expect(r.notes[0]).toBe(UNVERIFIED_ONE);
      const said = r.notes.join(" ");
      expect(said).toMatch(/audit log of the project "Origin \(restored 2026-12-02\)" does not hold together/u);
      expect(said).toMatch(/cannot vouch for what that project destroyed/u);
      expect(said).toMatch(/rests on the destruction entries that can still be read in its audit log \(no certificate file of it could be read\)/u);
      expect(said).toMatch(/1 file of this backup that they name as destroyed was left out/u);
      expect(said).not.toContain(kit.tmp);
      expect(await notVerified(r.projectId)).toEqual([{ projectId: c.id, basis: "unverified-log-entries", leftOut: 1 }]);
      expect(detailsOf((await eventsOf(r.projectId)).at(-1)!)).toMatchObject({ op: "project.restore", leftOutUnverified: 1 });
      expect(await libraryRefusals()).toEqual([]);
    });

    it("fix round 2 (R182 c, N1): the log cut right after an intact destruction entry, with no final newline: that last line is read as evidence like any other, and the file stays out", async () => {
      const s = await scene();
      const fresh = abs((s.r.certificate.backups as { freshBackup: string }).freshBackup);
      const copy = await restore(fresh);
      const c = kit.repo.getProject(copy.projectId);
      await rm(join(kit.lib.root, s.p.folder), { recursive: true, force: true });
      await rm(join(kit.lib.root, c.folder, "retention", basename(s.r.certificatePath)));
      await kit.reopen();
      expect(ids()).toEqual([c.id]);
      // Outside the app, while it runs: everything after the destruction entry is cut off, its own line end included.
      const dir = join(kit.lib.root, c.folder, "audit");
      const segment = join(dir, (await readdir(dir)).sort().at(-1)!);
      const lines = (await readFile(segment, "utf8")).split("\n");
      const i = lines.findIndex((l) => l.includes('"op":"retention.destroy"') && l.includes('"destroyedAssets"'));
      expect(i).toBeGreaterThan(-1);
      expect(i).toBeLessThan(lines.filter((l) => l.trim()).length - 1);
      await writeFile(segment, lines.slice(0, i + 1).join("\n"));
      expect((await readFile(segment, "utf8")).endsWith("\n")).toBe(false);
      const r = await restore(s.offline);
      const files = await restoredFiles(r.projectId);
      expect(files["Interview one"]).toMatchObject({ status: "destroyed", onDisk: false });
      expect(files["Kept paper"]!.onDisk).toBe(true);
      expect(r.notes.join(" ")).toMatch(/rests on the destruction entries that can still be read in its audit log/u);
      expect(await notVerified(r.projectId)).toEqual([{ projectId: c.id, basis: "unverified-log-entries", leftOut: 1 }]);
      // The audit store's own reading of an incomplete last line is as it was: this is the evidence reading only.
      expect(await AuditStore.read(dir)).toHaveLength(i);
    });

    it("fix round 1, ruling 2: a log so damaged that no entry can be read: the restore goes ahead on the certificate files alone; with those gone too it says it could not establish that project's destructions at all", async () => {
      const { s, z, zr } = await bystander();
      const dir = join(kit.lib.root, kit.repo.getProject(z.id).folder, "audit");
      for (const n of await readdir(dir)) await writeFile(join(dir, n), "\u0000\u0001 not a line of the log\n{ nor this\n");
      const r = await restore(s.offline);
      expect((await restoredFiles(r.projectId))["Interview one"]).toMatchObject({ status: "destroyed", onDisk: false });
      expect(r.notes.join(" ")).toMatch(/rests on its certificate files alone \(no destruction entry that names files could be read in its audit log\)/u);
      expect(await notVerified(r.projectId)).toEqual([{ projectId: z.id, basis: "certificate-files-alone", leftOut: 1 }]);

      await rm(zr.certificatePath);
      const again = await restore(s.offline);
      const files = await restoredFiles(again.projectId);
      expect(files["Interview one"]!.onDisk).toBe(true);
      expect(files["Kept paper"]!.onDisk).toBe(true);
      expect(again.leftOut).toEqual([]);
      const said = again.notes.join(" ");
      expect(said).toMatch(/audit log of the project "Bystander" does not hold together/u);
      expect(said).toMatch(/[Nn]either a destruction entry in its audit log nor a destruction certificate could be read/u);
      expect(said).toMatch(/could not be established at all/u);
      expect(await notVerified(again.projectId)).toEqual([{ projectId: z.id, basis: "nothing-could-be-read", leftOut: 0 }]);
      expect(await libraryRefusals()).toEqual([]);
    });

    it("another project's destruction recorded without its files (the earlier form of the entry), its certificate not verifying: not refused; the certificate as found still excludes, and it is said", async () => {
      const z = await makeProject(kit, RETAIN, false, "Earlier Form");
      const zRaw = await rawSource(z);
      const s = await scene({ destroy: false });
      backupSeams.failBackup = true;
      const zr = await destroyRaw(kit.repo, z.id, [zRaw.assets[0]!.id], "tester");
      backupSeams.failBackup = false;
      await rewriteAudit(z, (e) => {
        if (e.action === "delete" && detailsOf(e).op === "retention.destroy") delete (e.details as Details).destroyedAssets;
      });
      await kit.reopen();
      expect(verifyChain(await eventsOf(z.id)).ok).toBe(true);
      // Changed on disk: it no longer is the file the entry recorded, but it still names the file.
      const cert = JSON.parse(await readFile(zr.certificatePath, "utf8")) as Record<string, unknown>;
      await writeFile(zr.certificatePath, `${JSON.stringify({ ...cert, edited: true }, null, 2)}\n`);
      const r = await restore(s.offline);
      expect((await restoredFiles(r.projectId))["Interview one"]).toMatchObject({ status: "destroyed", onDisk: false });
      expect(r.notes.join(" ")).toMatch(/project "Earlier Form" records a destruction of raw data .* without naming the files/u);
      expect(r.notes.join(" ")).toMatch(/certificate file alone/u);
      expect(await notVerified(r.projectId)).toEqual([{ projectId: z.id, certificate: basename(zr.certificatePath), basis: "certificate-files-alone", leftOut: 1 }]);

      await rm(zr.certificatePath);
      const again = await restore(s.offline);
      expect((await restoredFiles(again.projectId))["Interview one"]!.onDisk).toBe(true);
      expect(again.notes.join(" ")).toMatch(/could not be established at all/u);
      expect(await notVerified(again.projectId)).toEqual([{ projectId: z.id, certificate: basename(zr.certificatePath), basis: "nothing-could-be-read", leftOut: 0 }]);
    });

    it("every audit log holds together: nothing of this is said or recorded", async () => {
      const s = await scene();
      const r = await restore(s.offline);
      await expectRawLeftOut(r);
      expect(r.notes).toHaveLength(1);
      expect(detailsOf((await eventsOf(r.projectId)).at(-1)!)).not.toHaveProperty("destructionsNotVerified");
    });
  });

  describe("fix round 1, ruling 3: a project folder that is there but cannot be loaded still counts as evidence", () => {
    const notVerified = async (projectId: string) => (detailsOf((await eventsOf(projectId)).at(-1)!).destructionsNotVerified ?? []) as Array<Record<string, unknown>>;

    it("project.json removed from the original's folder, its audit log intact: the restore is not refused, the destroyed file stays out, and the notes and the audit entry say the folder could not be loaded", async () => {
      const s = await scene();
      await rm(join(kit.lib.root, s.p.folder, "project.json"));
      await kit.reopen();
      expect(ids()).toEqual([]);
      const r = await restore(s.offline);
      await expectRawLeftOut(r, "unverified");
      const said = r.notes.join(" ");
      expect(said).toMatch(/project folder "Origin" could not be loaded \(its project\.json is missing or cannot be read\)/u);
      expect(said).toMatch(/cannot vouch for what that project destroyed/u);
      expect(said).toMatch(/rests on the destruction entries that can still be read in its audit log and its certificate files/u);
      expect(said).toMatch(/1 file of this backup that they name as destroyed was left out/u);
      expect(said).not.toContain(kit.tmp);
      expect(await notVerified(r.projectId)).toEqual([{ folder: "Origin", notLoaded: true, basis: "unverified-log-and-certificate-files", leftOut: 1 }]);
      // Not refused: such a folder may be the very project that is being recovered.
      expect(await libraryRefusals()).toEqual([]);
    });

    it("the folder's audit log cannot be read either: its certificate file still keeps the file out; with that gone too the restore says it could not establish what the folder's project destroyed", async () => {
      const s = await scene();
      await rm(join(kit.lib.root, s.p.folder, "project.json"));
      const dir = join(kit.lib.root, s.p.folder, "audit");
      for (const n of await readdir(dir)) await writeFile(join(dir, n), "\u0000\u0001 not a line of the log\n{ nor this\n");
      await kit.reopen();
      expect(ids()).toEqual([]);
      const r = await restore(s.offline);
      await expectRawLeftOut(r, "unverified");
      expect(r.notes.join(" ")).toMatch(/project folder "Origin" could not be loaded/u);
      expect(r.notes.join(" ")).toMatch(/rests on its certificate files alone/u);
      expect(await notVerified(r.projectId)).toEqual([{ folder: "Origin", notLoaded: true, basis: "certificate-files-alone", leftOut: 1 }]);

      await rm(s.r.certificatePath);
      const again = await restore(s.offline);
      const files = await restoredFiles(again.projectId);
      expect(files["Interview one"]!.onDisk).toBe(true);
      expect(again.leftOut).toEqual([]);
      const said = again.notes.join(" ");
      expect(said).toMatch(/project folder "Origin" could not be loaded/u);
      expect(said).toMatch(/could not be established at all/u);
      expect(said).not.toContain(kit.tmp);
      expect(await notVerified(again.projectId)).toContainEqual({ folder: "Origin", notLoaded: true, basis: "nothing-could-be-read", leftOut: 0 });
    });

    /** Planted outside the app: a folder that is no project, with something shaped like an audit log that names an asset as destroyed. */
    async function plantFolder(name: string, assetId: string): Promise<void> {
      const dir = join(kit.lib.root, "Projects", name, "audit");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "0001.jsonl"), `${JSON.stringify({ seq: 1, at: "2026-12-01T08:00:00.000Z", action: "delete", details: { op: "retention.destroy", destroyedAssets: [assetId] } })}\n`);
    }

    it("fix round 2 (R182 d, N2): a file left out only because a planted folder names it is not said to have been destroyed", async () => {
      const s = await scene({ destroy: false });
      await plantFolder("Junk", s.kept.assets[0]!.id);
      const r = await restore(s.offline);
      const files = await restoredFiles(r.projectId);
      // The accepted direction: unverified evidence keeps a file out, here a file that was never destroyed.
      expect(files["Kept paper"]).toMatchObject({ onDisk: false });
      expect(files["Interview one"]!.onDisk).toBe(true);
      // What is said of it: left out, on what ground; never that it was destroyed.
      expect(r.notes[0]).toBe(UNVERIFIED_ONE);
      expect(r.notes.join(" ")).not.toMatch(/destroyed earlier under a retention rule/u);
      expect(r.notes.join(" ")).toMatch(/project folder "Junk" could not be loaded/u);
      expect(r.leftOut).toEqual([{ sourceId: files["Kept paper"]!.sourceId, assetId: files["Kept paper"]!.assetId, destroyedAt: "2026-12-01T08:00:00.000Z", unverified: true }]);
      const details = detailsOf((await eventsOf(r.projectId)).at(-1)!);
      expect(details).toMatchObject({ op: "project.restore", leftOutUnverified: 1 });
      expect(details).not.toHaveProperty("leftOutDestroyed");
      expect(await notVerified(r.projectId)).toEqual([{ folder: "Junk", notLoaded: true, basis: "unverified-log-entries", leftOut: 1 }]);
    });

    it("fix round 2 (R182 d, N2): one file destroyed on a verified record and one named only by a planted folder are counted and said apart", async () => {
      const s = await scene();
      await plantFolder("Junk", s.kept.assets[0]!.id);
      const r = await restore(s.offline);
      const files = await restoredFiles(r.projectId);
      expect(files["Interview one"]).toMatchObject({ status: "destroyed", onDisk: false });
      expect(files["Kept paper"]).toMatchObject({ onDisk: false });
      expect(r.notes[0]).toBe("1 file was destroyed earlier under a retention rule and was not restored.");
      expect(r.notes[1]).toBe(UNVERIFIED_ONE);
      expect(r.notes[2]).toMatch(/project folder "Junk" could not be loaded/u);
      expect(r.notes).toHaveLength(3);
      expect(r.leftOut).toHaveLength(2);
      expect(r.leftOut).toContainEqual({ sourceId: files["Interview one"]!.sourceId, assetId: files["Interview one"]!.assetId, destroyedAt: "2026-12-02T10:00:00.000Z" });
      expect(r.leftOut).toContainEqual({ sourceId: files["Kept paper"]!.sourceId, assetId: files["Kept paper"]!.assetId, destroyedAt: "2026-12-01T08:00:00.000Z", unverified: true });
      expect(detailsOf((await eventsOf(r.projectId)).at(-1)!)).toMatchObject({ op: "project.restore", leftOutDestroyed: 1, leftOutUnverified: 1 });
    });

    it("a folder in Projects that holds no audit log and no retention records is not a project's remains: nothing is said of it", async () => {
      const s = await scene();
      await mkdir(join(kit.lib.root, "Projects", "Just Some Notes"), { recursive: true });
      await writeFile(join(kit.lib.root, "Projects", "Just Some Notes", "notes.txt"), "not a project");
      const r = await restore(s.offline);
      await expectRawLeftOut(r);
      expect(r.notes).toHaveLength(1);
      expect(detailsOf((await eventsOf(r.projectId)).at(-1)!)).not.toHaveProperty("destructionsNotVerified");
    });
  });

  it("R179: another project's missing certificate, or a certificate there that is not on record, is not mentioned when it has no bearing on this restore", async () => {
    const z = await makeProject(kit, RETAIN, false, "Elsewhere In The Library");
    const zRaw = await rawSource(z, "bytes no other project holds");
    const s = await scene();
    backupSeams.failBackup = true;
    const zr = await destroyRaw(kit.repo, z.id, [zRaw.assets[0]!.id], "tester");
    backupSeams.failBackup = false;
    await rm(zr.certificatePath);
    await writeFile(
      join(kit.lib.root, kit.repo.getProject(z.id).folder, "retention", "destruction-2026-12-03 1000.json"),
      `${JSON.stringify({ at: "2026-12-03T10:00:00.000Z", assets: [{ assetId: "nobody", sha256: sha("nothing this backup holds") }] })}\n`,
    );
    const r = await restore(s.offline);
    await expectRawLeftOut(r);
    // Only what this restore left out, and why.
    expect(r.notes).toHaveLength(1);
  });

  it("R182 (b): another locked project with a recorded destruction does not stop a restore: what it destroyed is in its audit log, readable without its key; its sealed certificate is not read, and the notes and the audit entry say so", async () => {
    const q = await makeProject(kit, RETAIN.replace("atRest: optional", "atRest: required"), true, "Locked One");
    const qRaw = await rawSource(q, "raw bytes of the locked project");
    const s = await scene();
    await destroyRaw(kit.repo, q.id, [qRaw.assets[0]!.id], "tester");
    kit.repo.lockProject(q.id);
    const r = await restore(s.offline);
    await expectRawLeftOut(r);
    expect(r.notes).toEqual([
      "1 file was destroyed earlier under a retention rule and was not restored.",
      'The project "Locked One" is locked, and its destruction certificate is sealed, so it was not read. The files that project destroyed were recognised by the ids its audit log names; the same file kept under another id in this backup could not be recognised. To be sure, unlock that project and restore the backup again.',
    ]);
    expect(detailsOf((await eventsOf(r.projectId)).at(-1)!)).toMatchObject({ destructionCertificatesSealed: [q.id] });
    expect(kit.repo.isUnlocked(q.id)).toBe(false);
  });

  it("what a mark recorded late says (Task 50) is never read as a destruction", async () => {
    const s = await scene({ destroy: false });
    const mark: UnrecordedAudit = {
      formatVersion: 1,
      id: newAttentionId(),
      kind: "audit-unrecorded",
      occurredAt: "2026-12-02T10:31:00.000Z",
      actor: "tester",
      device: "dev-A",
      action: "library.relink",
      details: { op: "retention.destroy", certificate: "destruction-2026-12-02 1031.json", certificateSha256: sha("forged"), backupsToRemove: [], backupsUnreadable: [], destroyedAssets: [s.raw.assets[0]!.id, s.kept.assets[0]!.id] },
      state: "ready",
    };
    await writeAttention(kit.lib.root, kit.repo.getProject(s.p.id).folder, mark);
    await kit.reopen();
    const late = (await eventsOf(s.p.id)).filter((e) => detailsOf(e).recordedLate !== undefined);
    expect(late.map((e) => [e.action, detailsOf(e).op])).toEqual([["library.relink", "retention.destroy"]]);
    const r = await restore(s.offline);
    const files = await restoredFiles(r.projectId);
    expect(files["Interview one"]!.onDisk).toBe(true);
    expect(files["Kept paper"]!.onDisk).toBe(true);
    expect(r.leftOut ?? []).toEqual([]);
  });

  it("a destruction the audit log records without saying which files (an earlier form of the entry): read from its certificate while that verifies; refused when it does not", async () => {
    const s = await scene();
    await rewriteAudit(s.p, (e) => {
      if (e.action === "delete" && detailsOf(e).op === "retention.destroy") delete (e.details as Details).destroyedAssets;
    });
    await kit.reopen();
    expect(verifyChain(await eventsOf(s.p.id)).ok).toBe(true);
    await expectRawLeftOut(await restore(s.offline));

    await rm(s.r.certificatePath);
    const folders = await projectFolders();
    const before = ids();
    const err = (await restore(s.offline).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toMatch(/project "Origin"/u);
    expect(err.message).toMatch(/cannot tell which files/u);
    expect(err.message).toMatch(/can be restored into another library/u);
    expect(err.message).not.toContain(kit.tmp);
    await expectNothingRestored(folders, before);
  });
});

// ------------------------------------------------------------------------------------------
interface Destroyed {
  p: Project;
  x: BackupResult;
  r: DestroyResult;
  /** The backup the destruction made itself: its audit log has the destruction, with X still on its list. */
  fresh: string;
  certificateName: string;
}

/** A project whose one raw file was destroyed on 2026-12-02 at 10:00; with `stuck`, the backup holding it could not be removed. */
async function destroyed(opts: { stuck: boolean }): Promise<Destroyed> {
  const p = await makeProject(kit, RETAIN, false, "Origin");
  const sf = await rawSource(p);
  at("2026-12-02T09:59:00.000Z");
  const x = await backupProject(kit.repo, p.id);
  at("2026-12-02T10:00:00.000Z");
  if (opts.stuck) shredSeams.failFor = (path) => path.endsWith(nameOf(x));
  const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
  shredSeams.failFor = undefined;
  const fresh = (r.certificate.backups as { freshBackup?: string }).freshBackup;
  expect(fresh).toBeDefined();
  return { p, x, r, fresh: abs(fresh!), certificateName: basename(r.certificatePath) };
}

describe("4. a restored project's warning about inherited backups stands from the restore", () => {
  it("a list inherited with a backup still on it: the warning, the note behind it and the restore's own answer say so at once; nothing is recorded yet, and the first pass settles it as before", async () => {
    const d = await destroyed({ stuck: true });
    const r = await restore(d.fresh);
    const copy = r.projectId;
    expect(r.warnings).toContain(WARNING);
    expect(await projectWarnings(kit.repo, copy)).toContain(WARNING);
    expect(await holdingNotRemoved(kit.repo, copy)).toEqual([rel(d.x)]);
    expect(await backupsAwaitingRemoval(kit.repo, copy)).toEqual([{ certificateFile: `${kit.repo.getProject(copy).folder}/retention/${d.certificateName}`, backups: [rel(d.x)] }]);
    // The restore recorded nothing about the step: it is the copy's passes that settle it.
    expect((await eventsOf(copy)).at(-1)!.action).toBe("project.restored");
    expect(await listDestructions(kit.repo, copy)).toMatchObject([{ status: "pending", outstanding: [rel(d.x)], verified: true, amendments: [] }]);
    expect(existsSync(d.x.path)).toBe(true);
    // The original's own warning is its own.
    expect(await holdingNotRemoved(kit.repo, d.p.id)).toEqual([rel(d.x)]);

    later(HOUR);
    await resumeDestruction(kit.repo, copy);
    expect(existsSync(d.x.path)).toBe(false);
    expect(await readDestruction(kit.repo, copy, d.certificateName)).toMatchObject({ status: "deleted", outstanding: [] });
    expect(await projectWarnings(kit.repo, copy)).not.toContain(WARNING);
    // The note the restore wrote was the audit log's own list: no pass found it to disagree.
    expect((await eventsOf(copy)).map((e) => detailsOf(e).problem).filter((x) => x !== undefined)).toEqual([]);
  });

  it("a list inherited whose backup the original has since removed: the warning stands from the restore until the copy's first pass records the backup as no longer present", async () => {
    const d = await destroyed({ stuck: false });
    expect(existsSync(d.x.path)).toBe(false);
    const r = await restore(d.fresh);
    expect(r.warnings).toContain(WARNING);
    expect(await projectWarnings(kit.repo, r.projectId)).toContain(WARNING);
    later(HOUR);
    await resumeDestruction(kit.repo, r.projectId);
    expect(await readDestruction(kit.repo, r.projectId, d.certificateName)).toMatchObject({ status: "no-longer-present", outstanding: [] });
    expect(await projectWarnings(kit.repo, r.projectId)).not.toContain(WARNING);
  });

  it("nothing inherited as outstanding: no warning", async () => {
    const d = await destroyed({ stuck: false });
    later(24 * HOUR);
    const afterwards = await backupProject(kit.repo, d.p.id, { prune: false });
    const r = await restore(afterwards.path);
    expect(r.warnings).not.toContain(WARNING);
    expect(await projectWarnings(kit.repo, r.projectId)).not.toContain(WARNING);
    expect(await holdingNotRemoved(kit.repo, r.projectId)).toEqual([]);
  });

  it("a restore that fails at its last step takes the note back; one that dies right after the copy went live has left it standing", async () => {
    const d = await destroyed({ stuck: true });
    const noted = async () => Object.keys((JSON.parse(await readFile(join(kit.lib.root, "Backups", BACKUPS_STATE), "utf8")) as { undestroyed: Record<string, unknown> }).undestroyed).sort();
    seamsOfRestore.failBeforeRename = true;
    await expect(restore(d.fresh)).rejects.toThrow(/simulated/u);
    seamsOfRestore.failBeforeRename = false;
    expect(ids()).toEqual([d.p.id]);
    expect(await noted()).toEqual([d.p.id]);

    seamsOfRestore.crashAfterRename = true;
    await expect(restore(d.fresh)).rejects.toThrow(/simulated/u);
    seamsOfRestore.crashAfterRename = false;
    // As the restore itself left it on disk, before anything is opened again (a pass at the next
    // open could set the note anew, which would prove nothing about the restore; fix round 1, M8).
    const left = await noted();
    expect(left).toHaveLength(2);
    await kit.reopen();
    const copy = ids().find((id) => id !== d.p.id)!;
    expect(copy).toBeDefined();
    expect(left).toEqual([d.p.id, copy].sort());
    expect(await projectWarnings(kit.repo, copy)).toContain(WARNING);
    expect(await holdingNotRemoved(kit.repo, copy)).toEqual([rel(d.x)]);
  });
});

describe("FR-410: exporting a restored copy states a destruction as fact only where the log vouches for it", () => {
  /** RETAIN, with identifiable sources exportable, so the export reaches the raw file's source. */
  const RETAIN_EXPORTABLE = RETAIN.replace("deidentifiedExportsOnly: true", "deidentifiedExportsOnly: false");
  const notesOf = async (dir: string) => readFile(join(dir, "notes.txt"), "utf8").catch(() => "");

  it("a file left out on records nothing vouches for: the export says the log says so and could not be verified", async () => {
    const z = await makeProject(kit, RETAIN_EXPORTABLE, false, "Bystander");
    const zRaw = await rawSource(z); // the same bytes as Origin's raw file
    await addSource(kit, z, { title: "something else" });
    const p = await makeProject(kit, RETAIN_EXPORTABLE, false, "Origin");
    await rawSource(p);
    await keptSource(p);
    at("2026-12-02T09:59:00.000Z");
    const offline = join(kit.tmp, "Origin offline copy.zip");
    await writeFile(offline, await readFile((await backupProject(kit.repo, p.id)).path));
    at("2026-12-02T10:00:00.000Z");
    backupSeams.failBackup = true;
    await destroyRaw(kit.repo, z.id, [zRaw.assets[0]!.id], "tester");
    backupSeams.failBackup = false;
    await breakAudit(z, (l) => l.includes('"op":"retention.destroy"'));
    const r = await restore(offline);
    expect(r.leftOut).toEqual([expect.objectContaining({ unverified: true })]);
    // The restore names the copy's file it left out on unverified ground (ids only).
    expect(detailsOf((await eventsOf(r.projectId)).at(-1)!)).toMatchObject({ destroyedUnverifiedAssetIds: [r.leftOut[0]!.assetId] });

    const out = await exportProjectOpenFormats(kit.repo, r.projectId, join(kit.tmp, "out"));
    const notes = await notesOf(out.path);
    expect(notes).toContain("1 file is not included. The project's log says this file was destroyed under its retention rule; that entry could not be verified.");
    expect(notes).not.toMatch(/was destroyed under the project's retention rule/u);
    expect(out.omittedFiles).toBe(1);

    // A backup of the copy, restored: the file keeps its mark (an earlier restore named it).
    later(HOUR);
    const again = await restore((await backupProject(kit.repo, r.projectId)).path);
    const out2 = await exportProjectOpenFormats(kit.repo, again.projectId, join(kit.tmp, "out2"));
    expect(await notesOf(out2.path)).toContain("1 file is not included. The project's log says this file was destroyed under its retention rule; that entry could not be verified.");
  });

  it("a file left out on a verified record is still said to have been destroyed", async () => {
    const p = await makeProject(kit, RETAIN_EXPORTABLE, false, "Origin");
    const raw = await rawSource(p);
    await keptSource(p);
    at("2026-12-02T09:59:00.000Z");
    const offline = join(kit.tmp, "Origin offline copy.zip");
    await writeFile(offline, await readFile((await backupProject(kit.repo, p.id)).path));
    at("2026-12-02T10:00:00.000Z");
    await destroyRaw(kit.repo, p.id, [raw.assets[0]!.id], "tester");
    const r = await restore(offline);
    expect(r.leftOut).toEqual([expect.not.objectContaining({ unverified: true })]);
    const out = await exportProjectOpenFormats(kit.repo, r.projectId, join(kit.tmp, "out"));
    expect(await notesOf(out.path)).toContain("1 file was destroyed under the project's retention rule and is not included.");

    // The copy's log changed outside the app: no destruction is stated as fact any more.
    await breakAudit(kit.repo.getProject(r.projectId), (l) => l.includes('"op":"project.restore"'));
    const out2 = await exportProjectOpenFormats(kit.repo, r.projectId, join(kit.tmp, "out2"));
    const notes2 = await notesOf(out2.path);
    expect(notes2).toContain("1 file is not included. The project's log says this file was destroyed under its retention rule; that entry could not be verified.");
    expect(notes2).not.toMatch(/was destroyed under the project's retention rule/u);
  });
});
