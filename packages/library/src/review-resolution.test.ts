/**
 * How verification entries of the review queue are resolved (Task 67, R176):
 *  1. a capture's conflict entry by the library, in the same governed change as the confirm (R149)
 *     or the recheck that leaves none of its fields in conflict or unconfirmed;
 *  2. a consent withdrawal's entry only by the researcher's decision "Reviewed after the
 *     withdrawal", its own policy operation with a required reason;
 *  3. the cause recorded on new entries; old entries without one read by `reviewCauseOf`;
 *  4. a removed source's pending entries resolved in the removal's own change.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FieldEvidence, FieldVerification, Project, SourceDraft } from "@ao/core";
import { OPEN_GOV, auditEvents, makeKit, makeProject, PASS, type Kit } from "./export/test-kit.js";
import { PolicyDeniedError, ProjectLockedError } from "./repo/errors.js";
import { projectReviewEntries } from "./repo/repo.js";
import { REVIEW_FILE, reviewCauseOf, type ReviewEntry } from "./repo/review.js";
import { SimulatedCrash, seams } from "./repo/testing.js";
import { confirmField } from "./source-actions.js";

let kit: Kit;
let p: Project;
beforeEach(async () => {
  kit = await makeKit("ao-review-resolution-");
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

/** A captured source whose title and date conflict, queued as link and profile capture queue one. */
async function capturedWithConflicts(fields: Record<string, string> = { "/title": "conflict", "/issued": "conflict" }, extra: { cause?: boolean } = {}) {
  const at = kit.clock.now.toISOString();
  const page = { kind: "page-dom" as const };
  const platform = { kind: "platform-json" as const };
  const evidence: FieldEvidence[] = [
    { field: "/title", value: "Rivers and Memory", source: page, at },
    { field: "/title", value: "Rivers and Memories", source: platform, at },
    { field: "/issued", value: "2019", source: page, at },
    { field: "/issued", value: "2020", source: platform, at },
  ];
  const conflict = (current: unknown, a: unknown, b: unknown): FieldVerification => ({ status: "conflict", checks: ["sources-agree"], current, values: [{ value: a, source: page }, { value: b, source: platform }] });
  const sf = await kit.repo.createSource(p.id, draft("Rivers and Memory", { issued: "2019" }), [], {
    provenance: provenance(),
    fieldEvidence: evidence,
    verification: { "/title": conflict("Rivers and Memory", "Rivers and Memory", "Rivers and Memories"), "/issued": conflict("2019", "2019", "2020") },
    reviewItem: { fields, reasons: ["The page and the platform disagree."], ...(extra.cause === false ? {} : { cause: { kind: "capture-conflict" as const } }) },
  });
  return sf.source.id;
}

const entriesOf = async (sid: string) => (await projectReviewEntries(kit.repo, p.id)).filter((e) => e.sourceId === sid);
const reviewLines = async () => (await readFile(join(kit.lib.root, kit.repo.getProject(p.id).folder, ...REVIEW_FILE.split("/")), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as ReviewEntry);

describe("a capture's conflict entry is resolved by the library (R176 1)", () => {
  it("confirming one of two listed fields leaves it pending; confirming the last resolves it in the same governed change, audited once with what resolved it", async () => {
    const sid = await capturedWithConflicts();
    const [entry] = await entriesOf(sid);
    expect(entry).toMatchObject({ kind: "verification", status: "pending", cause: { kind: "capture-conflict" } });
    await confirmField(kit.repo, p.id, sid, "/title", mt("Rivers and Memory"));
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "pending" });
    const before = await auditEvents(kit, p);
    await confirmField(kit.repo, p.id, sid, "/issued", "2019");
    const after = await auditEvents(kit, p);
    const added = after.slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ details: { op: "source.update", reviewResolved: { entries: [entry!.id], by: "confirmation" } } });
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "resolved", decision: "confirmed" });
    // The change itself carries the resolution (one txn for the source write and the entry's line).
    const lines = (await reviewLines()).filter((l) => l.id === entry!.id);
    expect(lines.map((l) => l.status)).toEqual(["pending", "resolved"]);
  });

  it("two confirms at once on the two fields both land, and the entry is resolved exactly once", async () => {
    const sid = await capturedWithConflicts();
    const [entry] = await entriesOf(sid);
    await Promise.all([confirmField(kit.repo, p.id, sid, "/title", mt("Rivers and Memories")), confirmField(kit.repo, p.id, sid, "/issued", "2020")]);
    const sf = await kit.repo.getSource(p.id, sid);
    expect(sf.source.issued).toBe("2020");
    expect(sf.source.title.variants[0]!.value).toBe("Rivers and Memories");
    expect(sf.verification["/title"]?.status).toBe("user-confirmed");
    expect(sf.verification["/issued"]?.status).toBe("user-confirmed");
    expect((await reviewLines()).filter((l) => l.id === entry!.id && l.status === "resolved")).toHaveLength(1);
    const resolvedEvents = (await auditEvents(kit, p)).filter((e) => (e.details as { reviewResolved?: unknown } | undefined)?.reviewResolved);
    expect(resolvedEvents).toHaveLength(1);
  });

  it("a crash before the commit point leaves neither the confirm nor the resolution; after it, both", async () => {
    const sid = await capturedWithConflicts({ "/issued": "conflict" });
    seams.crashAt = "before-audit";
    await expect(confirmField(kit.repo, p.id, sid, "/issued", "2020")).rejects.toBeInstanceOf(SimulatedCrash);
    await kit.reopen();
    expect((await kit.repo.getSource(p.id, sid)).source.issued).toBe("2019");
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "pending" });

    seams.crashAt = "before-marker-delete";
    await expect(confirmField(kit.repo, p.id, sid, "/issued", "2020")).rejects.toBeInstanceOf(SimulatedCrash);
    await kit.reopen();
    expect((await kit.repo.getSource(p.id, sid)).source.issued).toBe("2020");
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "resolved", decision: "confirmed" });
  });

  it("a recheck that finds the listed fields no longer in conflict resolves the entry in its own governed change", async () => {
    const at = kit.clock.now.toISOString();
    const sf = await kit.repo.createSource(p.id, draft("Rivers and Memory"), [], {
      provenance: provenance(),
      // One trusted source and nothing against it: a recheck finds no conflict.
      fieldEvidence: [{ field: "/title", value: "Rivers and Memory", source: { kind: "page-dom" }, at }],
      verification: { "/title": { status: "conflict", checks: ["sources-agree"], current: "Rivers and Memory", values: [] } },
      reviewItem: { fields: { "/title": "conflict" }, reasons: ["The title was in doubt."], cause: { kind: "capture-conflict" } },
    });
    const sid = sf.source.id;
    const [entry] = await entriesOf(sid);
    const rechecked = await kit.repo.recheckSource(p.id, sid);
    expect(["verified", "single-source", "user-confirmed"]).toContain(rechecked.verification["/title"]?.status);
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "resolved", decision: "rechecked" });
    expect((await auditEvents(kit, p)).at(-1)).toMatchObject({ details: { op: "source.update", reviewResolved: { entries: [entry!.id], by: "recheck" } } });
  });

  it("a recheck whose verification did not change still resolves an entry whose fields are no longer in conflict", async () => {
    const at = kit.clock.now.toISOString();
    const sf = await kit.repo.createSource(p.id, draft("Rivers and Memory"), [], {
      provenance: provenance(),
      fieldEvidence: [{ field: "/title", value: "Rivers and Memory", source: { kind: "page-dom" }, at }],
      reviewItem: { fields: { "/title": "conflict" }, reasons: ["The title was in doubt."], cause: { kind: "capture-conflict" } },
    });
    const sid = sf.source.id;
    await kit.repo.recheckSource(p.id, sid);
    await kit.repo.recheckSource(p.id, sid);
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "resolved", decision: "rechecked" });
  });

  it("an old capture entry without a recorded cause is resolved the same way", async () => {
    const sid = await capturedWithConflicts({ "/issued": "conflict" }, { cause: false });
    const [entry] = await entriesOf(sid);
    expect(entry!.cause).toBeUndefined();
    await confirmField(kit.repo, p.id, sid, "/issued", "2019");
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "resolved", decision: "confirmed" });
  });

  it("a confirm resolves no import entry and no consent-withdrawal entry", async () => {
    const sid = await capturedWithConflicts({ "/issued": "conflict" });
    const repo = kit.repo;
    await repo.createSource(p.id, draft("Other"), [], { provenance: provenance() });
    const { withdrawnFor } = await withdrawal(sid);
    await confirmField(repo, p.id, sid, "/issued", "2019");
    const byCause = Object.fromEntries((await entriesOf(sid)).map((e) => [reviewCauseOf(e)?.kind, e.status]));
    expect(byCause).toEqual({ "capture-conflict": "resolved", "consent-withdrawal": "pending" });
    expect(withdrawnFor).toBe(sid);
  });
});

/** Links `sid` to a participant and withdraws their consent: the source is flagged for review. */
async function withdrawal(sid: string) {
  const repo = kit.repo;
  const part = await repo.createParticipant(p.id, {});
  const c = await repo.createConsent(p.id, { participantId: part.id, scope: "audio", date: "2026-03-14" });
  await repo.linkSourceToFieldwork(p.id, sid, { participantIds: [part.id] });
  const w = await repo.withdrawConsent(p.id, c.id, { reason: "phoned" });
  expect(w.flaggedSourceIds).toEqual([sid]);
  const entry = (await entriesOf(sid)).find((e) => reviewCauseOf(e)?.kind === "consent-withdrawal")!;
  return { entry, consentId: c.id, withdrawnFor: sid };
}

describe("a consent withdrawal's entry: \"Reviewed after the withdrawal\" (R176 2)", () => {
  const plain = async () => (await kit.repo.createSource(p.id, draft("Interview with the harbour master", { type: "interview" }), [], { provenance: provenance() })).source.id;

  it("records the withdrawal it came from", async () => {
    const sid = await plain();
    const { entry, consentId } = await withdrawal(sid);
    expect(entry).toMatchObject({ kind: "verification", status: "pending", cause: { kind: "consent-withdrawal", consentIds: [consentId] } });
  });

  it("without a reason it is refused in plain words by the policy engine, the refusal audited, and the entry stays", async () => {
    const sid = await plain();
    const { entry } = await withdrawal(sid);
    for (const reason of ["", "   "]) {
      await expect(kit.repo.reviewedAfterWithdrawal(p.id, entry.id, reason)).rejects.toThrow(PolicyDeniedError);
    }
    const last = (await auditEvents(kit, p)).at(-1)!;
    expect(last).toMatchObject({ action: "review-withdrawal", decision: { result: "deny", reason: "A reason is required to record that this source was reviewed after the withdrawal" }, details: { op: "review.withdrawal-reviewed" } });
    expect((await entriesOf(sid)).find((e) => e.id === entry.id)).toMatchObject({ status: "pending" });
  });

  it("with a reason it is resolved and audited, the reason stored as typed; nothing else about the source changes", async () => {
    const sid = await plain();
    const { entry } = await withdrawal(sid);
    const before = await kit.repo.getSource(p.id, sid);
    const reason = "  Spoke with P-001 on 14 March: the audio may be kept, but not quoted.\n";
    const r = await kit.repo.reviewedAfterWithdrawal(p.id, entry.id, reason);
    expect(r).toMatchObject({ id: entry.id, status: "resolved", decision: "reviewed-after-withdrawal", reason });
    expect((await entriesOf(sid)).find((e) => e.id === entry.id)).toMatchObject({ status: "resolved", reason });
    expect((await auditEvents(kit, p)).at(-1)).toMatchObject({
      action: "review-withdrawal",
      decision: { result: "allow" },
      entity: { type: "source", id: sid },
      details: { op: "review.withdrawal-reviewed", reviewEntry: entry.id, reason },
    });
    expect(await kit.repo.getSource(p.id, sid)).toEqual(before);
  });

  it("twice at once: one is recorded, the other refused as already reviewed; resolved exactly once", async () => {
    const sid = await plain();
    const { entry } = await withdrawal(sid);
    const results = await Promise.allSettled([kit.repo.reviewedAfterWithdrawal(p.id, entry.id, "first"), kit.repo.reviewedAfterWithdrawal(p.id, entry.id, "second")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason.message)).toMatch(/already been reviewed/);
    expect((await reviewLines()).filter((l) => l.id === entry.id && l.status === "resolved")).toHaveLength(1);
  });

  it("is refused for an entry of another kind", async () => {
    const sid = await capturedWithConflicts({ "/issued": "conflict" });
    const [entry] = await entriesOf(sid);
    await expect(kit.repo.reviewedAfterWithdrawal(p.id, entry!.id, "a reason")).rejects.toThrow(/not an entry flagged by a consent withdrawal/);
    await expect(kit.repo.reviewedAfterWithdrawal(p.id, "0190f0f0-0000-7000-8000-000000000000", "a reason")).rejects.toThrow(/not found/i);
  });

  it("an old withdrawal entry without a recorded cause (no fields) can be decided the same way", async () => {
    const sid = (await kit.repo.createSource(p.id, draft("Old flagged source"), [], { provenance: provenance(), reviewItem: { kind: "verification", fields: {}, reasons: ["Consent was withdrawn."] } })).source.id;
    const [entry] = await entriesOf(sid);
    expect(reviewCauseOf(entry!)).toEqual({ kind: "consent-withdrawal", consentIds: [] });
    await kit.repo.reviewedAfterWithdrawal(p.id, entry!.id, "Checked");
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "resolved", decision: "reviewed-after-withdrawal" });
  });

  it("a locked project is refused before anything is read", async () => {
    const enc = await makeProject(kit, OPEN_GOV.replace("atRest: optional", "atRest: optional"), true);
    const sid = (await kit.repo.createSource(enc.id, draft("Sealed"), [], { provenance: provenance(), reviewItem: { kind: "verification", fields: {}, reasons: ["Consent was withdrawn."] } })).source.id;
    const [entry] = (await projectReviewEntries(kit.repo, enc.id)).filter((e) => e.sourceId === sid);
    kit.repo.lockProject(enc.id);
    await expect(kit.repo.reviewedAfterWithdrawal(enc.id, entry!.id, "a reason")).rejects.toBeInstanceOf(ProjectLockedError);
    await kit.repo.unlockProject(enc.id, PASS);
    expect((await projectReviewEntries(kit.repo, enc.id)).find((e) => e.id === entry!.id)).toMatchObject({ status: "pending" });
  });
});

describe("the recorded cause and old entries (R176 3)", () => {
  it("reviewCauseOf: a recorded cause wins; an old verification entry with fields is a capture's, without fields a withdrawal's; import entries have none", () => {
    const base = { id: "e", projectId: "p", status: "pending" as const, createdAt: "2026-01-01T00:00:00.000Z", reasons: [] };
    expect(reviewCauseOf({ ...base, kind: "verification", fields: {}, cause: { kind: "capture-conflict" } })).toEqual({ kind: "capture-conflict" });
    expect(reviewCauseOf({ ...base, kind: "verification", fields: { "/title": "conflict" } })).toEqual({ kind: "capture-conflict" });
    expect(reviewCauseOf({ ...base, kind: "verification", fields: {} })).toEqual({ kind: "consent-withdrawal", consentIds: [] });
    expect(reviewCauseOf({ ...base, kind: "import", fields: { "/title": "conflict" } })).toBeUndefined();
  });

  it("a link to a participant whose consent was already withdrawn records that withdrawal", async () => {
    const repo = kit.repo;
    const part = await repo.createParticipant(p.id, {});
    const c = await repo.createConsent(p.id, { participantId: part.id, scope: "audio", date: "2026-03-14" });
    await repo.withdrawConsent(p.id, c.id, {});
    const sid = (await repo.createSource(p.id, draft("Linked later"), [], { provenance: provenance() })).source.id;
    await repo.linkSourceToFieldwork(p.id, sid, { participantIds: [part.id] });
    expect((await entriesOf(sid))[0]).toMatchObject({ cause: { kind: "consent-withdrawal", consentIds: [c.id] } });
  });
});

describe("a removed source (R176 4)", () => {
  it("deleting a source resolves its pending entries in the same change", async () => {
    const sid = await capturedWithConflicts({ "/issued": "conflict" });
    await withdrawal(sid);
    expect((await entriesOf(sid)).map((e) => e.status)).toEqual(["pending", "pending"]);
    const before = (await auditEvents(kit, p)).length;
    await kit.repo.deleteSource(p.id, sid);
    expect((await entriesOf(sid)).map((e) => [e.status, e.decision])).toEqual([
      ["resolved", "source-removed"],
      ["resolved", "source-removed"],
    ]);
    const added = (await auditEvents(kit, p)).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ details: { op: "source.delete" } });
  });
});
