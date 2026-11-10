import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChain, type Project, type SourceFile } from "@ao/core";
import { backupProject, listBackups, restoreBackup } from "./export/backup.js";
import { addSource, auditEvents, makeKit, makeProject, plainOf, scratchFile, walk, type Kit } from "./export/test-kit.js";
import { SimulatedCrash, seams } from "./repo/testing.js";
import { findSourceBy, indexSource, openIndex } from "./index/db.js";
import { shredSeams } from "./fs/shred.js";
import { backupSeams } from "./export/backup.js";
import { DESTRUCTION_NOTICE, destroyRaw, resumeDestruction, retentionDue } from "./retention.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-retention-");
});
afterEach(async () => {
  seams.crashAt = undefined;
  await kit.close();
});

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const GOV = (encrypted: boolean) => `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
  deidentifiedExportsOnly: true
encryption:
  atRest: ${encrypted ? "required" : "optional"}
consent:
  requireLegalBasis: false
retention:
  rawDataDestroyAfter: 2026-12-01
captureMethods: [manual_upload]
`;

const abs = (rel: string) => join(kit.lib.root, ...rel.split("/"));

async function rawSource(p: Project, content = "RAW interview audio bytes"): Promise<SourceFile> {
  const f = await scratchFile(kit, "interview.mp3", content);
  return addSource(kit, p, { type: "interview", title: "Interview one", identifiable: true, files: [{ path: f, role: "original", handling: "copy" }] });
}

async function derived(p: Project, sf: SourceFile, kind: string, ext: string, body: string) {
  const f = await scratchFile(kit, `d.${ext}`, body);
  return kit.repo.addDerivedAsset(p.id, sf.source.id, {
    fromPath: f,
    kind,
    tool: "test",
    ext,
    derivation: { parents: [sf.assets[0]!.id], operation: kind, provider: "test", ranAt: "local", params: {}, at: kit.clock.now.toISOString(), triggeredBy: "tester" },
  });
}

describe("retentionDue", () => {
  it("lists the raw originals of identifiable sources once rawDataDestroyAfter has passed", async () => {
    const p = await makeProject(kit, GOV(false));
    const sf = await rawSource(p);
    await addSource(kit, p, { title: "Published", files: [{ path: await scratchFile(kit, "p.pdf", "%PDF"), role: "original", handling: "copy" }] });
    expect(await retentionDue(kit.repo, p.id, new Date("2026-11-30T23:59:00Z"))).toEqual([]);
    expect(await retentionDue(kit.repo, p.id, new Date("2026-12-01T00:00:00Z"))).toEqual([{ sourceId: sf.source.id, assetIds: [sf.assets[0]!.id] }]);
  });

  it("nothing is due without a retention date", async () => {
    const p = await makeProject(kit, GOV(false).replace("  rawDataDestroyAfter: 2026-12-01\n", "  rawDataDestroyAfter: null\n"));
    await rawSource(p);
    expect(await retentionDue(kit.repo, p.id, new Date("2099-01-01T00:00:00Z"))).toEqual([]);
  });
});

describe("destroyRaw", () => {
  it("overwrites then removes the file, marks the asset destroyed, writes a certificate (library-relative path, sha256, time, actor, notice); audited; the chain verifies", async () => {
    const p = await makeProject(kit, GOV(false));
    const sf = await rawSource(p);
    const asset = sf.assets[0]!;
    kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
    expect(await retentionDue(kit.repo, p.id, kit.clock.now)).toHaveLength(1);
    const r = await destroyRaw(kit.repo, p.id, [asset.id], "Dr. Ana Ruiz");
    expect(existsSync(abs(asset.path))).toBe(false);
    expect(r.certificatePath).toBe(abs(`${p.folder}/retention/destruction-2026-12-02 1015.json`));
    const cert = JSON.parse(await readFile(r.certificatePath, "utf8"));
    expect(cert).toMatchObject({
      projectId: p.id,
      at: "2026-12-02T10:15:00.000Z",
      actor: "Dr. Ana Ruiz",
      assets: [{ assetId: asset.id, sourceId: sf.source.id, path: asset.path, sha256: asset.sha256, role: "original" }],
      notice: DESTRUCTION_NOTICE,
    });
    expect(DESTRUCTION_NOTICE).toMatch(/SSD/u);
    expect(DESTRUCTION_NOTICE).toMatch(/copy-on-write/u);
    expect(DESTRUCTION_NOTICE).toMatch(/cloud sync/u);
    expect(JSON.stringify(cert)).not.toContain(kit.lib.root);
    const after = await kit.repo.getSource(p.id, sf.source.id);
    expect(after.assets[0]).toMatchObject({ id: asset.id, status: "destroyed", destroyedAt: "2026-12-02T10:15:00.000Z" });
    expect(await retentionDue(kit.repo, p.id, kit.clock.now)).toEqual([]);
    const events = await auditEvents(kit, p);
    expect(verifyChain(events).ok).toBe(true);
    const ev = events.filter((e) => e.action === "retention.destroyed");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details).toMatchObject({ assets: 1, certificateSha256: sha(await readFile(r.certificatePath)) });
    expect(events.some((e) => e.action === "delete" && (e.details as { op?: string }).op === "retention.destroy")).toBe(true);
    expect((await kit.repo.verifyAudit(p.id)).ok).toBe(true);
    // Nothing left in the scratch space.
    expect((await readdir(join(kit.lib.root, ".tmp"))).filter((n) => n.startsWith("trash-") || n.startsWith("txn-"))).toEqual([]);
    // Destroying it again is refused.
    await expect(destroyRaw(kit.repo, p.id, [asset.id], "x")).rejects.toThrow(/already destroyed/u);
  });

  it("also destroys its media proxies, trashed copies and the backups that hold it (after a fresh backup); text derivatives are kept; the certificate lists them all", async () => {
    const p = await makeProject(kit, GOV(true), true);
    const sf = await rawSource(p);
    const proxy = await derived(p, sf, "proxy", "jpg", "PROXY bytes");
    const ocr = await derived(p, sf, "ocr-text", "txt", "transcript text");
    const original = sf.assets[0]!;
    // A trashed copy left behind by an interrupted change.
    const trash = join(kit.lib.root, ".tmp", "trash-00000000-0000-4000-8000-000000000000-abcd");
    await mkdir(trash, { recursive: true });
    const base = original.path.slice(original.path.lastIndexOf("/") + 1);
    await writeFile(join(trash, base), "stale copy");
    const old = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
    const r = await destroyRaw(kit.repo, p.id, [original.id], "tester");
    for (const a of [original, proxy]) expect(existsSync(abs(a.path))).toBe(false);
    expect(existsSync(abs(ocr.path))).toBe(true);
    expect(existsSync(join(trash, base))).toBe(false);
    expect(existsSync(old.path)).toBe(false);
    const backups = await listBackups(kit.repo, p.id);
    expect(backups).toHaveLength(1);
    expect(existsSync(join(kit.lib.root, "Backups", backups[0]!.file))).toBe(true);
    // Sealed in an encrypted project (readable when unlocked).
    expect(r.certificatePath.endsWith(".json.enc")).toBe(true);
    expect((await readFile(r.certificatePath)).includes(Buffer.from(original.sha256))).toBe(false);
    const cert = JSON.parse((await plainOf(kit, p, r.certificatePath.slice(kit.lib.root.length + 1).split("\\").join("/"))).toString("utf8"));
    expect(cert).toEqual(r.certificate);
    expect(cert.assets.map((a: { assetId: string }) => a.assetId).sort()).toEqual([original.id, proxy.id].sort());
    expect(cert.trashedCopies).toEqual([`.tmp/trash-00000000-0000-4000-8000-000000000000-abcd/${base}`]);
    expect(cert.backups).toMatchObject({ status: "deleted", deleted: [`Backups/${old.path.slice(old.path.lastIndexOf("/") + 1)}`], freshBackup: `Backups/${backups[0]!.file}` });
    const after = await kit.repo.getSource(p.id, sf.source.id);
    expect(after.assets.find((a) => a.id === proxy.id)?.status).toBe("destroyed");
    expect(after.assets.find((a) => a.id === ocr.id)?.status).toBeUndefined();
    expect(verifyChain(await auditEvents(kit, p)).ok).toBe(true);
  });

  it("includeDerived destroys text derivatives too", async () => {
    const p = await makeProject(kit, GOV(false));
    const sf = await rawSource(p);
    const ocr = await derived(p, sf, "ocr-text", "txt", "transcript text");
    await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester", { includeDerived: true });
    expect(existsSync(abs(ocr.path))).toBe(false);
    expect((await kit.repo.getSource(p.id, sf.source.id)).assets.find((a) => a.id === ocr.id)?.status).toBe("destroyed");
  });

  it("refuses an asset that is not an original of this project", async () => {
    const p = await makeProject(kit, GOV(false));
    const sf = await rawSource(p);
    const ocr = await derived(p, sf, "ocr-text", "txt", "t");
    await expect(destroyRaw(kit.repo, p.id, [ocr.id], "x")).rejects.toThrow(/original/u);
    await expect(destroyRaw(kit.repo, p.id, ["99999999-9999-4999-8999-999999999999"], "x")).rejects.toThrow(/not found|unknown/iu);
  });

  it("a crash before the commit rolls back completely (file, source, certificate); it can then be done", async () => {
    const p = await makeProject(kit, GOV(false));
    const sf = await rawSource(p);
    const asset = sf.assets[0]!;
    const before = await readFile(abs(asset.path));
    seams.crashAt = "before-audit";
    await expect(destroyRaw(kit.repo, p.id, [asset.id], "tester")).rejects.toBeInstanceOf(SimulatedCrash);
    const again = await kit.reopen();
    expect(again.integrityWarnings.map((w) => w.kind)).toContain("rolled-back-incomplete-write");
    expect(await readFile(abs(asset.path))).toEqual(before);
    expect((await again.getSource(p.id, sf.source.id)).assets[0]!.status).toBeUndefined();
    expect(await walk(abs(`${p.folder}/retention`))).toEqual([]);
    expect(verifyChain(await auditEvents(kit, p)).ok).toBe(true);
    await destroyRaw(again, p.id, [asset.id], "tester");
    expect(existsSync(abs(asset.path))).toBe(false);
  });

  it("a crash after the commit completes cleanly on the next open: the trashed file is overwritten and removed; pending backup deletion resumes", async () => {
    const p = await makeProject(kit, GOV(false));
    const sf = await rawSource(p, "SENSITIVE-RAW-CONTENT");
    const asset = sf.assets[0]!;
    const old = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
    seams.crashAt = "before-marker-delete";
    await expect(destroyRaw(kit.repo, p.id, [asset.id], "tester")).rejects.toBeInstanceOf(SimulatedCrash);
    // The "dead" process left the file in the trash.
    const trashed = (await readdir(join(kit.lib.root, ".tmp"))).filter((n) => n.startsWith("trash-"));
    expect(trashed.length).toBeGreaterThan(0);
    const again = await kit.reopen();
    expect((await readdir(join(kit.lib.root, ".tmp"))).filter((n) => n.startsWith("trash-") || n.startsWith("txn-"))).toEqual([]);
    expect(existsSync(abs(asset.path))).toBe(false);
    expect((await again.getSource(p.id, sf.source.id)).assets[0]!.status).toBe("destroyed");
    expect(verifyChain(await auditEvents(kit, p)).ok).toBe(true);
    // The old backup still holds the asset until the destruction is resumed.
    expect(existsSync(old.path)).toBe(true);
    kit.clock.now = new Date("2026-12-02T10:20:00.000Z");
    const done = await resumeDestruction(again, p.id);
    expect(done).toHaveLength(1);
    expect(existsSync(old.path)).toBe(false);
    const cert = JSON.parse(await readFile(done[0]!, "utf8"));
    expect(cert.backups.status).toBe("deleted");
  });
});

describe("R92", () => {
  it("I3: a failed fresh backup keeps the step pending with lastError; resumeDestruction retries it", async () => {
    const p = await makeProject(kit, GOV(false));
    const sf = await rawSource(p);
    const old = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
    backupSeams.failBackup = true;
    let r;
    try {
      r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    } finally {
      backupSeams.failBackup = false;
    }
    expect(r.certificate.backups).toMatchObject({ status: "pending", deleted: [], lastError: expect.any(String) });
    expect(existsSync(old.path)).toBe(true);
    kit.clock.now = new Date("2026-12-02T10:20:00.000Z");
    const done = await resumeDestruction(kit.repo, p.id);
    expect(done).toHaveLength(1);
    expect(existsSync(old.path)).toBe(false);
    const cert = JSON.parse(await readFile(done[0]!, "utf8"));
    expect(cert.backups).toMatchObject({ status: "deleted", deleted: [`Backups/${old.path.slice(old.path.lastIndexOf("/") + 1)}`] });
    expect(cert.backups.lastError).toBeUndefined();
  });

  it("I3: a partly failed backup deletion reports exactly what was deleted, the manifest follows each deletion, and a retry finishes", async () => {
    const p = await makeProject(kit, GOV(false));
    const sf = await rawSource(p);
    const a = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-11-10T09:31:00.000Z");
    const b = await backupProject(kit.repo, p.id);
    const nameOf = (x: { path: string }) => x.path.slice(x.path.lastIndexOf("/") + 1);
    kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
    shredSeams.failFor = (path) => path.endsWith(nameOf(b));
    let r;
    try {
      r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    } finally {
      shredSeams.failFor = undefined;
    }
    const bk = r.certificate.backups as { status: string; deleted: string[]; lastError?: string };
    expect(bk.status).toBe("pending");
    expect(bk.deleted).toEqual([`Backups/${nameOf(a)}`]);
    expect(bk.lastError).toEqual(expect.any(String));
    expect((await listBackups(kit.repo, p.id)).map((x) => x.file)).not.toContain(nameOf(a));
    kit.clock.now = new Date("2026-12-02T10:20:00.000Z");
    const [path] = await resumeDestruction(kit.repo, p.id);
    const cert = JSON.parse(await readFile(path!, "utf8"));
    expect(cert.backups.status).toBe("deleted");
    expect(cert.backups.deleted.sort()).toEqual([`Backups/${nameOf(a)}`, `Backups/${nameOf(b)}`].sort());
    expect(existsSync(b.path)).toBe(false);
  });

  it("I2: with a corrupt manifest, a project-named file that cannot be read counts as holding the data (unknown-pending, kept)", async () => {
    const p = await makeProject(kit, GOV(false), false, "Corrupt");
    const sf = await rawSource(p);
    await backupProject(kit.repo, p.id);
    const garbage = join(kit.lib.root, "Backups", "Corrupt - backup - modified 2026-01-01 0000.zip");
    await writeFile(garbage, "not a zip at all");
    await writeFile(join(kit.lib.root, "Backups", "backups-manifest.json"), "garbage");
    kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    const bk = r.certificate.backups as { status: string; containing: string[] };
    expect(bk.status).toBe("unknown-pending");
    expect(bk.containing).toContain("Backups/Corrupt - backup - modified 2026-01-01 0000.zip");
    expect(existsSync(garbage)).toBe(true);
  });

  it("a manifest entry without asset ids counts as holding the data", async () => {
    const p = await makeProject(kit, GOV(false));
    const sf = await rawSource(p);
    const old = await backupProject(kit.repo, p.id);
    const mpath = join(kit.lib.root, "Backups", "backups-manifest.json");
    const m = JSON.parse(await readFile(mpath, "utf8"));
    delete m.backups[0].assets;
    await writeFile(mpath, JSON.stringify(m));
    kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
    await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    expect(existsSync(old.path)).toBe(false);
  });

  it("I4: a derived file cannot be added to a destroyed original", async () => {
    const p = await makeProject(kit, GOV(false));
    const sf = await rawSource(p);
    await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    await expect(derived(p, sf, "ocr-text", "txt", "late")).rejects.toThrow(/destroyed/u);
  });

  it("recovery keeps the marker when overwriting fails, and finishes on a later open", async () => {
    const p = await makeProject(kit, GOV(false));
    const sf = await rawSource(p);
    seams.crashAt = "before-marker-delete";
    await expect(destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester")).rejects.toBeInstanceOf(SimulatedCrash);
    shredSeams.failFor = () => true;
    let stuck;
    try {
      stuck = await kit.reopen();
    } finally {
      shredSeams.failFor = undefined;
    }
    // R94: said plainly, not only kept quietly.
    const w = stuck.integrityWarnings.find((x) => x.kind === "destroy-incomplete");
    expect(w?.detail).toMatch(/could not be overwritten/u);
    expect(w?.detail).not.toContain(kit.lib.root);
    // Not a reason to refuse changes to the project.
    await addSource(kit, p, { title: "still writable" });
    const tmpNames = await readdir(join(kit.lib.root, ".tmp"));
    expect(tmpNames.some((n) => n.startsWith("txn-"))).toBe(true);
    expect(tmpNames.some((n) => n.startsWith("trash-"))).toBe(true);
    await kit.reopen();
    expect((await readdir(join(kit.lib.root, ".tmp"))).filter((n) => n.startsWith("txn-") || n.startsWith("trash-"))).toEqual([]);
  });

  it("isDue reads dates in UTC unless the project sets a time zone; a time without an offset is UTC", async () => {
    const p = await makeProject(kit, GOV(false));
    await rawSource(p);
    const far = await kit.reopen({ tz: "Pacific/Kiritimati" }); // UTC+14: already 1 December there
    expect(await retentionDue(far, p.id, new Date("2026-11-30T20:00:00Z"))).toEqual([]);
    expect(await retentionDue(far, p.id, new Date("2026-12-01T00:00:00Z"))).toHaveLength(1);
    const q = await makeProject(kit, GOV(false).replace("rawDataDestroyAfter: 2026-12-01", "rawDataDestroyAfter: 2026-12-01T10:00"));
    await rawSource(q);
    expect(await retentionDue(far, q.id, new Date("2026-12-01T09:59:00Z"))).toEqual([]);
    expect(await retentionDue(far, q.id, new Date("2026-12-01T10:00:00Z"))).toHaveLength(1);
  });

  it("destroyed files leave the index's duplicate keys", async () => {
    const p = await makeProject(kit, GOV(false));
    const sf = await rawSource(p);
    await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    const after = await kit.repo.getSource(p.id, sf.source.id);
    const db = openIndex(join(kit.tmp));
    try {
      indexSource(db, after);
      expect(findSourceBy(db, { sha256: sf.assets[0]!.sha256 })).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("R94", () => {
  const PASS = "correct horse battery staple";

  it("P5b: a sealed backup unresolved by a locked rebuild is resolved on unlock and destroyed with the data", async () => {
    const p = await makeProject(kit, GOV(true), true);
    const sf = await rawSource(p);
    const old = await backupProject(kit.repo, p.id);
    const mpath = join(kit.lib.root, "Backups", "backups-manifest.json");
    await writeFile(mpath, "{ damaged");
    kit.repo.lockProject(p.id);
    expect(await listBackups(kit.repo, p.id)).toEqual([]);
    expect(JSON.parse(await readFile(mpath, "utf8")).unresolved).toContain(old.path.slice(old.path.lastIndexOf("/") + 1));
    await kit.repo.unlockProject(p.id, PASS);
    // Resolved on unlock.
    const m = JSON.parse(await readFile(mpath, "utf8"));
    expect(m.unresolved ?? []).toEqual([]);
    expect(m.backups.map((b: { projectId: string }) => b.projectId)).toEqual([p.id]);
    kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    expect(existsSync(old.path)).toBe(false);
    expect((r.certificate.backups as { status: string }).status).toBe("deleted");
  });

  it("P5b (renamed): an unreadable sealed backup under another project name still counts for this project (by its key, not its name)", async () => {
    const p = await makeProject(kit, GOV(true), true);
    const sf = await rawSource(p);
    const old = await backupProject(kit.repo, p.id);
    const renamed = join(kit.lib.root, "Backups", "Old Name - backup - modified 2026-11-10 0930.zip.enc");
    const bytes = await readFile(old.path);
    bytes[bytes.length - 40] = bytes[bytes.length - 40]! ^ 0xff; // unreadable even with the key
    await writeFile(renamed, bytes);
    await rm(old.path);
    await writeFile(join(kit.lib.root, "Backups", "backups-manifest.json"), "{ damaged");
    kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    const bk = r.certificate.backups as { status: string; containing: string[] };
    expect(bk.status).toBe("unknown-pending");
    expect(bk.containing).toContain("Backups/Old Name - backup - modified 2026-11-10 0930.zip.enc");
    expect(existsSync(renamed)).toBe(true);
  });

  it("restore leaves out files a destruction certificate names, regenerates manifest.json, and warns retention-due", async () => {
    const p = await makeProject(kit, GOV(true), true, "Gone");
    const sf = await rawSource(p);
    const b = await backupProject(kit.repo, p.id);
    const copy = join(kit.tmp, "offline copy.zip.enc");
    await writeFile(copy, await readFile(b.path));
    kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
    await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    const restored = await restoreBackup(kit.repo, copy);
    expect(restored.warnings).toContain("retention-due");
    expect(restored.notes.join(" ")).toMatch(/destroyed earlier/u);
    const [sid] = kit.repo.listSourceIds(restored.projectId);
    const back = await kit.repo.getSource(restored.projectId, sid!);
    expect(back.assets[0]!.status).toBe("destroyed");
    expect(existsSync(abs(back.assets[0]!.path))).toBe(false);
    const manifest = JSON.parse(await readFile(join(kit.lib.root, restored.folder, "manifest.json"), "utf8"));
    expect(manifest.sources[0].files).not.toContain(back.assets[0]!.path);
  });
});
