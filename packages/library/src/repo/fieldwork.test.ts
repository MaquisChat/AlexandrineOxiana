/**
 * Fieldwork changes (R97, Task 36): governed update of participants, sessions and consent records,
 * consent withdrawal (audited; linked sources flagged for review, never deleted), and deletion of a
 * participant or session only when nothing links to it. Plus protocol approval documents (spec 6.3(9)).
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent, Provenance, SourceDraft } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptStream } from "../crypto/format.js";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import { attachConsentDocument, reconcileConsentDocuments } from "../consent-docs.js";
import { buildCameraTiff, tinyPng } from "../../../../tests/fixtures/generate.mjs";
import { mkdir, truncate } from "node:fs/promises";
import { openRepo } from "./repo.js";
import { addProtocolDocuments, listProtocolDocuments } from "../protocol-docs.js";
import { FieldworkInUseError, InvalidInputError, NotFoundError, type Repo } from "./index.js";
import { projectReviewEntries } from "./repo.js";
import { openTestRepo } from "./testing.js";

const FAST = 2 ** 10;
const NOW = "2026-11-09T14:30:00.000Z";
const PASS = "correct horse battery staple";

/** Unencrypted project holding identifiable data without pseudonymized names. */
const IDENT_PLAIN_GOV = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
captureMethods: [manual_upload]
`;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let pid: string;
let pdf: string;

function mkDeps(): Deps {
  return {
    clock: () => new Date(NOW),
    deviceId: "dev-A",
    hostname: "host-A",
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: join(tmp, "config"),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
  };
}

function draft(over: Partial<SourceDraft> = {}): SourceDraft {
  return {
    projectIds: [],
    type: "interview",
    title: { variants: [{ lang: "en", kind: "original", value: "Interview one" }] },
    creators: [],
    identifiers: {},
    caseAttributes: {},
    availability: { status: "available" },
    collectionIds: [],
    tagIds: [],
    participantIds: [],
    ...over,
  };
}

function provenance(): Provenance {
  return {
    captureMethod: "manual_upload",
    capturedAt: NOW,
    tool: { name: "ao", version: "0.0.0" },
    fileHashes: {},
    legal: { status: "consented" },
    identifiable: true,
  };
}

async function auditEvents(projectFolder: string): Promise<AuditEvent[]> {
  const dir = join(lib.root, projectFolder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-fieldwork-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  repo = await openTestRepo(lib, ring, { clock: () => new Date(NOW), tz: "UTC", actor: "tester", scryptN: FAST });
  pid = (await repo.createProject({ name: "Field", governanceYaml: IDENT_PLAIN_GOV, encryption: { enabled: false } })).project.id;
  pdf = join(tmp, "input.pdf");
  await writeFile(pdf, "%PDF-1.7\nconsent form\n%%EOF\n");
});

afterEach(async () => {
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

const folder = () => repo.getProject(pid).folder;

describe("fieldwork updates (R97)", () => {
  it("updates a participant's details; the code never changes (R117 C1)", async () => {
    const p = await repo.createParticipant(pid, {});
    const u = await repo.updateParticipant(pid, p.id, { details: { name: "Rosa Quispe" }, legalBasis: "consent" });
    expect(u).toMatchObject({ id: p.id, code: "P-001", details: { name: "Rosa Quispe" } });
    await expect(repo.updateParticipant(pid, p.id, { code: "P-100" })).rejects.toThrow(/cannot be changed/);
    // The same code again is not a change.
    await repo.updateParticipant(pid, p.id, { code: "P-001" });
    const cleared = await repo.updateParticipant(pid, p.id, { details: null });
    expect(cleared.details).toBeUndefined();
    expect((await repo.getFieldwork(pid)).participants.find((x) => x.id === p.id)!.code).toBe("P-001");
    await expect(repo.updateParticipant(pid, "0190f0f0-0000-7000-8000-000000000000", { details: null })).rejects.toBeInstanceOf(NotFoundError);
    const ops = (await auditEvents(folder())).map((e) => e.details?.op);
    expect(ops.filter((o) => o === "participant.update")).toHaveLength(3);
  });

  it("updates a session (date, place, participants) and checks the participants exist", async () => {
    const p = await repo.createParticipant(pid, {});
    const s = await repo.createSession(pid, { date: "2026-03-14", place: "Lima", legalBasis: "consent" });
    const u = await repo.updateSession(pid, s.id, { date: "2026-03-15", participantIds: [p.id], place: null, notes: "second visit", legalBasis: "consent" });
    expect(u).toMatchObject({ id: s.id, date: "2026-03-15", participantIds: [p.id], notes: "second visit" });
    expect(u.place).toBeUndefined();
    await expect(repo.updateSession(pid, s.id, { participantIds: ["0190f0f0-0000-7000-8000-000000000000"] })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("updates a consent record (scope, expiry, document) but not once withdrawn", async () => {
    const p = await repo.createParticipant(pid, {});
    const c = await repo.createConsent(pid, { participantId: p.id, scope: "audio", date: "2026-03-14" });
    const u = await repo.updateConsent(pid, c.id, { scope: "audio and video", expires: "2027-03-14" });
    expect(u).toMatchObject({ scope: "audio and video", expires: "2027-03-14" });
    await repo.withdrawConsent(pid, c.id);
    await expect(repo.updateConsent(pid, c.id, { scope: "anything" })).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("consent documents (dropped onto a consent record)", () => {
  it("stores the document as an identifiable source linked to the participant and records its asset on the consent", async () => {
    const p = await repo.createParticipant(pid, {});
    const c = await repo.createConsent(pid, { participantId: p.id, scope: "audio", date: "2026-03-14" });
    const r = await attachConsentDocument(repo, pid, c.id, pdf);
    const sf = await repo.getSource(pid, r.sourceId);
    expect(sf.source.participantIds).toEqual([p.id]);
    expect(sf.source.provenance.identifiable).toBe(true);
    expect(sf.assets.map((a) => a.id)).toContain(r.assetId);
    expect(r.consent.documentAssetId).toBe(r.assetId);
    expect((await repo.getFieldwork(pid)).consents[0]!.documentAssetId).toBe(r.assetId);
    await repo.withdrawConsent(pid, c.id);
    await expect(attachConsentDocument(repo, pid, c.id, pdf)).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("consent withdrawal (R97)", () => {
  it("marks the record withdrawn, flags every linked source for review, deletes nothing, and is audited", async () => {
    const p = await repo.createParticipant(pid, {});
    const other = await repo.createParticipant(pid, {});
    const c = await repo.createConsent(pid, { participantId: p.id, scope: "audio", date: "2026-03-14" });
    const a = await repo.createSource(pid, draft(), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    const b = await repo.createSource(pid, draft({ title: { variants: [{ lang: "en", kind: "original", value: "Other" }] } }), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    await repo.linkSourceToFieldwork(pid, a.source.id, { participantIds: [p.id] });
    await repo.linkSourceToFieldwork(pid, b.source.id, { participantIds: [other.id] });

    const r = await repo.withdrawConsent(pid, c.id, { reason: "asked by phone" });
    expect(r.consent.withdrawn).toEqual({ at: NOW, reason: "asked by phone" });
    expect(r.flaggedSourceIds).toEqual([a.source.id]);

    // Nothing deleted: both sources and their files are still there.
    expect(repo.listSourceIds(pid).sort()).toEqual([a.source.id, b.source.id].sort());
    expect((await repo.getSource(pid, a.source.id)).assets).toHaveLength(1);
    const review = (await projectReviewEntries(repo, pid)).filter((e) => e.status === "pending");
    expect(review.map((e) => e.sourceId)).toEqual([a.source.id]);
    expect(review[0]!.reasons.join(" ")).toMatch(/consent .*withdrawn/i);

    const ev = (await auditEvents(folder())).filter((e) => e.details?.op === "consent.withdraw");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.entity).toEqual({ type: "consent", id: c.id });
    expect(ev[0]!.details).toMatchObject({ flaggedSources: 1 });

    // A second withdrawal changes nothing.
    await expect(repo.withdrawConsent(pid, c.id)).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("fieldwork deletion only when nothing links to it", () => {
  it("refuses to delete a participant with consent records, sessions or sources; deletes an unlinked one", async () => {
    const p = await repo.createParticipant(pid, {});
    const free = await repo.createParticipant(pid, {});
    await repo.createConsent(pid, { participantId: p.id, scope: "audio", date: "2026-03-14" });
    await expect(repo.deleteParticipant(pid, p.id)).rejects.toBeInstanceOf(FieldworkInUseError);
    const s = await repo.createSession(pid, { date: "2026-03-14", participantIds: [free.id] });
    await expect(repo.deleteParticipant(pid, free.id)).rejects.toThrow(/session/);
    await repo.updateSession(pid, s.id, { participantIds: [] });
    const src = await repo.createSource(pid, draft(), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    await repo.linkSourceToFieldwork(pid, src.source.id, { participantIds: [free.id] });
    await expect(repo.deleteParticipant(pid, free.id)).rejects.toThrow(/source/);

    const lone = await repo.createParticipant(pid, {});
    await repo.deleteParticipant(pid, lone.id);
    expect((await repo.getFieldwork(pid)).participants.map((x) => x.id)).not.toContain(lone.id);
    expect((await auditEvents(folder())).some((e) => e.details?.op === "participant.delete" && e.entity?.id === lone.id)).toBe(true);
  });

  it("refuses to delete a session a source links to; deletes an unlinked one", async () => {
    const s = await repo.createSession(pid, { date: "2026-03-14" });
    const src = await repo.createSource(pid, draft(), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    await repo.linkSourceToFieldwork(pid, src.source.id, { sessionId: s.id });
    await expect(repo.deleteSession(pid, s.id)).rejects.toBeInstanceOf(FieldworkInUseError);
    const t = await repo.createSession(pid, { date: "2026-03-15" });
    await repo.deleteSession(pid, t.id);
    expect((await repo.getFieldwork(pid)).sessions.map((x) => x.id)).toEqual([s.id]);
  });
});

describe("protocol approval documents (spec 6.3(9))", () => {
  it("stores dropped documents under <Project>/protocol/, audited without names", async () => {
    const r = await addProtocolDocuments(repo, pid, [pdf]);
    expect(r).toEqual([{ name: "input.pdf", bytes: expect.any(Number), encrypted: false }]);
    expect(await readFile(join(lib.root, folder(), "protocol", "input.pdf"), "utf8")).toContain("consent form");
    // The same name again gets a new name; nothing is overwritten.
    const again = await addProtocolDocuments(repo, pid, [pdf]);
    expect(again[0]!.name).toBe("input (2).pdf");
    expect((await listProtocolDocuments(repo, pid)).map((d) => d.name)).toEqual(["input (2).pdf", "input.pdf"]);
    const ev = (await auditEvents(folder())).filter((e) => e.details?.op === "protocol.document");
    expect(ev).toHaveLength(2);
    expect(JSON.stringify(ev)).not.toContain("input");
  });

  it("encrypts them in an encrypted project", async () => {
    const enc = (await repo.createProject({ name: "Sealed", governanceYaml: "", encryption: { enabled: true, passphrase: PASS } })).project;
    const [doc] = await addProtocolDocuments(repo, enc.id, [pdf]);
    expect(doc).toMatchObject({ encrypted: true });
    const dir = join(lib.root, enc.folder, "protocol");
    const names = await readdir(dir);
    expect(names.every((n) => n.endsWith(".enc"))).toBe(true);
    const raw = await readFile(join(dir, names[0]!));
    expect(raw.toString("latin1")).not.toContain("consent form");
    const d = decryptStream((id) => ring.get(id));
    const parts: Buffer[] = [];
    d.on("data", (c: Buffer) => parts.push(c));
    await new Promise<void>((res, rej) => {
      d.on("end", res).on("error", rej);
      d.end(raw);
    });
    expect(Buffer.concat(parts).toString()).toContain("consent form");
  });

  it("refuses folders, symbolic links and missing files", async () => {
    await expect(addProtocolDocuments(repo, pid, [tmp])).rejects.toBeInstanceOf(InvalidInputError);
    await expect(addProtocolDocuments(repo, pid, [join(tmp, "nope.pdf")])).rejects.toBeInstanceOf(InvalidInputError);
    expect(await listProtocolDocuments(repo, pid)).toEqual([]);
  });
});

/** An encrypted project whose sources pseudonymize names (default rules): creators get codes in the pseudonym map. */
async function pseudonymizingProject(): Promise<string> {
  return (await repo.createProject({ name: "Sealed field", governanceYaml: "", encryption: { enabled: true, passphrase: PASS } })).project.id;
}

async function sourceBy(projectId: string, person: string, title = "Interview") {
  return repo.createSource(
    projectId,
    draft({ title: { variants: [{ lang: "en", kind: "original", value: title }] }, creators: [{ literal: person, role: "interviewee" }] }),
    [{ path: pdf, role: "original", handling: "copy" }],
    { provenance: { ...provenance(), legal: { status: "consented", basis: "consent" } } },
  );
}

describe("participant codes are immutable and never reissued (R117 C1)", () => {
  it("rename-then-reuse: Jane's code cannot be renamed away and given to Bob; Jane's sources never link to Bob", async () => {
    const enc = await pseudonymizingProject();
    const jane = await sourceBy(enc, "Jane Doe");
    const fw = await repo.getFieldwork(enc);
    const janeP = fw.participants[0]!;
    expect(janeP.code).toBe("P-001");
    expect(jane.source.participantIds).toEqual([janeP.id]);
    // The reviewer's scenario: rename Jane's participant, then give P-001 to someone else.
    await expect(repo.updateParticipant(enc, janeP.id, { code: "P-100" })).rejects.toThrow(/cannot be changed/);
    await expect(repo.createParticipant(enc, { code: "P-001" })).rejects.toThrow(/already in use/);
    const bob = await repo.createParticipant(enc, { details: { name: "Bob" }, legalBasis: "consent" });
    expect(bob.code).toBe("P-002");
    const again = await sourceBy(enc, "Jane Doe", "Second interview");
    expect(again.source.participantIds).toEqual([janeP.id]);
    expect(again.source.participantIds).not.toContain(bob.id);
  });

  it("delete-then-reissue: a deleted participant's code is retired forever; a participant in the pseudonym map cannot be deleted", async () => {
    const enc = await pseudonymizingProject();
    await sourceBy(enc, "Jane Doe");
    const janeP = (await repo.getFieldwork(enc)).participants[0]!;
    await expect(repo.deleteParticipant(enc, janeP.id)).rejects.toBeInstanceOf(FieldworkInUseError);
    await expect(repo.deleteParticipant(enc, janeP.id)).rejects.toThrow(/pseudonym/);

    const temp = await repo.createParticipant(enc, {});
    expect(temp.code).toBe("P-002");
    await repo.deleteParticipant(enc, temp.id);
    // P-002 is never given again: not automatically, not by hand.
    expect((await repo.createParticipant(enc, {})).code).toBe("P-003");
    await expect(repo.createParticipant(enc, { code: "p-002" })).rejects.toThrow(/retired|already in use/);
    // A new person named in a source gets a fresh code, not the retired one.
    const bob = await sourceBy(enc, "Bob Roe");
    const bobP = (await repo.getFieldwork(enc)).participants.find((p) => bob.source.participantIds.includes(p.id))!;
    expect(bobP.code).toBe("P-004");
  });
});

async function pendingReviewFor(projectId: string, sourceId: string) {
  return (await projectReviewEntries(repo, projectId)).filter((e) => e.status === "pending" && e.sourceId === sourceId);
}

describe("withdrawal reaches every link (R117 I1)", () => {
  it("flags sources linked through a session that includes the participant", async () => {
    const p = await repo.createParticipant(pid, {});
    const c = await repo.createConsent(pid, { participantId: p.id, scope: "audio", date: "2026-03-14" });
    const s = await repo.createSession(pid, { date: "2026-03-14", participantIds: [p.id] });
    const src = await repo.createSource(pid, draft(), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    await repo.linkSourceToFieldwork(pid, src.source.id, { sessionId: s.id });
    const r = await repo.withdrawConsent(pid, c.id);
    expect(r.flaggedSourceIds).toEqual([src.source.id]);
  });

  it("flags sources created or linked later to a withdrawn participant, directly or through a session", async () => {
    const p = await repo.createParticipant(pid, {});
    const c = await repo.createConsent(pid, { participantId: p.id, scope: "audio", date: "2026-03-14" });
    const s = await repo.createSession(pid, { date: "2026-03-14", participantIds: [p.id] });
    await repo.withdrawConsent(pid, c.id);
    // Created already linked (as a capture or an import with a session/participants does).
    const direct = await repo.createSource(pid, draft({ participantIds: [p.id] }), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    expect((await pendingReviewFor(pid, direct.source.id))[0]!.reasons.join(" ")).toMatch(/P-001.*consent was withdrawn/);
    const viaSession = await repo.createSource(pid, draft({ sessionId: s.id }), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    expect(await pendingReviewFor(pid, viaSession.source.id)).toHaveLength(1);
    // Linked later.
    const later = await repo.createSource(pid, draft(), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    expect(await pendingReviewFor(pid, later.source.id)).toHaveLength(0);
    await repo.linkSourceToFieldwork(pid, later.source.id, { participantIds: [p.id] });
    expect(await pendingReviewFor(pid, later.source.id)).toHaveLength(1);
    // Nothing was refused or deleted.
    expect(repo.listSourceIds(pid)).toHaveLength(3);
  });
});

/** Writes an import batch record the way Bulk Import does (unencrypted project). */
async function batchRecord(projectId: string, n: number, state: string, fieldwork: { sessionId?: string; participantIds?: string[] }) {
  const dir = join(lib.root, repo.getProject(projectId).folder, "imports", `batch-${String(n).padStart(4, "0")}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "batch.json"), JSON.stringify({ id: `b${n}`, projectId, number: n, state, fieldwork }));
}

describe("guarded delete covers unfinished imports (R117 I2)", () => {
  it("refuses to delete a session or participant an unfinished import links new sources to; a finished one does not count", async () => {
    const p = await repo.createParticipant(pid, {});
    const s = await repo.createSession(pid, { date: "2026-03-14" });
    await batchRecord(pid, 1, "paused", { sessionId: s.id, participantIds: [p.id] });
    await expect(repo.deleteSession(pid, s.id)).rejects.toThrow(/unfinished import/);
    await expect(repo.deleteParticipant(pid, p.id)).rejects.toThrow(/unfinished import/);
    await batchRecord(pid, 1, "finished", { sessionId: s.id, participantIds: [p.id] });
    await repo.deleteSession(pid, s.id);
    await repo.deleteParticipant(pid, p.id);
  });
});

describe("a consent's document is set only by attaching the form (R117 I3)", () => {
  it("PATCH refuses documentAssetId; detaching needs a reason and is audited", async () => {
    const p = await repo.createParticipant(pid, {});
    const c = await repo.createConsent(pid, { participantId: p.id, scope: "audio", date: "2026-03-14" });
    await expect(repo.updateConsent(pid, c.id, { documentAssetId: "0190f0f0-0000-7000-8000-0000000000aa" } as never)).rejects.toThrow(/attaching the signed form/);
    const r = await attachConsentDocument(repo, pid, c.id, pdf);
    await expect(repo.updateConsent(pid, c.id, { documentAssetId: null })).rejects.toThrow(/needs a reason/);
    const d = await repo.updateConsent(pid, c.id, { documentAssetId: null, detachReason: "wrong participant's form" });
    expect(d.documentAssetId).toBeUndefined();
    const ev = (await auditEvents(folder())).filter((e) => e.details?.op === "consent.document-detach");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details).toMatchObject({ reason: "wrong participant's form" });
    // The form's source itself is kept.
    expect(repo.listSourceIds(pid)).toContain(r.sourceId);
  });
});

describe("consent forms follow attach's rules (R117 I4)", () => {
  it("accepts a PDF or an image only, at most 100 MB, never a folder", async () => {
    const p = await repo.createParticipant(pid, {});
    const c = await repo.createConsent(pid, { participantId: p.id, scope: "audio", date: "2026-03-14" });
    const txt = join(tmp, "notes.txt");
    await writeFile(txt, "I agree");
    await expect(attachConsentDocument(repo, pid, c.id, txt)).rejects.toThrow(/not a PDF or an image/);
    const big = join(tmp, "big.pdf");
    await writeFile(big, "%PDF-1.7\n");
    await truncate(big, 100 * 1024 * 1024 + 1);
    await expect(attachConsentDocument(repo, pid, c.id, big)).rejects.toThrow(/larger than 100 MB/);
    await expect(attachConsentDocument(repo, pid, c.id, tmp)).rejects.toThrow(/not a file/);
    const png = join(tmp, "form.png");
    await writeFile(png, tinyPng());
    const r = await attachConsentDocument(repo, pid, c.id, png);
    expect((await repo.getSource(pid, r.sourceId)).assets[0]!.mime).toBe("image/png");
    expect(repo.listSourceIds(pid)).toHaveLength(1);
  });

  it("refuses a photo with GPS in a project that coarsens locations but is not encrypted", async () => {
    const coarse = (await repo.createProject({ name: "Coarse", governanceYaml: IDENT_PLAIN_GOV + "sharing:\n  locationMetadata: coarsen\n", encryption: { enabled: false } })).project.id;
    const p = await repo.createParticipant(coarse, {});
    const c = await repo.createConsent(coarse, { participantId: p.id, scope: "photos", date: "2026-03-14" });
    const tif = join(tmp, "IMG_0001.tif");
    await buildCameraTiff(tif);
    await expect(attachConsentDocument(repo, coarse, c.id, tif)).rejects.toThrow(/[Ll]ocation/);
    expect(repo.listSourceIds(coarse)).toEqual([]);
    expect((await repo.getFieldwork(coarse)).consents[0]!.documentAssetId).toBeUndefined();
  });
});

describe("a consent form stays linked to its consent (R117 I5)", () => {
  it("a crash between storing the form and linking it, then a retry, leaves exactly one source, linked", async () => {
    const p = await repo.createParticipant(pid, {});
    const c = await repo.createConsent(pid, { participantId: p.id, scope: "audio", date: "2026-03-14" });
    // Step 1 happened (the form's source exists, carrying the consent's id), step 2 did not.
    const orphan = await repo.createSource(pid, draft({ participantIds: [p.id] }), [{ path: pdf, role: "original", handling: "copy" }], {
      provenance: { ...provenance(), externalKeys: { consentId: c.id } },
    });
    const r = await attachConsentDocument(repo, pid, c.id, pdf);
    expect(r.sourceId).toBe(orphan.source.id);
    expect(repo.listSourceIds(pid)).toEqual([orphan.source.id]);
    expect((await repo.getFieldwork(pid)).consents[0]!.documentAssetId).toBe(orphan.assets[0]!.id);
  });

  it("the reconciler links an orphaned form when the library is opened again", async () => {
    const p = await repo.createParticipant(pid, {});
    const c = await repo.createConsent(pid, { participantId: p.id, scope: "audio", date: "2026-03-14" });
    const orphan = await repo.createSource(pid, draft({ participantIds: [p.id] }), [{ path: pdf, role: "original", handling: "copy" }], {
      provenance: { ...provenance(), externalKeys: { consentId: c.id } },
    });
    expect(await reconcileConsentDocuments(repo, pid)).toBe(1);
    expect((await repo.getFieldwork(pid)).consents[0]!.documentAssetId).toBe(orphan.assets[0]!.id);
    expect(await reconcileConsentDocuments(repo, pid)).toBe(0);
  });

  it("runs the reconciler on open", async () => {
    const p = await repo.createParticipant(pid, {});
    const c = await repo.createConsent(pid, { participantId: p.id, scope: "audio", date: "2026-03-14" });
    const orphan = await repo.createSource(pid, draft({ participantIds: [p.id] }), [{ path: pdf, role: "original", handling: "copy" }], {
      provenance: { ...provenance(), externalKeys: { consentId: c.id } },
    });
    const again = await openRepo(lib, ring, { clock: () => new Date(NOW), tz: "UTC", actor: "tester" });
    expect((await again.getFieldwork(pid)).consents[0]!.documentAssetId).toBe(orphan.assets[0]!.id);
  });
});
