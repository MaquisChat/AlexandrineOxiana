/**
 * R362 b (with R177 b): a reason the researcher types into an ENCRYPTED project is never written to an audit log in
 * plain text. The audit entry records that a reason was given and its SHA-256; the text is kept sealed with the
 * project (the review entry for "Reviewed after the withdrawal"; otherwise the one sealed store of reasons, keyed by
 * the audit entry's sequence number and hash, written in the same crash-safe change as the entry). A project that is
 * not encrypted is unchanged: the reason is audited as typed. The audit screen's reading: the sealed text while the
 * project is unlocked (checked against the SHA-256), a sentence while it is locked or the text is not there.
 */
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditEvent, Project } from "@ao/core";
import { REASON_SEALED_LOCKED, REASON_SEALED_MISMATCH, REASON_SEALED_MISSING } from "@ao/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachConsentDocument } from "../consent-docs.js";
import { OPEN_GOV, PASS, makeKit, makeProject, type Kit } from "../export/test-kit.js";
import { AUDIT_REASONS_FILE, LIBRARY_AUDIT_REASONS_FILE, libraryReasonLine, sealedReasonLine } from "./audit-reasons.js";
import { newAttentionId } from "./attention.js";
import { openLine } from "./io.js";
import { projectDataKey, projectReviewEntries } from "./repo.js";
import { PURPOSE_AUDIT_REASONS } from "./sealed-purposes.js";
import { SimulatedCrash, seams } from "./testing.js";

/** The word every reason carries: it must appear in no plain file of an encrypted project. */
const MARK = "Zebrafinch";
const reasonText = (what: string) => `${MARK} ${what}: at Maria Hollis's request`;
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
/** R369 b: the keyed digest: HMAC-SHA-256 under a key derived (HKDF-SHA-256) from the project's data key for this purpose alone. */
const macKeyOf = (dataKey: Uint8Array) => Buffer.from(hkdfSync("sha256", dataKey, Buffer.alloc(0), "ao-audit-reason-mac", 32));
const macWith = (dataKey: Uint8Array, t: string) => createHmac("sha256", macKeyOf(dataKey)).update(t, "utf8").digest("hex");
const mac = (p: Project, t: string) => macWith(projectDataKey(kit.repo, p.id)!.key, t);

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-audit-reasons-");
});
afterEach(async () => {
  seams.crashAt = undefined;
  await kit.close();
});

const folderOf = (p: Project) => join(kit.lib.root, kit.repo.getProject(p.id).folder);
async function auditBytes(p: Project): Promise<string> {
  const dir = join(folderOf(p), "audit");
  let out = "";
  for (const f of (await readdir(dir)).sort()) out += await readFile(join(dir, f), "latin1");
  return out;
}
async function auditLines(p: Project): Promise<AuditEvent[]> {
  return (await auditBytes(p))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuditEvent);
}
const storePath = (p: Project) => join(folderOf(p), AUDIT_REASONS_FILE);
const storeLines = async (p: Project) => (await readFile(storePath(p), "utf8").catch(() => "")).split("\n").filter((l) => l.trim());

/** Identifiable data allowed without pseudonymized names (a consent's signed form can be attached in a plain project too). */
const GOV = OPEN_GOV.replace("containsIdentifiable: false", "containsIdentifiable: true\n  pseudonymizeFileNames: false");
/** The same with one more capture method: a loosening, which needs a reason. */
const NEW_GOV = GOV.replace("captureMethods: [manual_upload, refman_import, downloader]", "captureMethods: [manual_upload, refman_import, downloader, zotero_import]");

/** One reason-carrying operation: runs it with `reason` and returns the op of its audit entry. */
interface Op {
  name: string;
  op: string;
  /** The text the entry's SHA-256 is of (what the library records: trimmed where it trims). */
  /** `arm` is called just before the call that carries the reason (a crash seam is set there, not earlier). */
  run(p: Project, reason: string, arm?: () => void): Promise<void>;
}

async function unreadableMark(p: Project): Promise<string> {
  const dir = join(folderOf(p), "attention");
  await mkdir(dir, { recursive: true });
  const name = `${newAttentionId()}.json`;
  await writeFile(join(dir, name), "{ damaged");
  return (await kit.repo.attentionMarks(p.id))[0]!.id;
}

const mt = (value: string) => ({ variants: [{ lang: "en", kind: "original" as const, value }] });

const OPS: Op[] = [
  {
    name: "setting a mark aside (the project's log)",
    op: "attention.set-aside",
    async run(p, reason, arm = () => {}) {
      const id = await unreadableMark(p);
      arm();
      expect(await kit.repo.setAsideMark(p.id, id, reason)).toEqual({ recordedIn: "project" });
    },
  },
  {
    name: "a governance edit that loosens the rules",
    op: "project.governance",
    async run(p, reason, arm = () => {}) {
      const g = await kit.repo.getGovernance(p.id);
      arm();
      const r = await kit.repo.setGovernance(p.id, NEW_GOV, { baseSha256: g.sha256, reason });
      expect(r.loosened.length).toBeGreaterThan(0);
    },
  },
  {
    name: "detaching a consent's signed form",
    op: "consent.document-detach",
    async run(p, reason, arm = () => {}) {
      const part = await kit.repo.createParticipant(p.id, {});
      const c = await kit.repo.createConsent(p.id, { participantId: part.id, scope: "audio", date: "2026-03-14" });
      const pdf = join(kit.tmp, `form-${Math.random().toString(36).slice(2)}.pdf`);
      await writeFile(pdf, "%PDF-1.7\nconsent form\n%%EOF\n");
      await attachConsentDocument(kit.repo, p.id, c.id, pdf);
      arm();
      await kit.repo.updateConsent(p.id, c.id, { documentAssetId: null, detachReason: reason });
    },
  },
  {
    name: "Reviewed after the withdrawal (R177 b, its sealed place: the review entry)",
    op: "review.withdrawal-reviewed",
    async run(p, reason, arm = () => {}) {
      const sid = (
        await kit.repo.createSource(
          p.id,
          { projectIds: [], type: "webpage", title: mt("A page"), creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
          [],
          {
            provenance: { captureMethod: "manual_upload", capturedAt: kit.clock.now.toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false },
            reviewItem: { kind: "verification", fields: {}, reasons: ["Consent was withdrawn."], cause: { kind: "consent-withdrawal", consentIds: [] } },
          },
        )
      ).source.id;
      const entry = (await projectReviewEntries(kit.repo, p.id)).find((e) => e.sourceId === sid)!;
      arm();
      await kit.repo.reviewedAfterWithdrawal(p.id, entry.id, reason);
    },
  },
];

const lastOf = async (p: Project, op: string) => (await auditLines(p)).filter((e) => e.details?.op === op && e.decision?.result !== "deny").at(-1)!;
const shownOf = async (p: Project, seq: number) => (await kit.repo.readAudit(p.id, { limit: 1000 })).events.find((e) => e.seq === seq)!.reasonShown;

describe.each(OPS)("$name", ({ op, run }) => {
  it("encrypted: the audit line on disk holds no word of the reason, only that one was given and its keyed digest; the text is sealed and read back while unlocked", async () => {
    const p = await makeProject(kit, GOV, true);
    const reason = reasonText(op);
    await run(p, reason);
    const bytes = await auditBytes(p);
    for (const w of [MARK, "Maria", "Hollis", "request"]) expect(bytes).not.toContain(w);
    const ev = await lastOf(p, op);
    expect(ev.details).toMatchObject({ reasonGiven: true, reasonMac: mac(p, reason) });
    expect(ev.details).not.toHaveProperty("reason");
    // R369 b: no unkeyed digest a guess could be confirmed against; nor one keyed with the data key itself.
    expect(ev.details).not.toHaveProperty("reasonSha256");
    expect(ev.details!.reasonMac).not.toBe(sha(reason));
    expect(ev.details!.reasonMac).not.toBe(createHmac("sha256", projectDataKey(kit.repo, p.id)!.key).update(reason, "utf8").digest("hex"));
    // Readable only with the key: no plain word in the store either (the review entry is sealed already).
    if (op !== "review.withdrawal-reviewed") {
      const lines = await storeLines(p);
      expect(lines.join("\n")).not.toContain(MARK);
      const { key } = projectDataKey(kit.repo, p.id)!;
      const opened = lines.map((l) => JSON.parse(openLine(key, p.id, l, PURPOSE_AUDIT_REASONS)) as { seq: number; hash: string; text: string; reasonMac: string });
      expect(opened).toContainEqual({ seq: ev.seq, hash: ev.hash, reasonMac: mac(p, reason), text: reason });
    }
    expect((await kit.repo.verifyAudit(p.id)).ok).toBe(true);
    expect(await shownOf(p, ev.seq)).toEqual({ state: "text", text: reason });
    // Locked: the sentence, never the text.
    kit.repo.lockProject(p.id);
    expect(await shownOf(p, ev.seq)).toEqual({ state: "locked", message: REASON_SEALED_LOCKED });
    await kit.repo.unlockProject(p.id, PASS);
    expect(await shownOf(p, ev.seq)).toEqual({ state: "text", text: reason });
  });

  it("not encrypted: audited as typed, as before; the chain verifies; the screen shows it", async () => {
    const p = await makeProject(kit, GOV, false);
    const reason = reasonText(op);
    await run(p, reason);
    const ev = await lastOf(p, op);
    expect(ev.details).toMatchObject({ reason });
    expect(ev.details).not.toHaveProperty("reasonGiven");
    expect(ev.details).not.toHaveProperty("reasonMac");
    expect(await stat(storePath(p)).catch(() => null)).toBeNull();
    expect((await kit.repo.verifyAudit(p.id)).ok).toBe(true);
    expect(await shownOf(p, ev.seq)).toEqual({ state: "text", text: reason });
  });
});

describe("reading a sealed reason back", () => {
  it("a sealed text that does not match the entry's keyed digest is said, not shown; a missing one is said", async () => {
    const p = await makeProject(kit, GOV, true);
    const id = await unreadableMark(p);
    await kit.repo.setAsideMark(p.id, id, reasonText("set aside"));
    const ev = await lastOf(p, "attention.set-aside");
    const { key, keyId } = projectDataKey(kit.repo, p.id)!;
    // A line sealed with the right key for this entry, holding another text.
    await writeFile(storePath(p), `${sealedReasonLine(key, keyId, p.id, { seq: ev.seq, hash: ev.hash, reasonMac: mac(p, reasonText("set aside")), text: "another text" })}\n`);
    expect(await shownOf(p, ev.seq)).toEqual({ state: "mismatch", message: REASON_SEALED_MISMATCH });
    await rm(storePath(p));
    expect(await shownOf(p, ev.seq)).toEqual({ state: "missing", message: REASON_SEALED_MISSING });
    kit.repo.lockProject(p.id);
    expect(await shownOf(p, ev.seq)).toEqual({ state: "locked", message: REASON_SEALED_LOCKED });
  });
});

describe("the keyed digest (R369 b)", () => {
  it("differs between two projects for the same text, and is neither the text's SHA-256 nor reproducible without the project's key", async () => {
    const a = await makeProject(kit, GOV, true);
    const b = await makeProject(kit, GOV, true);
    const reason = reasonText("two projects");
    for (const p of [a, b]) await OPS[0]!.run(p, reason);
    const ma = (await lastOf(a, "attention.set-aside")).details!.reasonMac as string;
    const mb = (await lastOf(b, "attention.set-aside")).details!.reasonMac as string;
    expect(ma).toMatch(/^[0-9a-f]{64}$/);
    expect(mb).toMatch(/^[0-9a-f]{64}$/);
    expect(ma).not.toBe(mb);
    expect([ma, mb]).not.toContain(sha(reason));
    // Another key (as anyone without the passphrase would have to guess one) gives another digest.
    expect(macWith(new Uint8Array(32), reason)).not.toBe(ma);
    expect(ma).toBe(mac(a, reason));
    expect((await kit.repo.verifyAudit(a.id)).ok).toBe(true);
    expect((await kit.repo.verifyAudit(b.id)).ok).toBe(true);
  });

  it("an entry written before R369 b, with the reason's SHA-256, is still read and checked by its SHA-256; the chain verifies with both forms", async () => {
    const { runMutation } = await import("./mutate.js");
    const core = (kit.repo as unknown as { core: import("./state.js").RepoCore }).core;
    const p = await makeProject(kit, GOV, true);
    const old = reasonText("written by an earlier build");
    // An entry in R177 b's form, as an earlier build wrote it, and its sealed line.
    await runMutation(core, p.id, { action: "set-aside", setAside: { reason: old } }, async () => undefined, {
      op: "attention.set-aside",
      entity: { type: "project", id: p.id },
      auditDetails: { reasonGiven: true, reasonSha256: sha(old), mark: { kind: "earlier" } },
    });
    const legacy = await lastOf(p, "attention.set-aside");
    expect(legacy.details).not.toHaveProperty("reasonMac");
    const { key, keyId } = projectDataKey(kit.repo, p.id)!;
    await mkdir(join(folderOf(p), "audit-reasons"), { recursive: true });
    await writeFile(storePath(p), `${sealedReasonLine(key, keyId, p.id, { seq: legacy.seq, hash: legacy.hash, reasonSha256: sha(old), text: old })}\n`, { flag: "a" });
    // And a new one, keyed.
    const now = reasonText("written now");
    await OPS[0]!.run(p, now);
    const fresh = await lastOf(p, "attention.set-aside");
    expect(fresh.details).toMatchObject({ reasonMac: mac(p, now) });
    expect((await kit.repo.verifyAudit(p.id)).ok).toBe(true);
    expect(await shownOf(p, legacy.seq)).toEqual({ state: "text", text: old });
    expect(await shownOf(p, fresh.seq)).toEqual({ state: "text", text: now });
    // The legacy entry is checked by its SHA-256: another text sealed for it is a mismatch.
    await writeFile(storePath(p), `${sealedReasonLine(key, keyId, p.id, { seq: legacy.seq, hash: legacy.hash, reasonSha256: sha(old), text: "another text" })}\n`);
    expect(await shownOf(p, legacy.seq)).toEqual({ state: "mismatch", message: REASON_SEALED_MISMATCH });
    kit.repo.lockProject(p.id);
    expect(await shownOf(p, legacy.seq)).toEqual({ state: "locked", message: REASON_SEALED_LOCKED });
  });

  it("the library's log: an entry written before R369 b, with the SHA-256, is still read", async () => {
    const { appendLibraryAudit } = await import("./library-audit.js");
    const core = (kit.repo as unknown as { core: import("./state.js").RepoCore }).core;
    const p = await makeProject(kit, GOV, true);
    const old = reasonText("library, earlier build");
    const ev = await core.serial(() =>
      appendLibraryAudit(core, {
        at: kit.clock.now.toISOString(),
        actor: core.actor,
        device: core.device,
        projectId: p.id,
        action: "set-aside",
        entity: { type: "project", id: p.id },
        decision: { result: "allow" },
        details: { op: "attention.set-aside", reasonGiven: true, reasonSha256: sha(old), mark: { kind: "earlier" }, projectLogNotIntact: true },
      }),
    );
    const { key, keyId } = projectDataKey(kit.repo, p.id)!;
    await writeFile(join(kit.lib.root, LIBRARY_AUDIT_REASONS_FILE), `${libraryReasonLine(key, keyId, p.id, { seq: ev.seq, hash: ev.hash, reasonSha256: sha(old), text: old })}\n`, { flag: "a" });
    expect((await kit.repo.readLibraryAuditPage()).events.find((e) => e.seq === ev.seq)!.reasonShown).toEqual({ state: "text", text: old });
  });
});

describe("a backup of an encrypted project, restored", () => {
  it("keeps the sealed reasons: re-sealed under the new project id, read back against the audit log copied as it was", async () => {
    const { backupProject, restoreBackup } = await import("../export/backup.js");
    const p = await makeProject(kit, GOV, true);
    for (const o of OPS) await o.run(p, reasonText(o.op));
    const r = await backupProject(kit.repo, p.id);
    const restored = await restoreBackup(kit.repo, r.path);
    const q = kit.repo.getProject(restored.projectId) as unknown as Project;
    expect((await storeLines(q)).join("\n")).not.toContain(MARK);
    const shown = (await kit.repo.readAudit(restored.projectId, { limit: 1000 })).events.filter((e) => e.reasonShown);
    expect(Object.fromEntries(OPS.map((o) => [o.op, shown.find((e) => e.details?.op === o.op)?.reasonShown]))).toEqual(Object.fromEntries(OPS.map((o) => [o.op, { state: "text", text: reasonText(o.op) }])));
  });
});

describe("crash safety: the sealed text and its audit entry are one change (R26)", () => {
  const RUN_MUTATION_OPS = OPS.filter((o) => o.op !== "review.withdrawal-reviewed");
  it.each(RUN_MUTATION_OPS)("$name: a crash after the sealed text, before the entry, leaves neither; after the entry, both", async ({ op, run }) => {
    const p = await makeProject(kit, GOV, true);
    const before = (await auditLines(p)).length;
    const linesBefore = (await storeLines(p)).length;
    await expect(run(p, reasonText("crash one"), () => (seams.crashAt = "after-sealed-reason"))).rejects.toBeInstanceOf(SimulatedCrash);
    // The text was written before the entry, under the write-ahead marker; the next open rolls both back.
    expect(await storeLines(p)).toHaveLength(linesBefore + 1);
    await kit.reopen();
    await kit.repo.unlockProject(p.id, PASS).catch(() => {});
    expect((await auditLines(p)).filter((e) => e.details?.op === op && e.decision?.result !== "deny")).toHaveLength(0);
    expect(await storeLines(p)).toHaveLength(linesBefore);
    expect((await auditLines(p)).length).toBeGreaterThanOrEqual(before);
    expect((await kit.repo.verifyAudit(p.id)).ok).toBe(true);

    await expect(run(p, reasonText("crash two"), () => (seams.crashAt = "before-marker-delete"))).rejects.toBeInstanceOf(SimulatedCrash);
    await kit.reopen();
    await kit.repo.unlockProject(p.id, PASS).catch(() => {});
    const ev = await lastOf(p, op);
    expect(ev.details).toMatchObject({ reasonGiven: true, reasonMac: mac(p, reasonText("crash two")) });
    expect(await shownOf(p, ev.seq)).toEqual({ state: "text", text: reasonText("crash two") });
    expect((await kit.repo.verifyAudit(p.id)).ok).toBe(true);
  });
});

describe("a mark set aside while the project's own log cannot take it (the library's log)", () => {
  async function brokenLogProject(): Promise<{ p: Project; id: string }> {
    const p = await makeProject(kit, GOV, true);
    const id = await unreadableMark(p);
    const seg = join(folderOf(p), "audit", "0001.jsonl");
    const lines = (await readFile(seg, "utf8")).split("\n");
    lines[0] = lines[0]!.replace('"actor":"tester"', '"actor":"forged"');
    await writeFile(seg, lines.join("\n"));
    await kit.reopen();
    await kit.repo.unlockProject(p.id, PASS).catch(() => {});
    return { p, id };
  }
  const libraryBytes = async () => {
    const dir = join(kit.lib.root, "audit");
    let out = "";
    for (const f of (await readdir(dir)).sort()) out += await readFile(join(dir, f), "latin1");
    return out;
  };
  const libraryStore = async () => (await readFile(join(kit.lib.root, LIBRARY_AUDIT_REASONS_FILE), "utf8").catch(() => "")).split("\n").filter((l) => l.trim());

  it("encrypted: the library's log holds the mark and the keyed digest only; the text is sealed with the project's key and read back while unlocked", async () => {
    const { p, id } = await brokenLogProject();
    const reason = reasonText("library log");
    expect(await kit.repo.setAsideMark(p.id, id, reason)).toEqual({ recordedIn: "library" });
    const bytes = await libraryBytes();
    for (const w of [MARK, "Maria", "Hollis"]) expect(bytes).not.toContain(w);
    expect((await libraryStore()).join("\n")).not.toContain(MARK);
    const page = await kit.repo.readLibraryAuditPage();
    const ev = page.events.find((e) => e.details?.op === "attention.set-aside")!;
    expect(ev.details).toMatchObject({ reasonGiven: true, reasonMac: mac(p, reason), projectLogNotIntact: true });
    expect(ev.details).not.toHaveProperty("reason");
    expect(ev.details).not.toHaveProperty("reasonSha256");
    expect(ev.reasonShown).toEqual({ state: "text", text: reason });
    expect((await kit.repo.verifyLibraryAudit()).events).toBeGreaterThan(0);
    kit.repo.lockProject(p.id);
    expect((await kit.repo.readLibraryAuditPage()).events.find((e) => e.seq === ev.seq)!.reasonShown).toEqual({ state: "locked", message: REASON_SEALED_LOCKED });
  });

  it("encrypted and locked: refused before anything is written (the text could not be sealed)", async () => {
    const { p, id } = await brokenLogProject();
    kit.repo.lockProject(p.id);
    const before = await libraryBytes().catch(() => "");
    await expect(kit.repo.setAsideMark(p.id, id, reasonText("locked"))).rejects.toThrow();
    expect(await libraryBytes().catch(() => "")).toBe(before);
    expect(await libraryStore()).toEqual([]);
  });

  it("a crash between the sealed text and the library's entry: the text without its entry is removed at the next open", async () => {
    const { p, id } = await brokenLogProject();
    seams.crashAt = "library-reason-before-entry";
    await expect(kit.repo.setAsideMark(p.id, id, reasonText("library crash"))).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await libraryStore()).toHaveLength(1);
    await kit.reopen();
    expect(await libraryStore()).toHaveLength(0);
    expect((await kit.repo.readLibraryAuditPage()).events.some((e) => e.details?.op === "attention.set-aside")).toBe(false);
    // The mark is still there, and can be set aside again.
    await kit.repo.unlockProject(p.id, PASS).catch(() => {});
    expect(await kit.repo.setAsideMark(p.id, id, reasonText("again"))).toEqual({ recordedIn: "library" });
    expect(await libraryStore()).toHaveLength(1);
  });

  it("not encrypted: as before, the reason as typed in the library's log", async () => {
    const p = await makeProject(kit, GOV, false);
    const id = await unreadableMark(p);
    const seg = join(folderOf(p), "audit", "0001.jsonl");
    const lines = (await readFile(seg, "utf8")).split("\n");
    lines[0] = lines[0]!.replace('"actor":"tester"', '"actor":"forged"');
    await writeFile(seg, lines.join("\n"));
    await kit.reopen();
    expect(await kit.repo.setAsideMark(p.id, id, "plain words")).toEqual({ recordedIn: "library" });
    const ev = (await kit.repo.readLibraryAuditPage()).events.find((e) => e.details?.op === "attention.set-aside")!;
    expect(ev.details).toMatchObject({ reason: "plain words" });
    expect(ev.reasonShown).toEqual({ state: "text", text: "plain words" });
    expect(await libraryStore()).toEqual([]);
  });
});

describe("no plain file anywhere holds a word of a reason typed into an encrypted project", () => {
  it("after every reason-carrying operation, a search of every file under the library and the app's folder finds the marker word nowhere", async () => {
    const p = await makeProject(kit, GOV, true);
    for (const o of OPS) await o.run(p, reasonText(o.op));
    // And the library's log path.
    const id = await unreadableMark(p);
    const seg = join(folderOf(p), "audit", "0001.jsonl");
    const lines = (await readFile(seg, "utf8")).split("\n");
    lines[0] = lines[0]!.replace('"actor":"tester"', '"actor":"forged"');
    await writeFile(seg, lines.join("\n"));
    await kit.reopen();
    await kit.repo.unlockProject(p.id, PASS).catch(() => {});
    await kit.repo.setAsideMark(p.id, id, reasonText("library"));
    const found: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile() && (await readFile(abs)).includes(MARK)) found.push(abs.slice(kit.tmp.length));
      }
    }
    await walk(kit.tmp);
    // The PDF fixtures written by the test itself are not the library's.
    expect(found.filter((f) => !f.endsWith(".pdf"))).toEqual([]);
  });
});
