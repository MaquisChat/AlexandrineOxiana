/**
 * A conflict found by a later check enters the review queue (Task 72, defect D19, R190): a governed
 * change that leaves an existing source with a field newly in conflict writes (or extends) the
 * source's capture-conflict entry in the same change, its cause recorded as a later check; it is
 * settled exactly as R176 and R177 say.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recheckSourceFile, type FieldEvidence, type Project, type SourceDraft } from "@ao/core";
import { OPEN_GOV, PASS, auditEvents, makeKit, makeProject, type Kit } from "./export/test-kit.js";
import { openLibrary } from "./library.js";
import { ProjectLockedError, ReadOnlyLibraryError } from "./repo/errors.js";
import { projectReviewEntries, updateSourceRechecked } from "./repo/repo.js";
import { REVIEW_FILE, reviewCauseOf } from "./repo/review.js";
import { SimulatedCrash, openTestRepo, seams } from "./repo/testing.js";
import { confirmField } from "./source-actions.js";

let kit: Kit;
let p: Project;
beforeEach(async () => {
  kit = await makeKit("ao-review-later-");
  p = await makeProject(kit, OPEN_GOV);
});
afterEach(async () => {
  seams.crashAt = undefined;
  await kit.close();
});

const mt = (value: string) => ({ variants: [{ lang: "en", kind: "original" as const, value }] });
const draft = (title: string, extra: Partial<SourceDraft> = {}): SourceDraft => ({
  projectIds: [],
  type: "webpage",
  title: mt(title),
  creators: [],
  identifiers: {},
  caseAttributes: {},
  availability: { status: "available" },
  collectionIds: [],
  tagIds: [],
  participantIds: [],
  ...extra,
});
const provenance = () => ({ captureMethod: "manual_upload" as const, capturedAt: kit.clock.now.toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" as const }, identifiable: false });

/** An existing source: its title and date each from one page, nothing against them, no review entry. */
async function existing(projectId = p.id) {
  const at = kit.clock.now.toISOString();
  const page = { kind: "page-dom" as const };
  const fieldEvidence: FieldEvidence[] = [
    { field: "/title", value: "Rivers and Memory", source: page, at },
    { field: "/issued", value: "2019", source: page, at },
  ];
  const base = await kit.repo.createSource(projectId, draft("Rivers and Memory", { issued: "2019" }), [], { provenance: provenance(), fieldEvidence });
  const sf = await updateSourceRechecked(kit.repo, projectId, base.source.id, {}, { verification: (n) => recheckSourceFile(n, {}).verification });
  expect(sf.verification["/title"]?.status).not.toBe("conflict");
  expect(sf.verification["/issued"]?.status).not.toBe("conflict");
  return sf.source.id;
}

/**
 * A later check adding data to the source, as a browser capture with the downloader ticked does
 * (`browser-capture.ts`): the platform's values are added as evidence and the report is recomputed,
 * in one governed change.
 */
async function laterCheck(sid: string, values: Record<string, unknown>, projectId = p.id) {
  const at = kit.clock.now.toISOString();
  const evidence: FieldEvidence[] = Object.entries(values).map(([field, value]) => ({ field, value, source: { kind: "platform-json" as const }, at }));
  return updateSourceRechecked(kit.repo, projectId, sid, {}, {
    fieldEvidence: (cur) => [...cur.fieldEvidence, ...evidence],
    verification: (next) => recheckSourceFile(next, {}).verification,
  });
}

const entriesOf = async (sid: string, projectId = p.id) => (await projectReviewEntries(kit.repo, projectId)).filter((e) => e.sourceId === sid);
const pendingOf = async (sid: string, projectId = p.id) => (await entriesOf(sid, projectId)).filter((e) => e.status === "pending");
const reviewText = async (projectId = p.id) => readFile(join(kit.lib.root, kit.repo.getProject(projectId).folder, ...REVIEW_FILE.split("/")), "utf8").catch(() => "");
const reviewLineCount = async (projectId = p.id) => (await reviewText(projectId)).split("\n").filter(Boolean).length;

describe("a field newly in conflict after a later check is queued in the same change (R190 a)", () => {
  it("writes one pending capture-conflict entry naming the field, its cause a later check; audited once", async () => {
    const sid = await existing();
    expect(await entriesOf(sid)).toEqual([]);
    const before = await auditEvents(kit, p);
    const sf = await laterCheck(sid, { "/title": "Rivers and Memories" });
    expect(sf.verification["/title"]?.status).toBe("conflict");
    const pending = await pendingOf(sid);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "verification", status: "pending", fields: { "/title": "conflict" }, cause: { kind: "capture-conflict", foundBy: "later-check" } });
    expect(pending[0]!.reasons.length).toBeGreaterThan(0);
    expect(reviewCauseOf(pending[0]!)?.kind).toBe("capture-conflict");
    const added = (await auditEvents(kit, p)).slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ details: { op: "source.update", reviewQueued: { entry: pending[0]!.id, fields: ["/title"] } } });
  });

  it("a second later check adding another conflicting field extends the same entry rather than writing a second", async () => {
    const sid = await existing();
    await laterCheck(sid, { "/title": "Rivers and Memories" });
    const [first] = await pendingOf(sid);
    await laterCheck(sid, { "/issued": "2020" });
    const pending = await pendingOf(sid);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(first!.id);
    expect(pending[0]!.fields).toEqual({ "/title": "conflict", "/issued": "conflict" });
    expect(pending[0]!.reasons.length).toBeGreaterThan(first!.reasons.length);
    expect((await auditEvents(kit, p)).at(-1)).toMatchObject({ details: { reviewQueued: { entry: first!.id, fields: ["/issued"] } } });
  });

  it("extends a capture's own pending entry, keeping the cause that queued it", async () => {
    const at = kit.clock.now.toISOString();
    const page = { kind: "page-dom" as const };
    const sf = await kit.repo.createSource(p.id, draft("Rivers and Memory", { issued: "2019" }), [], {
      provenance: provenance(),
      fieldEvidence: [
        { field: "/title", value: "Rivers and Memory", source: page, at },
        { field: "/issued", value: "2019", source: page, at },
      ],
      verification: { "/creators": { status: "unverified", checks: [], reason: "No creator was found." } },
      reviewItem: { fields: { "/creators": "unverified" }, reasons: ["No creator."], cause: { kind: "capture-conflict" } },
    });
    const sid = sf.source.id;
    const [captured] = await pendingOf(sid);
    await laterCheck(sid, { "/issued": "2020" });
    const pending = await pendingOf(sid);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: captured!.id, cause: { kind: "capture-conflict" }, fields: { "/creators": "unverified", "/issued": "conflict" } });
    expect(pending[0]!.cause).toEqual({ kind: "capture-conflict" });
  });

  it("nothing is written for a field that merely stays in conflict", async () => {
    const sid = await existing();
    await laterCheck(sid, { "/title": "Rivers and Memories" });
    const lines = await reviewLineCount();
    const sf = await laterCheck(sid, { "/title": "Rivers and Memories!" });
    expect(sf.verification["/title"]?.status).toBe("conflict");
    expect(await reviewLineCount()).toBe(lines);
    expect((await auditEvents(kit, p)).at(-1)?.details).not.toHaveProperty("reviewQueued");
  });

  it("nothing is written when a pending entry already lists the field", async () => {
    const sf = await kit.repo.createSource(p.id, draft("Rivers and Memory"), [], {
      provenance: provenance(),
      fieldEvidence: [{ field: "/title", value: "Rivers and Memory", source: { kind: "page-dom" }, at: kit.clock.now.toISOString() }],
      reviewItem: { fields: { "/title": "unverified" }, reasons: ["The title was in doubt."], cause: { kind: "capture-conflict" } },
    });
    const lines = await reviewLineCount();
    const next = await laterCheck(sf.source.id, { "/title": "Rivers and Memories" });
    expect(next.verification["/title"]?.status).toBe("conflict");
    expect(await reviewLineCount()).toBe(lines);
    expect(await pendingOf(sf.source.id)).toHaveLength(1);
  });

  it("nothing is raised for a field the researcher has confirmed", async () => {
    const sid = await existing();
    await confirmField(kit.repo, p.id, sid, "/title", mt("Rivers and Memory"));
    const sf = await laterCheck(sid, { "/title": "Rivers and Memories" });
    expect(sf.verification["/title"]?.status).toBe("user-confirmed");
    expect(await entriesOf(sid)).toEqual([]);
  });

  it("an ordinary edit never queues anything (it does not rewrite the stored report)", async () => {
    const sid = await existing();
    await kit.repo.updateSource(p.id, sid, { title: mt("Rivers and Memories") });
    expect(await entriesOf(sid)).toEqual([]);
  });

  it("a source whose only pending entry is a consent withdrawal's gets a capture-conflict entry of its own", async () => {
    const sid = await existing();
    const part = await kit.repo.createParticipant(p.id, {});
    const c = await kit.repo.createConsent(p.id, { participantId: part.id, scope: "audio", date: "2026-03-14" });
    await kit.repo.linkSourceToFieldwork(p.id, sid, { participantIds: [part.id] });
    await kit.repo.withdrawConsent(p.id, c.id, { reason: "phoned" });
    await laterCheck(sid, { "/title": "Rivers and Memories" });
    const byCause = (await pendingOf(sid)).map((e) => [reviewCauseOf(e)?.kind, Object.keys(e.fields)]);
    expect(byCause).toEqual(expect.arrayContaining([["consent-withdrawal", []], ["capture-conflict", ["/title"]]]));
    expect(byCause).toHaveLength(2);
  });
});

describe("crash safety (R26): never a conflict without its entry nor an entry without its conflict", () => {
  it("a crash before the commit point leaves neither; after it, both", async () => {
    const sid = await existing();
    seams.crashAt = "before-audit";
    await expect(laterCheck(sid, { "/title": "Rivers and Memories" })).rejects.toBeInstanceOf(SimulatedCrash);
    await kit.reopen();
    expect((await kit.repo.getSource(p.id, sid)).verification["/title"]?.status).not.toBe("conflict");
    expect(await entriesOf(sid)).toEqual([]);

    seams.crashAt = "before-marker-delete";
    await expect(laterCheck(sid, { "/title": "Rivers and Memories" })).rejects.toBeInstanceOf(SimulatedCrash);
    await kit.reopen();
    expect((await kit.repo.getSource(p.id, sid)).verification["/title"]?.status).toBe("conflict");
    expect(await pendingOf(sid)).toEqual([expect.objectContaining({ fields: { "/title": "conflict" } })]);
  });
});

describe("settled as R176 and R177 say (R190 b)", () => {
  it("confirming the fields settles the entry in the confirm's change", async () => {
    const sid = await existing();
    await laterCheck(sid, { "/title": "Rivers and Memories" });
    await laterCheck(sid, { "/issued": "2020" });
    const [entry] = await pendingOf(sid);
    await confirmField(kit.repo, p.id, sid, "/title", mt("Rivers and Memories"));
    expect(await pendingOf(sid)).toHaveLength(1);
    await confirmField(kit.repo, p.id, sid, "/issued", "2020");
    expect(await pendingOf(sid)).toEqual([]);
    expect((await entriesOf(sid)).find((e) => e.id === entry!.id)).toMatchObject({ status: "resolved", decision: "confirmed" });
  });

  it("a recheck that clears the conflict settles it", async () => {
    const sid = await existing();
    await laterCheck(sid, { "/title": "Rivers and Memories" });
    const [entry] = await pendingOf(sid);
    // The platform's value is withdrawn from the evidence: the recheck finds the title no longer in conflict.
    const sf = await updateSourceRechecked(kit.repo, p.id, sid, {}, {
      fieldEvidence: (cur) => cur.fieldEvidence.filter((e) => e.source.kind !== "platform-json"),
      verification: (next) => recheckSourceFile(next, {}).verification,
    });
    expect(sf.verification["/title"]?.status).not.toBe("conflict");
    expect((await entriesOf(sid)).find((e) => e.id === entry!.id)).toMatchObject({ status: "resolved", decision: "rechecked" });
  });
});

describe("read-only, locked and encrypted projects (R190 c)", () => {
  it("a read-only library writes nothing", async () => {
    const sid = await existing();
    const lines = await reviewLineCount();
    const deps = {
      clock: () => kit.clock.now,
      deviceId: "dev-B",
      hostname: "host-B",
      pid: 99,
      isPidAlive: () => true,
      appConfigDir: join(kit.tmp, "config-B"),
      settleMs: 0,
      setInterval: () => ({}),
      clearInterval: () => {},
    };
    const ro = await openTestRepo(await openLibrary(kit.lib.root, deps), kit.ring, { clock: () => kit.clock.now, tz: "UTC" });
    await expect(
      updateSourceRechecked(ro, p.id, sid, {}, {
        fieldEvidence: (cur) => [...cur.fieldEvidence, { field: "/title", value: "Rivers and Memories", source: { kind: "platform-json" }, at: kit.clock.now.toISOString() }],
        verification: (next) => recheckSourceFile(next, {}).verification,
      }),
    ).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    expect(await reviewLineCount()).toBe(lines);
  });

  it("an encrypted project's entry is sealed as others are; a locked project is refused and nothing is written", async () => {
    const enc = await makeProject(kit, OPEN_GOV, true);
    const at = kit.clock.now.toISOString();
    const base = await kit.repo.createSource(enc.id, draft("Zebrafinch Harbour"), [], {
      provenance: provenance(),
      fieldEvidence: [{ field: "/title", value: "Zebrafinch Harbour", source: { kind: "page-dom" }, at }],
    });
    const sid = base.source.id;
    await laterCheck(sid, { "/title": "Zebrafinch Harbours" }, enc.id);
    const text = await reviewText(enc.id);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("Zebrafinch");
    expect(text).not.toContain("/title");
    const [entry] = await pendingOf(sid, enc.id);
    expect(entry).toMatchObject({ fields: { "/title": "conflict" }, cause: { kind: "capture-conflict", foundBy: "later-check" } });
    // The audit log (plain lines) names the field and the entry, never a title.
    const { readdir } = await import("node:fs/promises");
    const dir = join(kit.lib.root, kit.repo.getProject(enc.id).folder, "audit");
    let bytes = "";
    for (const f of await readdir(dir)) bytes += await readFile(join(dir, f), "latin1");
    expect(bytes).not.toContain("Zebrafinch");

    kit.repo.lockProject(enc.id);
    const lines = await reviewLineCount(enc.id);
    await expect(laterCheck(sid, { "/issued": "2020" }, enc.id)).rejects.toBeInstanceOf(ProjectLockedError);
    expect(await reviewLineCount(enc.id)).toBe(lines);
    await kit.repo.unlockProject(enc.id, PASS);
    expect(await pendingOf(sid, enc.id)).toHaveLength(1);
  });
});
