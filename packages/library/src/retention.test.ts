import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChain, type Project, type SourceFile } from "@ao/core";
import { backupProject, listBackups } from "./export/backup.js";
import { addSource, auditEvents, makeKit, makeProject, scratchFile, walk, type Kit } from "./export/test-kit.js";
import { SimulatedCrash, seams } from "./repo/testing.js";
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
    const cert = JSON.parse(await readFile(r.certificatePath, "utf8"));
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
