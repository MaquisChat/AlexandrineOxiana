/**
 * The audit entry of a field confirmation names the field and says it was a confirmation, and
 * whether the researcher kept the recorded value or chose another (R191, defect D20). It never
 * holds the value, the alternatives or anything the researcher typed (audit entries hold no
 * content; an encrypted project's audit is not sealed, R177). Old entries are not rewritten, and
 * the chain verifies with entries with and without the new detail.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEvent, FieldEvidence, FieldVerification, Project, SourceDraft } from "@ao/core";
import { OPEN_GOV, PASS, auditEvents, makeKit, makeProject, type Kit } from "./export/test-kit.js";
import { confirmField } from "./source-actions.js";

let kit: Kit;
afterEach(async () => {
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

// Distinctive values: none of them may appear anywhere in an audit entry.
const KEPT_TITLE = "Quokka Marmalade Ledger";
const OTHER_TITLE = "Xylophone Pelican Almanac";
const DOI_RECORDED = "10.9999/zebra.marmot.1";
const DOI_OTHER = "10.9999/zebra.marmot.2";
const SECRETS = [KEPT_TITLE, OTHER_TITLE, DOI_RECORDED, DOI_OTHER, "Quokka", "Xylophone", "zebra.marmot"];

/** A captured source whose title and DOI conflict, queued for review (as a capture queues it). */
async function captured(p: Project) {
  const at = kit.clock.now.toISOString();
  const page = { kind: "page-dom" as const };
  const platform = { kind: "platform-json" as const };
  const evidence: FieldEvidence[] = [
    { field: "/title", value: KEPT_TITLE, source: page, at },
    { field: "/title", value: OTHER_TITLE, source: platform, at },
    { field: "/identifiers/doi", value: DOI_RECORDED, source: page, at },
    { field: "/identifiers/doi", value: DOI_OTHER, source: platform, at },
  ];
  const conflict = (current: unknown, a: unknown, b: unknown): FieldVerification => ({ status: "conflict", checks: ["sources-agree"], current, values: [{ value: a, source: page }, { value: b, source: platform }] });
  const sf = await kit.repo.createSource(p.id, draft(KEPT_TITLE, { identifiers: { doi: DOI_RECORDED } }), [], {
    provenance: provenance(),
    fieldEvidence: evidence,
    verification: { "/title": conflict(KEPT_TITLE, KEPT_TITLE, OTHER_TITLE), "/identifiers/doi": conflict(DOI_RECORDED, DOI_RECORDED, DOI_OTHER) },
    reviewItem: { fields: { "/title": "conflict", "/identifiers/doi": "conflict" }, reasons: ["The page and the platform disagree."], cause: { kind: "capture-conflict" as const } },
  });
  return sf.source.id;
}

/** The one audit entry `act` added. */
async function addedBy(p: Project, act: () => Promise<unknown>): Promise<AuditEvent> {
  const before = (await auditEvents(kit, p)).length;
  await act();
  const added = (await auditEvents(kit, p)).slice(before);
  expect(added).toHaveLength(1);
  return added[0]!;
}

const noContent = (e: AuditEvent) => {
  const text = JSON.stringify(e);
  for (const s of SECRETS) expect(text).not.toContain(s);
};

for (const encrypted of [false, true]) {
  describe(`a confirmation's audit entry (R191)${encrypted ? " in an encrypted project" : ""}`, () => {
    it("confirming the value already recorded names the field and says it was kept; no value in the entry", async () => {
      kit = await makeKit("ao-confirm-audit-");
      const p = await makeProject(kit, OPEN_GOV, encrypted);
      const sid = await captured(p);
      const e = await addedBy(p, () => confirmField(kit.repo, p.id, sid, "/title", mt(KEPT_TITLE)));
      expect(e).toMatchObject({ action: "store", decision: { result: "allow" }, entity: { type: "source", id: sid } });
      expect(e.details).toMatchObject({ op: "source.update", confirmed: [{ field: "/title", choice: "kept" }] });
      expect(e.details!.txn).toBeTruthy();
      expect(e.details).not.toHaveProperty("reviewResolved");
      expect(e.details!.confirmed).toEqual([{ field: "/title", choice: "kept" }]);
      noContent(e);
    });

    it("choosing another value says changed; no value or alternative in the entry", async () => {
      kit = await makeKit("ao-confirm-audit-");
      const p = await makeProject(kit, OPEN_GOV, encrypted);
      const sid = await captured(p);
      const e = await addedBy(p, () => confirmField(kit.repo, p.id, sid, "/title", mt(OTHER_TITLE)));
      expect(e.details!.confirmed).toEqual([{ field: "/title", choice: "changed" }]);
      expect((await kit.repo.getSource(p.id, sid)).source.title.variants[0]!.value).toBe(OTHER_TITLE);
      noContent(e);
    });

    it("an identifier is recorded the same way, under the verification report's key (R149)", async () => {
      kit = await makeKit("ao-confirm-audit-");
      const p = await makeProject(kit, OPEN_GOV, encrypted);
      const sid = await captured(p);
      const kept = await addedBy(p, () => confirmField(kit.repo, p.id, sid, "/identifiers/doi", DOI_RECORDED));
      expect(kept.details!.confirmed).toEqual([{ field: "/identifiers/doi", choice: "kept" }]);
      noContent(kept);
      const changed = await addedBy(p, () => confirmField(kit.repo, p.id, sid, "identifiers/doi", ` ${DOI_OTHER} `));
      expect(changed.details!.confirmed).toEqual([{ field: "/identifiers/doi", choice: "changed" }]);
      noContent(changed);
    });

    it("an identifier not recorded before, and an ISBN typed alone into a list, are changed", async () => {
      kit = await makeKit("ao-confirm-audit-");
      const p = await makeProject(kit, OPEN_GOV, encrypted);
      const sid = await captured(p);
      const url = await addedBy(p, () => confirmField(kit.repo, p.id, sid, "/identifiers/url", "https://example.org/zebra.marmot"));
      expect(url.details!.confirmed).toEqual([{ field: "/identifiers/url", choice: "changed" }]);
      noContent(url);
      const isbn = await addedBy(p, () => confirmField(kit.repo, p.id, sid, "/identifiers/isbn", "9780306406157"));
      expect(isbn.details!.confirmed).toEqual([{ field: "/identifiers/isbn", choice: "changed" }]);
      expect(JSON.stringify(isbn)).not.toContain("9780306406157");
      // The same ISBN again: the list as recorded is kept.
      const again = await addedBy(p, () => confirmField(kit.repo, p.id, sid, "/identifiers/isbn", ["9780306406157"]));
      expect(again.details!.confirmed).toEqual([{ field: "/identifiers/isbn", choice: "kept" }]);
    });

    it("the confirmation that settles the review entry carries both the new detail and reviewResolved", async () => {
      kit = await makeKit("ao-confirm-audit-");
      const p = await makeProject(kit, OPEN_GOV, encrypted);
      const sid = await captured(p);
      const first = await addedBy(p, () => confirmField(kit.repo, p.id, sid, "/identifiers/doi", DOI_OTHER));
      expect(first.details).not.toHaveProperty("reviewResolved");
      const last = await addedBy(p, () => confirmField(kit.repo, p.id, sid, "/title", mt(KEPT_TITLE)));
      expect(last.details).toMatchObject({
        op: "source.update",
        confirmed: [{ field: "/title", choice: "kept" }],
        reviewResolved: { by: "confirmation", entries: [expect.any(String)] },
      });
      noContent(first);
      noContent(last);
    });

    it("an ordinary edit carries no confirmation; the chain verifies with old entries beside new ones, and again after reopening", async () => {
      kit = await makeKit("ao-confirm-audit-");
      const p = await makeProject(kit, OPEN_GOV, encrypted);
      const sid = await captured(p);
      const edit = await addedBy(p, () => kit.repo.updateSource(p.id, sid, { publisher: "Polity" }));
      expect(edit.details).toMatchObject({ op: "source.update" });
      expect(edit.details).not.toHaveProperty("confirmed");
      expect(await kit.repo.verifyAudit(p.id)).toMatchObject({ ok: true });
      await confirmField(kit.repo, p.id, sid, "/title", mt(OTHER_TITLE));
      await kit.repo.updateSource(p.id, sid, { publisher: "Verso" });
      expect(await kit.repo.verifyAudit(p.id)).toMatchObject({ ok: true });
      await kit.reopen();
      if (encrypted && !kit.repo.isUnlocked(p.id)) await kit.repo.unlockProject(p.id, PASS);
      const check = await kit.repo.verifyAudit(p.id);
      expect(check).toMatchObject({ ok: true, anchored: true });
      expect(check.problem).toBeUndefined();
      const ops = (await auditEvents(kit, p)).filter((e) => e.details?.op === "source.update").map((e) => e.details!.confirmed ?? null);
      expect(ops).toEqual([null, [{ field: "/title", choice: "changed" }], null]);
    });
  });
}
