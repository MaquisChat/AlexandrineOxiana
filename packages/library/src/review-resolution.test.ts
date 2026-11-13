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
    // The evidence and the stored report have in conflict exactly the fields the entry lists (R193 b: a
    // conflict no entry lists is queued by the next change that writes the report).
    fieldEvidence: evidence.filter((e) => e.field in fields || e.source.kind === "page-dom"),
    verification: Object.fromEntries(
      Object.entries({ "/title": conflict("Rivers and Memory", "Rivers and Memory", "Rivers and Memories"), "/issued": conflict("2019", "2019", "2020") }).filter(([f]) => f in fields),
    ),
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

describe("fix round 1, I1: a listed field that has left the report is settled (coordinator's ruling 1)", () => {
  /** The reviewer's probe: a video capture whose post id is unverified, later corrected to a web page. */
  async function videoWithUnverifiedPostId() {
    const at = kit.clock.now.toISOString();
    const sf = await kit.repo.createSource(p.id, draft("A clip", { type: "video", identifiers: { url: "https://example.org/watch/abc" } }), [], {
      provenance: provenance(),
      fieldEvidence: [{ field: "/title", value: "A clip", source: { kind: "page-dom" }, at }],
      verification: { "/identifiers/platformPostId": { status: "unverified", checks: [], reason: "No post ID was recorded." } },
      reviewItem: { fields: { "/identifiers/platformPostId": "unverified" }, reasons: ["The post ID could not be checked."], cause: { kind: "capture-conflict" } },
    });
    return sf.source.id;
  }

  it("the probe end to end: the type is corrected to a web page; the post id is no longer a field of the source, so the entry is resolved in the edit's own change, and the stored report is untouched (fix round 2)", async () => {
    const sid = await videoWithUnverifiedPostId();
    const [entry] = await entriesOf(sid);
    const before = await kit.repo.getSource(p.id, sid);
    const after = await kit.repo.updateSource(p.id, sid, { type: "webpage" });
    expect(JSON.stringify(after.verification)).toBe(JSON.stringify(before.verification));
    expect(after.fieldEvidence).toEqual(before.fieldEvidence);
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "resolved", decision: "edited" });
    expect((await auditEvents(kit, p)).at(-1)).toMatchObject({ details: { op: "source.update", reviewResolved: { entries: [entry!.id], by: "edit" } } });
  });

  it("a recheck that drops a listed field from the report resolves the entry", async () => {
    const at = kit.clock.now.toISOString();
    // A report that lists a field no evidence or rule gives any more: the recheck drops it.
    const sf = await kit.repo.createSource(p.id, draft("A page"), [], {
      provenance: provenance(),
      fieldEvidence: [{ field: "/title", value: "A page", source: { kind: "page-dom" }, at }],
      verification: { "/identifiers/platformPostId": { status: "unverified", checks: [] } },
      reviewItem: { fields: { "/identifiers/platformPostId": "unverified" }, reasons: ["?"], cause: { kind: "capture-conflict" } },
    });
    const r = await kit.repo.recheckSource(p.id, sf.source.id);
    expect(r.verification["/identifiers/platformPostId"]).toBeUndefined();
    expect((await entriesOf(sf.source.id))[0]).toMatchObject({ status: "resolved", decision: "rechecked" });
  });

  it("an edit that empties a listed conflicting field resolves the entry, without touching the stored report (fix round 2)", async () => {
    const at = kit.clock.now.toISOString();
    const sf = await kit.repo.createSource(p.id, draft("A page", { publisher: "Unknown press" }), [], {
      provenance: provenance(),
      fieldEvidence: [{ field: "/title", value: "A page", source: { kind: "page-dom" }, at }, { field: "/publisher", value: "Other press", source: { kind: "page-dom" }, at }],
      verification: { "/publisher": { status: "conflict", checks: ["sources-agree"], reason: "Two publishers." } },
      reviewItem: { fields: { "/publisher": "conflict" }, reasons: ["?"], cause: { kind: "capture-conflict" } },
    });
    const sid = sf.source.id;
    await kit.repo.setMembership(p.id, sid, { tagIds: [] });
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "pending" });
    const before = await kit.repo.getSource(p.id, sid);
    const after = await kit.repo.updateSource(p.id, sid, { publisher: undefined });
    expect(after.verification).toEqual(before.verification);
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "resolved", decision: "edited" });
  });

  it("an edit to an unrelated field leaves a pending entry pending, and a still-unsettled field keeps it open (fix round 2)", async () => {
    const sid = await capturedWithConflicts({ "/issued": "conflict" });
    await kit.repo.updateSource(p.id, sid, { volume: "3" });
    await kit.repo.updateSource(p.id, sid, { volume: undefined });
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "pending" });
  });

  it("the re-review's probe: removing a field, or a source's last tag, never rewrites the stored report, a status or the evidence; the audit event describes only the edit (I3)", async () => {
    const at = kit.clock.now.toISOString();
    const verified = (current: unknown): FieldVerification => ({ status: "verified", checks: ["lookup-agrees"], current });
    const sf = await kit.repo.createSource(p.id, draft("Rivers and Memory", { type: "article-journal", issued: "2019", volume: "3" }), [], {
      provenance: provenance(),
      fieldEvidence: [{ field: "/title", value: "Rivers and Memory", source: { kind: "lookup", provider: "crossref" }, at }],
      verification: { "/title": verified("Rivers and Memory"), "/issued": verified("2019"), "/container": { status: "unverified", checks: [], reason: "Missing." } },
      reviewItem: { fields: { "/container": "unverified" }, reasons: ["The journal is unknown."], cause: { kind: "capture-conflict" } },
    });
    const sid = sf.source.id;
    const tag = await kit.repo.createTag(p.id, "to read");
    await kit.repo.updateSource(p.id, sid, { tagIds: [tag.id] });
    const stored = async () => {
      const s = await kit.repo.getSource(p.id, sid);
      return { verification: JSON.stringify(s.verification), evidence: JSON.stringify(s.fieldEvidence) };
    };
    const before = await stored();
    for (const patch of [{ volume: undefined }, { tagIds: [] as string[] }]) {
      const n = (await auditEvents(kit, p)).length;
      await kit.repo.updateSource(p.id, sid, patch);
      expect(await stored()).toEqual(before);
      const added = (await auditEvents(kit, p)).slice(n);
      expect(added).toHaveLength(1);
      expect(added[0]!.details).not.toHaveProperty("reviewResolved");
    }
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "pending" });
  });

  it("an import decision that rewrites a captured source's report re-examines its capture entries in the decision's change", async () => {
    const sid = await videoWithUnverifiedPostId();
    const imp = await kit.repo.createSource(p.id, draft("Imported duplicate"), [], { provenance: provenance(), reviewItem: { kind: "import", fields: {}, reasons: ["Likely duplicate"] } });
    const importEntry = (await entriesOf(imp.source.id))[0]!;
    // Merging the import item into the clip: the clip's report is rewritten (merged evidence, recheck).
    const { decideReview } = await import("./import/bulk/review.js");
    await kit.repo.updateSource(p.id, sid, {}); // nothing changes: still pending
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "pending" });
    await decideReview(kit.repo, p.id, importEntry.id, { action: "merge", sourceId: sid });
    const clip = await kit.repo.getSource(p.id, sid);
    const settled = !["conflict", "unverified"].includes(clip.verification["/identifiers/platformPostId"]?.status ?? "");
    expect((await entriesOf(sid))[0]!.status).toBe(settled ? "resolved" : "pending");
  });

  it("a machine change that recomputes the report (a profile refresh, a browser capture's evidence) re-examines the entries too (M5)", async () => {
    const { updateSourceRechecked } = await import("./repo/repo.js");
    const { recheckSourceFile } = await import("@ao/core");
    const sid = await videoWithUnverifiedPostId();
    await kit.repo.updateSource(p.id, sid, {}); // the report is not touched: still pending
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "pending" });
    await updateSourceRechecked(kit.repo, p.id, sid, { type: "webpage" }, { verification: (n) => recheckSourceFile(n, {}).verification });
    expect((await entriesOf(sid))[0]).toMatchObject({ status: "resolved", decision: "rechecked" });
  });

  it("a social post with no creators: a typed creator confirmed through the confirm resolves the entry", async () => {
    const sf = await kit.repo.createSource(p.id, draft("A post", { type: "social-post" }), [], {
      provenance: provenance(),
      verification: { "/creators": { status: "unverified", checks: [], reason: "No creator was found." } },
      reviewItem: { fields: { "/creators": "unverified" }, reasons: ["No creator."], cause: { kind: "capture-conflict" } },
    });
    const next = await confirmField(kit.repo, p.id, sf.source.id, "/creators", [{ literal: "Harbour Collective", role: "author" }]);
    expect(next.verification["/creators"]?.status).toBe("user-confirmed");
    expect((await entriesOf(sf.source.id))[0]).toMatchObject({ status: "resolved", decision: "confirmed" });
  });
});

describe("fix round 1, I2: the withdrawal reason in an encrypted project's audit log (coordinator's ruling 2)", () => {
  it("an encrypted project's audit holds that a reason was given and its SHA-256, never its text; the sealed entry keeps the text", async () => {
    const { createHash } = await import("node:crypto");
    const enc = await makeProject(kit, OPEN_GOV, true);
    const sid = (await kit.repo.createSource(enc.id, draft("Sealed"), [], { provenance: provenance(), reviewItem: { kind: "verification", fields: {}, reasons: ["Consent was withdrawn."], cause: { kind: "consent-withdrawal", consentIds: [] } } })).source.id;
    const [entry] = (await projectReviewEntries(kit.repo, enc.id)).filter((e) => e.sourceId === sid);
    const reason = "Zebrafinch-7731: spoke with the participant's sister";
    await kit.repo.reviewedAfterWithdrawal(enc.id, entry!.id, reason);
    const { readdir } = await import("node:fs/promises");
    const dir = join(kit.lib.root, kit.repo.getProject(enc.id).folder, "audit");
    let bytes = "";
    for (const f of await readdir(dir)) bytes += await readFile(join(dir, f), "latin1");
    expect(bytes).not.toContain("Zebrafinch");
    expect(bytes).not.toContain("sister");
    const digest = createHash("sha256").update(reason, "utf8").digest("hex");
    expect(bytes).toContain(digest);
    expect(bytes).toContain('"reasonGiven":true');
    kit.repo.lockProject(enc.id);
    await kit.repo.unlockProject(enc.id, PASS);
    const sealed = (await projectReviewEntries(kit.repo, enc.id)).find((e) => e.id === entry!.id)!;
    expect(sealed.reason).toBe(reason);
    expect(createHash("sha256").update(sealed.reason!, "utf8").digest("hex")).toBe(digest);
  });

  it("a project that is not encrypted audits the reason as typed", async () => {
    const sid = (await kit.repo.createSource(p.id, draft("Open"), [], { provenance: provenance(), reviewItem: { kind: "verification", fields: {}, reasons: ["Consent was withdrawn."] } })).source.id;
    const [entry] = await entriesOf(sid);
    await kit.repo.reviewedAfterWithdrawal(p.id, entry!.id, " As typed ");
    expect((await auditEvents(kit, p)).at(-1)).toMatchObject({ details: { reason: " As typed " } });
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
