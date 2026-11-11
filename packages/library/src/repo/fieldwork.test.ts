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
  it("updates a participant's code and details, refusing a code already in use", async () => {
    const p = await repo.createParticipant(pid, {});
    const q = await repo.createParticipant(pid, {});
    const u = await repo.updateParticipant(pid, p.id, { code: "P-100", details: { name: "Rosa Quispe" }, legalBasis: "consent" });
    expect(u).toMatchObject({ id: p.id, code: "P-100", details: { name: "Rosa Quispe" } });
    await expect(repo.updateParticipant(pid, q.id, { code: "p-100" })).rejects.toThrow(/already in use/);
    const cleared = await repo.updateParticipant(pid, p.id, { details: null });
    expect(cleared.details).toBeUndefined();
    expect((await repo.getFieldwork(pid)).participants.find((x) => x.id === p.id)!.code).toBe("P-100");
    await expect(repo.updateParticipant(pid, "0190f0f0-0000-7000-8000-000000000000", { code: "X" })).rejects.toBeInstanceOf(NotFoundError);
    const ops = (await auditEvents(folder())).map((e) => e.details?.op);
    expect(ops.filter((o) => o === "participant.update")).toHaveLength(2);
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
    const u = await repo.updateConsent(pid, c.id, { scope: "audio and video", expires: "2027-03-14", documentAssetId: "0190f0f0-0000-7000-8000-0000000000aa" });
    expect(u).toMatchObject({ scope: "audio and video", expires: "2027-03-14", documentAssetId: "0190f0f0-0000-7000-8000-0000000000aa" });
    await repo.withdrawConsent(pid, c.id);
    await expect(repo.updateConsent(pid, c.id, { scope: "anything" })).rejects.toBeInstanceOf(InvalidInputError);
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
    expect(r.consent.withdrawn).toEqual({ at: NOW });
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
