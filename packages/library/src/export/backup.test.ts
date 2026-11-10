import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChain, type AuditEvent, type SourceFile } from "@ao/core";
import { UnsafeFileError } from "../extract/errors.js";
import { decryptBytes } from "../repo/io.js";
import { projectDataKey } from "../repo/repo.js";
import { AuditChainInvalidError, BACKUPS_MANIFEST, RestoreError, backupIfDue, backupProject, listBackups, restoreBackup, setBackupSettings } from "./backup.js";
import { OPEN_GOV, PASS, PSEUDO_GOV, addSource, auditEvents, makeKit, makeProject, scratchFile, walk, type Kit } from "./test-kit.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-backup-");
});
afterEach(async () => {
  await kit.close();
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const backupsDir = () => join(kit.lib.root, "Backups");

async function sourceJsonOf(projectId: string, sourceId: string): Promise<SourceFile> {
  return kit.repo.getSource(projectId, sourceId);
}

/** Every file's bytes under `dir` (relative path → sha256). */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await walk(dir)) {
    const p = join(dir, ...rel.split("/"));
    if ((await stat(p)).isFile()) out[rel] = sha(await readFile(p));
  }
  return out;
}

describe("backupProject", () => {
  it("zips the project folder to Backups/<project> - backup - modified <date>.zip (0600), listed in the sidecar manifest, audited without paths", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Field Study");
    const pdf = await scratchFile(kit, "a.pdf", "%PDF-1.4 hello");
    await addSource(kit, p, { title: "Plain title", files: [{ path: pdf, role: "original", handling: "copy" }] });
    const r = await backupProject(kit.repo, p.id);
    expect(r.path).toBe(join(backupsDir(), "Field Study - backup - modified 2026-11-10 0930.zip"));
    if (process.platform !== "win32") expect((await stat(r.path)).mode & 0o777).toBe(0o600);
    const files = unzipSync(new Uint8Array(await readFile(r.path)));
    const names = Object.keys(files);
    expect(names).toContain("project.json");
    expect(names).toContain("governance.yaml");
    expect(names.some((n) => n.startsWith("audit/"))).toBe(true);
    expect(names.some((n) => /^Sources\/.+\/source\.json$/.test(n))).toBe(true);
    expect(names.some((n) => /^Sources\/.+\/original\/.+\.pdf$/.test(n))).toBe(true);
    expect(names).toContain("backup.json");
    expect(names.some((n) => n.includes(".tmp"))).toBe(false);
    const manifest = JSON.parse(await readFile(join(backupsDir(), BACKUPS_MANIFEST), "utf8"));
    expect(manifest.backups).toEqual([expect.objectContaining({ file: "Field Study - backup - modified 2026-11-10 0930.zip", projectId: p.id, sha256: r.sha256, encrypted: false })]);
    expect(r.sha256).toBe(sha(await readFile(r.path)));
    const ev = (await auditEvents(kit, p)).filter((e) => e.action === "backup.create");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details).toMatchObject({ sha256: r.sha256, encrypted: false });
    expect(JSON.stringify(ev[0])).not.toContain("Backups");
  });

  it("encrypted project: the whole zip is sealed (.zip.enc); no known plaintext anywhere in the backup folder; restore matches", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true, "Cocina Project");
    const secretTitle = "Zanzibar Marmalade Secrets";
    const pdf = await scratchFile(kit, "Zanzibar notes.pdf", "%PDF-1.4 Quixotic plaintext body");
    const sf = await addSource(kit, p, { title: secretTitle, files: [{ path: pdf, role: "original", handling: "copy" }] });
    const r = await backupProject(kit.repo, p.id);
    expect(r.path.endsWith("Cocina Project - backup - modified 2026-11-10 0930.zip.enc")).toBe(true);
    const raw = await readFile(r.path);
    expect(raw.subarray(0, 5).toString("latin1")).toBe("AOENC");
    for (const rel of await walk(backupsDir())) {
      const pth = join(backupsDir(), ...rel.split("/"));
      if (!(await stat(pth)).isFile()) continue;
      const bytes = await readFile(pth);
      for (const needle of ["Zanzibar", "Marmalade", "Quixotic", "source.json", "project.json", "Sources/", "PK\u0003\u0004", "governance"]) {
        expect(bytes.includes(Buffer.from(needle, "utf8")), `${rel} contains ${needle}`).toBe(false);
      }
    }
    // Nothing but the backup and the manifest is there (no temp file, no plaintext zip).
    expect((await readdir(backupsDir())).sort()).toEqual([BACKUPS_MANIFEST, "Cocina Project - backup - modified 2026-11-10 0930.zip.enc"].sort());

    const restored = await restoreBackup(kit.repo, r.path);
    expect(restored.projectId).not.toBe(p.id);
    const rp = kit.repo.getProject(restored.projectId);
    expect(rp.folder).toBe("Projects/Cocina Project (restored 2026-11-10)");
    expect(rp.encryption.enabled).toBe(true);
    const [newSourceId] = kit.repo.listSourceIds(rp.id);
    const back = await sourceJsonOf(rp.id, newSourceId!);
    const orig = await sourceJsonOf(p.id, sf.source.id);
    expect(back.source.title).toEqual(orig.source.title);
    expect(back.source.provenance).toEqual(orig.source.provenance);
    expect(back.source.projectIds).toEqual([rp.id]);
    expect(back.assets.map((a) => a.sha256)).toEqual(orig.assets.map((a) => a.sha256));
    // The stored files are byte-identical once decrypted.
    const k = projectDataKey(kit.repo, rp.id)!;
    const dec = async (rel: string) => decryptBytes((id) => (id === k.keyId ? k.key : undefined), await readFile(join(kit.lib.root, ...rel.split("/"))));
    expect(sha(await dec(back.assets[0]!.path))).toBe(sha(await dec(orig.assets[0]!.path)));
  });

  it("12 backups prune to the newest 10; only manifest-listed files matching the backup name are touched", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Prune");
    await writeFile(join(backupsDir(), "notes.txt"), "mine");
    // Looks like a backup but is not in the manifest: never removed.
    await writeFile(join(backupsDir(), "Prune - backup - modified 2001-01-01 0000.zip"), "not ours");
    const made: string[] = [];
    for (let i = 0; i < 12; i++) {
      kit.clock.now = new Date(Date.UTC(2026, 10, 10, 9, 30 + i));
      made.push((await backupProject(kit.repo, p.id)).path);
    }
    const left = (await readdir(backupsDir())).filter((n) => n.startsWith("Prune - backup - modified 2026"));
    expect(left).toHaveLength(10);
    expect(left.sort()).toEqual(made.slice(2).map((m) => m.slice(backupsDir().length + 1)).sort());
    expect(await readFile(join(backupsDir(), "notes.txt"), "utf8")).toBe("mine");
    expect(await readFile(join(backupsDir(), "Prune - backup - modified 2001-01-01 0000.zip"), "utf8")).toBe("not ours");
    expect((await listBackups(kit.repo, p.id)).map((b) => b.file)).toHaveLength(10);
    // keep: 3
    kit.clock.now = new Date(Date.UTC(2026, 10, 10, 10, 0));
    await backupProject(kit.repo, p.id, { keep: 3 });
    expect((await readdir(backupsDir())).filter((n) => n.startsWith("Prune - backup - modified 2026"))).toHaveLength(3);
  });

  it("backupIfDue: a backup when none exists or the last is a day old; none otherwise; none when switched off", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Daily");
    const first = await backupIfDue(kit.repo, p.id, kit.clock.now);
    expect(first?.path).toBeDefined();
    kit.clock.now = new Date("2026-11-10T20:00:00.000Z");
    expect(await backupIfDue(kit.repo, p.id, kit.clock.now)).toBeNull();
    kit.clock.now = new Date("2026-11-11T09:31:00.000Z");
    expect((await backupIfDue(kit.repo, p.id, kit.clock.now))?.path).toBeDefined();
    await setBackupSettings(kit.repo, p.id, { automatic: false });
    kit.clock.now = new Date("2026-11-13T09:31:00.000Z");
    expect(await backupIfDue(kit.repo, p.id, kit.clock.now)).toBeNull();
    expect(kit.repo.getProject(p.id).backups).toEqual({ automatic: false });
  });
});

describe("restoreBackup", () => {
  it("restores into a NEW folder with a new project id, never overwriting; the audit records project.restored with the backup's sha256", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Keep Me");
    const pdf = await scratchFile(kit, "a.pdf", "%PDF-1.4 abc");
    const sf = await addSource(kit, p, { title: "Kept", files: [{ path: pdf, role: "original", handling: "copy" }] });
    const r = await backupProject(kit.repo, p.id);
    const before = await snapshot(join(kit.lib.root, p.folder));

    const one = await restoreBackup(kit.repo, r.path);
    const two = await restoreBackup(kit.repo, r.path);
    expect(new Set([p.id, one.projectId, two.projectId]).size).toBe(3);
    expect(kit.repo.getProject(one.projectId).folder).toBe("Projects/Keep Me (restored 2026-11-10)");
    expect(kit.repo.getProject(two.projectId).folder).toBe("Projects/Keep Me (restored 2026-11-10) (2)");
    expect(kit.repo.getProject(one.projectId).name).toBe("Keep Me (restored 2026-11-10)");
    // The original is untouched.
    expect(await snapshot(join(kit.lib.root, p.folder))).toEqual(before);
    // Registry stays unique: no source id is shared between the copies.
    const ids = [p.id, one.projectId, two.projectId].flatMap((id) => kit.repo.listSourceIds(id));
    expect(new Set(ids).size).toBe(3);
    const restoredSf = await kit.repo.getSource(one.projectId, kit.repo.listSourceIds(one.projectId)[0]!);
    expect(restoredSf.source.folder.startsWith("Projects/Keep Me (restored 2026-11-10)/Sources/")).toBe(true);
    expect(restoredSf.assets[0]!.path.startsWith("Projects/Keep Me (restored 2026-11-10)/Sources/")).toBe(true);
    expect(restoredSf.assets[0]!.sourceId).toBe(restoredSf.source.id);
    expect(restoredSf.assets[0]!.sha256).toBe(sf.assets[0]!.sha256);
    expect(await readFile(join(kit.lib.root, ...restoredSf.assets[0]!.path.split("/")), "utf8")).toBe("%PDF-1.4 abc");

    const events: AuditEvent[] = await auditEvents(kit, kit.repo.getProject(one.projectId));
    expect(verifyChain(events).ok).toBe(true);
    const last = events.at(-1)!;
    expect(last.action).toBe("project.restored");
    expect(last.projectId).toBe(one.projectId);
    expect(last.details).toMatchObject({ backupSha256: r.sha256, restoredFrom: p.id });
    // Opens cleanly afterwards (anchored, chain verifies).
    const again = await kit.reopen();
    expect(again.integrityWarnings.filter((w) => w.projectId === one.projectId)).toEqual([]);
    expect((await again.verifyAudit(one.projectId)).ok).toBe(true);
    // A write to the restored project works.
    await addSource(kit, kit.repo.getProject(one.projectId), { title: "after restore" });
  });

  it("refuses a zip with a traversal entry; nothing is created", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Trav");
    const evil = join(backupsDir(), "Trav - backup - modified 2026-11-10 0930.zip");
    await writeFile(evil, zipSync({ "project.json": strToU8("{}"), "../../evil.txt": strToU8("pwned") }));
    const projectsBefore = (await readdir(join(kit.lib.root, "Projects"))).sort();
    await expect(restoreBackup(kit.repo, evil)).rejects.toBeInstanceOf(UnsafeFileError);
    expect((await readdir(join(kit.lib.root, "Projects"))).sort()).toEqual(projectsBefore);
    expect((await walk(kit.tmp)).some((n) => n.endsWith("evil.txt"))).toBe(false);
    expect(kit.repo.listProjects().map((x) => x.id)).toEqual([p.id]);
  });

  it("refuses a backup whose audit chain was tampered with; nothing is created", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Tamper");
    await addSource(kit, p, { title: "x" });
    const r = await backupProject(kit.repo, p.id);
    const files = unzipSync(new Uint8Array(await readFile(r.path)));
    const auditName = Object.keys(files).find((n) => n.startsWith("audit/"))!;
    files[auditName] = strToU8(strFromU8(files[auditName]!).replace('"actor":"tester"', '"actor":"mallory"'));
    // In place, the manifest's sha256 already catches it.
    await writeFile(r.path, zipSync(files));
    const projectsBefore = (await readdir(join(kit.lib.root, "Projects"))).sort();
    await expect(restoreBackup(kit.repo, r.path)).rejects.toBeInstanceOf(RestoreError);
    // A copy brought from elsewhere (no manifest entry): the chain check refuses it.
    const copied = join(kit.tmp, "copied backup.zip");
    await writeFile(copied, zipSync(files));
    await expect(restoreBackup(kit.repo, copied)).rejects.toBeInstanceOf(AuditChainInvalidError);
    expect((await readdir(join(kit.lib.root, "Projects"))).sort()).toEqual(projectsBefore);
    expect(kit.repo.listProjects()).toHaveLength(1);
  });

  it("an encrypted backup restores with the passphrase when the project is locked", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true, "Locked One");
    await addSource(kit, p, { title: "inside" });
    const r = await backupProject(kit.repo, p.id);
    kit.repo.lockProject(p.id);
    await expect(restoreBackup(kit.repo, r.path)).rejects.toThrow(/passphrase|locked/i);
    const restored = await restoreBackup(kit.repo, r.path, { passphrase: PASS });
    const [sid] = kit.repo.listSourceIds(restored.projectId);
    expect((await kit.repo.getSource(restored.projectId, sid!)).source.title.variants[0]!.value).toBe("inside");
  });
});
