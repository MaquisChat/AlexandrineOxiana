import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, sealEvent, verifyChain, type AuditEvent, type SourceFile } from "@ao/core";
import { UnsafeFileError } from "../extract/errors.js";
import { decryptBytes } from "../repo/io.js";
import { appendJobRecords } from "../job-journal.js";
import { projectDataKey, projectWarnings } from "../repo/repo.js";
import { restoreSeams } from "../repo/restore.js";
import { AuditChainInvalidError, BACKUPS_MANIFEST, BACKUPS_STATE, RestoreError, backupIfDue, backupSeams, backupProject, listBackups, restoreBackup, setBackupSettings } from "./backup.js";
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
    expect((await readdir(backupsDir())).sort()).toEqual([BACKUPS_MANIFEST, BACKUPS_STATE, "Cocina Project - backup - modified 2026-11-10 0930.zip.enc"].sort());

    const restored = await restoreBackup(kit.repo, r.path);
    expect(restored.projectId).not.toBe(p.id);
    const rp = kit.repo.getProject(restored.projectId);
    expect(rp.folder).toBe("Projects/Cocina Project (restored 2026-11-10)");
    expect(rp.encryption.enabled).toBe(true);
    const [newSourceId] = kit.repo.listSourceIds(rp.id);
    const back = await sourceJsonOf(rp.id, newSourceId!);
    const orig = await sourceJsonOf(p.id, sf.source.id);
    expect(back.source.title).toEqual(orig.source.title);
    // Provenance is as captured; only its fileHashes keys follow the new asset ids (R92).
    expect({ ...back.source.provenance, fileHashes: {} }).toEqual({ ...orig.source.provenance, fileHashes: {} });
    expect(Object.values(back.source.provenance.fileHashes)).toEqual(Object.values(orig.source.provenance.fileHashes));
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

  it("a project's job journal (R31) is backed up; the restored copy starts without the original's jobs", async () => {
    for (const encrypted of [false, true]) {
      const p = await makeProject(kit, encrypted ? PSEUDO_GOV : OPEN_GOV, encrypted, encrypted ? "Jobs E" : "Jobs P");
      const at = "2026-11-10T09:30:00.000Z";
      await appendJobRecords(kit.lib.root, p.folder, projectDataKey(kit.repo, p.id), [
        { v: 1, id: newId(), projectId: p.id, kind: "pdf.ocr", status: "queued", createdAt: at, updatedAt: at,
          job: { type: "pdf.ocr", input: join(kit.lib.root, p.folder, "x.pdf"), output: join(kit.lib.root, ".tmp", "o.pdf"), params: {} } },
      ]);
      const r = await backupProject(kit.repo, p.id);
      const restored = await restoreBackup(kit.repo, r.path);
      const folder = kit.repo.getProject(restored.projectId).folder;
      // its records name the original's files and work: they stay with the original
      expect((await walk(join(kit.lib.root, folder))).some((f) => f.startsWith("jobs/"))).toBe(false);
      expect((await walk(join(kit.lib.root, p.folder))).some((f) => f.startsWith("jobs/"))).toBe(true);
    }
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

describe("R92: large projects, failures, consistency", () => {
  it("a project over 4 GB (sparse file) backs up as Zip64 and restores", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Huge");
    await addSource(kit, p, { title: "small" });
    const big = join(kit.lib.root, p.folder, "big.bin");
    const fh = await open(big, "w");
    await fh.truncate(4.5 * 1024 ** 3);
    await fh.write(Buffer.from("TAIL"), 0, 4, 4.5 * 1024 ** 3 - 4);
    await fh.close();
    const r = await backupProject(kit.repo, p.id);
    await rm(big); // keep the disk free; the backup holds it
    const restored = await restoreBackup(kit.repo, r.path);
    const back = join(kit.lib.root, restored.folder, "big.bin");
    expect((await stat(back)).size).toBe(4.5 * 1024 ** 3);
    const tail = Buffer.alloc(4);
    const rh = await open(back, "r");
    await rh.read(tail, 0, 4, 4.5 * 1024 ** 3 - 4);
    await rh.close();
    expect(tail.toString()).toBe("TAIL");
    await rm(back);
  }, 600_000);

  it("restore checks free space before unpacking", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Space");
    await addSource(kit, p, { title: "x" });
    const r = await backupProject(kit.repo, p.id);
    backupSeams.freeBytes = async () => 10;
    try {
      await expect(restoreBackup(kit.repo, r.path)).rejects.toThrow(/space/u);
    } finally {
      backupSeams.freeBytes = undefined;
    }
    expect(kit.repo.listProjects()).toHaveLength(1);
  });

  it("a failed automatic backup becomes the persisted project warning 'backup-failed'; a later success clears it", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Fails");
    backupSeams.failBackup = true;
    try {
      await expect(backupIfDue(kit.repo, p.id, kit.clock.now)).rejects.toThrow();
    } finally {
      backupSeams.failBackup = false;
    }
    expect(await projectWarnings(kit.repo, p.id)).toContain("backup-failed");
    const again = await kit.reopen();
    expect(await projectWarnings(again, p.id)).toContain("backup-failed");
    expect((await backupIfDue(again, p.id, kit.clock.now))?.path).toBeDefined();
    expect(await projectWarnings(again, p.id)).not.toContain("backup-failed");
  });

  it("the zip is written outside the write queue: a change meanwhile makes it retry once; the result restores", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Busy");
    const sf = await addSource(kit, p, { title: "first" });
    let calls = 0;
    backupSeams.afterSnapshot = async () => {
      calls++;
      // Not blocked by the backup: the write queue is free while the zip is written. This rewrites
      // a file the snapshot listed (source.json), and adds another source (new files: not in it).
      if (calls === 1) {
        await kit.repo.updateSource(p.id, sf.source.id, { title: { variants: [{ lang: "en", kind: "original", value: "edited meanwhile" }] } });
        await addSource(kit, p, { title: "made during the backup" });
      }
    };
    let r;
    try {
      r = await backupProject(kit.repo, p.id);
    } finally {
      backupSeams.afterSnapshot = undefined;
    }
    expect(calls).toBe(2);
    expect(r.warnings).toEqual([]);
    const restored = await restoreBackup(kit.repo, r.path);
    const titles = await Promise.all(kit.repo.listSourceIds(restored.projectId).map(async (id) => (await kit.repo.getSource(restored.projectId, id)).source.title.variants[0]!.value));
    expect(titles.sort()).toEqual(["edited meanwhile", "made during the backup"]);
  });

  it(".tmp-<hex> leftovers of interrupted backups are removed", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Left");
    const stale = join(backupsDir(), "Left - backup - modified 2026-11-01 0900.zip.tmp-abcdef12");
    await writeFile(stale, "half a zip");
    await backupProject(kit.repo, p.id);
    expect((await readdir(backupsDir())).some((n) => n.includes(".tmp-"))).toBe(false);
  });

  it("pruning goes by the manifest's project id, not the file's project name", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Renamed");
    const first = await backupProject(kit.repo, p.id);
    // As if the project had been called something else when this backup was made.
    const oldName = "Old Name - backup - modified 2026-11-10 0930.zip";
    await rename(first.path, join(backupsDir(), oldName));
    const mf = JSON.parse(await readFile(join(backupsDir(), BACKUPS_MANIFEST), "utf8"));
    mf.backups[0].file = oldName;
    await writeFile(join(backupsDir(), BACKUPS_MANIFEST), JSON.stringify(mf));
    for (let i = 1; i <= 2; i++) {
      kit.clock.now = new Date(Date.UTC(2026, 10, 10, 9, 30 + i));
      await backupProject(kit.repo, p.id, { keep: 2 });
    }
    expect(await readdir(backupsDir())).not.toContain(oldName);
  });
});

describe("R92: restore", () => {
  it("remaps batch, review and pending-job ids and provenance.fileHashes keys (values kept)", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Ids");
    const batchId = newId();
    const pdf = await scratchFile(kit, "a.pdf", "%PDF-1.4 ids");
    const sf = await kit.repo.createSource(
      p.id,
      { projectIds: [p.id], type: "report", title: { variants: [{ lang: "en", kind: "original", value: "With ids" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [{ path: pdf, role: "original", handling: "copy" }],
      {
        provenance: { captureMethod: "manual_upload", capturedAt: kit.clock.now.toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false, importBatchId: batchId },
        reviewItem: { fields: { "/title": "unverified" }, reasons: ["check"] },
        pendingProxies: (assets) => [{ id: newId(), type: "image.proxy", assetId: assets[0]!.id, location: "keep", queuedAt: kit.clock.now.toISOString() }],
      },
    );
    await mkdir(join(kit.lib.root, p.folder, "imports", "batch-0001"), { recursive: true });
    await writeFile(join(kit.lib.root, p.folder, "imports", "batch-0001", "batch.json"), JSON.stringify({ id: batchId, projectId: p.id, dir: "imports/batch-0001" }, null, 2));
    const reviewBefore = (await readFile(join(kit.lib.root, p.folder, "review", "pending.jsonl"), "utf8")).trim();
    const reviewId = (JSON.parse(reviewBefore) as { id: string }).id;
    const r = await backupProject(kit.repo, p.id);
    const restored = await restoreBackup(kit.repo, r.path);
    const [nid] = kit.repo.listSourceIds(restored.projectId);
    const back = await kit.repo.getSource(restored.projectId, nid!);
    const newAsset = back.assets[0]!;
    expect(back.source.provenance.fileHashes).toEqual({ [newAsset.id]: sf.assets[0]!.sha256 });
    expect(back.source.provenance.importBatchId).not.toBe(batchId);
    const batch = JSON.parse(await readFile(join(kit.lib.root, restored.folder, "imports", "batch-0001", "batch.json"), "utf8"));
    expect(batch.id).toBe(back.source.provenance.importBatchId);
    const review = JSON.parse((await readFile(join(kit.lib.root, restored.folder, "review", "pending.jsonl"), "utf8")).trim());
    expect(review.id).not.toBe(reviewId);
    expect(review.sourceId).toBe(nid);
    expect(back.pendingProxies![0]!.id).not.toBe(sf.pendingProxies![0]!.id);
    expect(back.pendingProxies![0]!.assetId).toBe(newAsset.id);
  });

  it("refuses a log whose events name another project (chain re-sealed)", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Other");
    await addSource(kit, p, { title: "x" });
    const r = await backupProject(kit.repo, p.id);
    const files = unzipSync(new Uint8Array(await readFile(r.path)));
    const auditName = Object.keys(files).find((n) => n.startsWith("audit/"))!;
    const events = strFromU8(files[auditName]!).trim().split("\n").map((l) => JSON.parse(l) as AuditEvent);
    let prev: { seq: number; hash: string } | null = null;
    const resealed = events.map((e, i) => {
      const { seq: _s, hash: _h, prevHash: _p, ...rest } = e;
      const ev = sealEvent(i === 1 ? { ...rest, projectId: newId() } : rest, prev);
      prev = { seq: ev.seq, hash: ev.hash };
      return JSON.stringify(ev);
    });
    files[auditName] = strToU8(`${resealed.join("\n")}\n`);
    const header = JSON.parse(strFromU8(files["backup.json"]!));
    header.auditHead = prev;
    files["backup.json"] = strToU8(JSON.stringify(header));
    const copied = join(kit.tmp, "other.zip");
    await writeFile(copied, zipSync(files));
    await expect(restoreBackup(kit.repo, copied)).rejects.toBeInstanceOf(AuditChainInvalidError);
  });

  it("a damaged sealed backup gives a plain decryption error", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true, "Damaged");
    await addSource(kit, p, { title: "x" });
    const r = await backupProject(kit.repo, p.id);
    const bytes = await readFile(r.path);
    bytes[bytes.length - 40] = bytes[bytes.length - 40]! ^ 0xff;
    const copied = join(kit.tmp, "damaged.zip.enc");
    await writeFile(copied, bytes);
    await expect(restoreBackup(kit.repo, copied)).rejects.toThrow(/cannot be decrypted/u);
  });

  it("a crash between the rename and the anchor gives no false anchor-missing warning", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Crashy");
    const r = await backupProject(kit.repo, p.id);
    restoreSeams.crashAfterRename = true;
    try {
      await expect(restoreBackup(kit.repo, r.path)).rejects.toThrow(/simulated/u);
    } finally {
      restoreSeams.crashAfterRename = false;
    }
    const again = await kit.reopen();
    expect(again.integrityWarnings.filter((w) => w.kind === "anchor-missing")).toEqual([]);
    expect(again.listProjects()).toHaveLength(2);
  });
});

describe("R92 I2: a corrupt backups manifest", () => {
  it("is rebuilt from each backup's backup.json (sealed ones too, with the key file from the project)", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true, "Rebuild");
    await addSource(kit, p, { title: "x", files: [{ path: await scratchFile(kit, "a.pdf", "%PDF"), role: "original", handling: "copy" }] });
    const r = await backupProject(kit.repo, p.id);
    const before = (await listBackups(kit.repo, p.id))[0]!;
    await writeFile(join(backupsDir(), BACKUPS_MANIFEST), "{ not json");
    const after = await listBackups(kit.repo, p.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ file: before.file, projectId: p.id, sha256: r.sha256, assets: before.assets });
    expect(after[0]!.keyFile?.keyId).toBe(before.keyFile?.keyId);
    // A copy was kept aside, never silently dropped.
    expect((await readdir(backupsDir())).some((n) => n.startsWith(`${BACKUPS_MANIFEST}.unreadable-`))).toBe(true);
  });
});

describe("R94", () => {
  it("a recorded backup failure survives a manifest rebuild", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Keepfail");
    await backupProject(kit.repo, p.id);
    backupSeams.failBackup = true;
    try {
      await expect(backupProject(kit.repo, p.id)).rejects.toThrow();
    } finally {
      backupSeams.failBackup = false;
    }
    await writeFile(join(backupsDir(), BACKUPS_MANIFEST), "{ damaged");
    expect(await listBackups(kit.repo, p.id)).toHaveLength(1);
    expect(await projectWarnings(kit.repo, p.id)).toContain("backup-failed");
  });

  it("an append-only log replaced by another file (new inode) during the backup makes it retry", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Inode");
    await addSource(kit, p, { title: "x" });
    const changes = join(kit.lib.root, p.folder, "changes");
    const log = join(changes, (await readdir(changes)).find((n) => n.endsWith(".jsonl"))!);
    let calls = 0;
    backupSeams.afterSnapshot = async () => {
      calls++;
      if (calls === 1) {
        // Same bytes, another file (written beside it, then renamed over it: a new inode).
        await writeFile(`${log}.new`, await readFile(log), { mode: 0o600 });
        await rename(`${log}.new`, log);
      }
    };
    try {
      await backupProject(kit.repo, p.id);
    } finally {
      backupSeams.afterSnapshot = undefined;
    }
    expect(calls).toBe(2);
  });

  it("the temp sweep touches only temp files of backup names", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Sweep");
    await writeFile(join(backupsDir(), "notes.tmp-abcdef12"), "mine");
    await backupProject(kit.repo, p.id);
    expect(await readFile(join(backupsDir(), "notes.tmp-abcdef12"), "utf8")).toBe("mine");
  });
});
