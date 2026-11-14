/**
 * Task F11 (R277 b–c, A2): a file that did not clearly match its record is held in the project for the researcher.
 * The held file, its review entry and the queue entry's line are one governed change; "Use this file" and "Not this
 * file" are one change each; removing the entry, or the source, takes the held file and closes its review entry in
 * the same change. Nothing is ever left orphaned; an encrypted project's held file is encrypted at rest, and its
 * backup restores.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { newId, type Project } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { backupProject, restoreBackup } from "../export/backup.js";
import { OPEN_GOV, PASS, PSEUDO_GOV, addSource, auditEvents, makeKit, makeProject, plainOf, scratchFile, type Kit } from "../export/test-kit.js";
import { appendFindEntries, readFindQueue } from "../find/queue-store.js";
import type { FindEntry } from "../find/types.js";
import { ProjectLockedError, ReviewEntryDecidedError } from "./errors.js";
import {
  FIND_HELD_MAX,
  HELD_FILE_REASON,
  HeldFileEntryGoneError,
  HeldFileLimitError,
  holdMismatchedFile,
  readReviewEntries,
  removeFindEntryWithHeld,
  resolveHeldFile,
  type HeldFileFacts,
} from "./review.js";
import { SimulatedCrash, seams, type CrashPoint } from "./testing.js";
import type { RepoCore } from "./state.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-review-held-");
});
afterEach(async () => {
  seams.crashAt = undefined;
  await kit.close();
});
const coreOf = () => (kit.repo as unknown as { core: RepoCore }).core;

const NOW = "2026-11-10T09:30:00.000Z";
const TITLE = "Rivers and Memory in Upland Villages";
const ADDRESS = "https://arxiv.org/pdf/2101.00001";
const facts = (extra: Partial<HeldFileFacts> = {}): HeldFileFacts => ({
  why: "other-doi",
  kind: "pdf",
  bytes: 1234,
  fileDoi: "10.5555/ao.f11.other",
  embeddedTitle: "A Different Paper Entirely",
  textStart: "A Different Paper Entirely. Abstract.",
  acquired: { method: "free_copy", via: "service", service: "arxiv", address: ADDRESS, at: NOW, tool: { name: "find-and-acquire", version: "0.1.0" }, access: "public" },
  ...extra,
});

interface World {
  p: Project;
  sourceId: string;
  entry: FindEntry;
  pdf: string;
}

async function world(encrypted = false): Promise<World> {
  const p = await makeProject(kit, encrypted ? PSEUDO_GOV : OPEN_GOV, encrypted);
  const sf = await addSource(kit, p, { title: TITLE, creators: [{ role: "author", family: "Okafor", given: "Amara" }] });
  const entry: FindEntry = { id: newId(), projectId: p.id, typed: "Okafor, Rivers and Memory", state: "fetching", createdAt: NOW, updatedAt: NOW, attempts: 0, sourceId: sf.source.id };
  await appendFindEntries(coreOf(), p.id, [entry], "add");
  const pdf = await scratchFile(kit, "1.pdf", await buildPdf({ title: "A Different Paper Entirely", lines: ["A Different Paper Entirely"] }));
  return { p, sourceId: sf.source.id, entry, pdf };
}

const needsCheck = (w: World): FindEntry => ({ ...w.entry, state: "needs-check", reason: { code: "file-other-doi" }, updatedAt: "2026-11-10T09:31:00.000Z" });
const hold = (w: World) => holdMismatchedFile(coreOf(), w.p.id, { entry: needsCheck(w), sourceId: w.sourceId, fromPath: w.pdf, facts: facts() });
const heldDir = (w: World) => join(kit.lib.root, kit.repo.getProject(w.p.id).folder, "find", "held");
const heldFiles = async (w: World) => {
  try {
    return await readdir(heldDir(w));
  } catch {
    return [];
  }
};
const pending = async (w: World) => (await readReviewEntries(coreOf(), coreOf().state(w.p.id))).filter((e) => e.status === "pending");
const stateOf = async (w: World) => (await readFindQueue(coreOf(), w.p.id)).get(w.entry.id)?.state;

describe("holding a file", () => {
  it("writes the held file, its review entry and the entry's line together", async () => {
    const w = await world();
    const r = await hold(w);
    expect(r.held).toBe(`find/held/${w.entry.id}.pdf`);
    expect(await heldFiles(w)).toEqual([`${w.entry.id}.pdf`]);
    expect((await stat(join(heldDir(w), `${w.entry.id}.pdf`))).mode & 0o777).toBe(0o600);
    const [e] = await pending(w);
    expect(e).toMatchObject({ id: r.reviewId, sourceId: w.sourceId, kind: "verification", reasons: [HELD_FILE_REASON], cause: { kind: "acquired-file-mismatch", findEntryId: w.entry.id, held: r.held } });
    expect(e!.heldFile).toEqual(facts());
    expect(await stateOf(w)).toBe("needs-check");
  });

  it("an encrypted project's held file is encrypted at rest, and its review entry sealed", async () => {
    const w = await world(true);
    const r = await hold(w);
    expect(r.held).toBe(`find/held/${w.entry.id}.pdf.enc`);
    const folder = kit.repo.getProject(w.p.id).folder;
    const raw = await readFile(join(kit.lib.root, folder, r.held));
    expect(raw.includes("%PDF-")).toBe(false);
    expect(raw.includes("Different Paper")).toBe(false);
    expect((await plainOf(kit, w.p, `${folder}/${r.held}`)).equals(await readFile(w.pdf))).toBe(true);
    const review = await readFile(join(kit.lib.root, folder, "review", "pending.jsonl"), "utf8");
    for (const s of ["Different Paper", "arxiv.org", "10.5555"]) expect(review).not.toContain(s);
  });

  it("one held file per entry, never more", async () => {
    const w = await world();
    await hold(w);
    await expect(hold(w)).rejects.toThrow(/already holds a file/u);
    expect(await heldFiles(w)).toHaveLength(1);
    expect(await pending(w)).toHaveLength(1);
  });

  it(`${FIND_HELD_MAX} held: the next is not kept and nothing is written`, async () => {
    const w = await world();
    const entries: FindEntry[] = Array.from({ length: FIND_HELD_MAX + 1 }, () => ({ ...w.entry, id: newId() }));
    await appendFindEntries(coreOf(), w.p.id, entries, "add");
    for (const e of entries.slice(0, FIND_HELD_MAX)) await holdMismatchedFile(coreOf(), w.p.id, { entry: { ...e, state: "needs-check" }, sourceId: w.sourceId, fromPath: w.pdf, facts: facts() });
    const last = entries[FIND_HELD_MAX]!;
    await expect(holdMismatchedFile(coreOf(), w.p.id, { entry: { ...last, state: "needs-check" }, sourceId: w.sourceId, fromPath: w.pdf, facts: facts() })).rejects.toBeInstanceOf(HeldFileLimitError);
    expect(await heldFiles(w)).toHaveLength(FIND_HELD_MAX);
    expect(await pending(w)).toHaveLength(FIND_HELD_MAX);
    expect((await readFindQueue(coreOf(), w.p.id)).get(last.id)?.state).toBe("fetching");
    // A decision frees a place.
    await resolveHeldFile(coreOf(), w.p.id, (await pending(w))[0]!.id, "discard");
    await holdMismatchedFile(coreOf(), w.p.id, { entry: { ...last, state: "needs-check" }, sourceId: w.sourceId, fromPath: w.pdf, facts: facts() });
    expect(await heldFiles(w)).toHaveLength(FIND_HELD_MAX);
  });

  it("an entry removed meanwhile: nothing is kept (no orphaned file or review entry)", async () => {
    const w = await world();
    await appendFindEntries(coreOf(), w.p.id, [w.entry], "remove");
    await expect(hold(w)).rejects.toBeInstanceOf(HeldFileEntryGoneError);
    expect(await heldFiles(w)).toEqual([]);
    expect(await pending(w)).toEqual([]);
  });

  for (const encrypted of [false, true]) {
    for (const point of ["before-changes", "before-audit", "between-audit", "before-marker-delete"] as CrashPoint[]) {
      it(`the held file, its review entry and the entry's line are one change: a crash at ${point} leaves all or none (${encrypted ? "sealed" : "plain"})`, async () => {
        const w = await world(encrypted);
        seams.crashAt = point;
        await expect(hold(w)).rejects.toBeInstanceOf(SimulatedCrash);
        await kit.reopen();
        if (encrypted) await kit.repo.unlockProject(w.p.id, PASS);
        const files = await heldFiles(w);
        const reviews = await pending(w);
        const state = await stateOf(w);
        const all = files.length === 1 && reviews.length === 1 && state === "needs-check";
        const none = files.length === 0 && reviews.length === 0 && state === "fetching";
        expect({ all, none, files, reviews: reviews.length, state }).toMatchObject(point === "before-marker-delete" ? { all: true } : { none: true });
      });
    }
  }
});

describe("the researcher's decision", () => {
  for (const encrypted of [false, true]) {
    it(`Use this file attaches it as the matching file would be, and the entry is in the library (${encrypted ? "sealed" : "plain"})`, async () => {
      const w = await world(encrypted);
      const r = await hold(w);
      const out = await resolveHeldFile(coreOf(), w.p.id, r.reviewId, "attach");
      expect(out.entry?.state).toBe("in-library");
      expect(await stateOf(w)).toBe("in-library");
      const sf = await kit.repo.getSource(w.p.id, w.sourceId);
      const a = sf.assets.find((x) => x.role === "original")!;
      expect(a).toMatchObject({ kind: "pdf", mime: "application/pdf", encrypted, acquired: { ...facts().acquired, check: { result: "accepted-after-mismatch", why: "other-doi" } } });
      expect((await plainOf(kit, w.p, a.path)).equals(await readFile(w.pdf))).toBe(true);
      expect(await heldFiles(w)).toEqual([]);
      expect(await pending(w)).toEqual([]);
      const all = await readReviewEntries(coreOf(), coreOf().state(w.p.id));
      expect(all[0]).toMatchObject({ status: "resolved", decision: "file-attached" });
      await expect(resolveHeldFile(coreOf(), w.p.id, r.reviewId, "attach")).rejects.toBeInstanceOf(ReviewEntryDecidedError);
    });

    it(`Not this file destroys the held copy, and the entry has no open copy (${encrypted ? "sealed" : "plain"})`, async () => {
      const w = await world(encrypted);
      const r = await hold(w);
      const out = await resolveHeldFile(coreOf(), w.p.id, r.reviewId, "discard");
      expect(out.entry).toMatchObject({ state: "no-open-copy", reason: { code: "not-this-file" } });
      expect(await heldFiles(w)).toEqual([]);
      expect((await kit.repo.getSource(w.p.id, w.sourceId)).assets).toEqual([]);
      expect((await readReviewEntries(coreOf(), coreOf().state(w.p.id)))[0]).toMatchObject({ status: "resolved", decision: "file-discarded" });
      // Destroyed, not merely moved: nothing of it is left in the library's temporary folder either.
      const tmpNames = await readdir(join(kit.lib.root, ".tmp")).catch(() => [] as string[]);
      expect(tmpNames.filter((n) => n.startsWith("trash-"))).toEqual([]);
    });
  }

  it("a locked project refuses a decision before anything is read", async () => {
    const w = await world(true);
    const r = await hold(w);
    kit.repo.lockProject(w.p.id);
    await expect(resolveHeldFile(coreOf(), w.p.id, r.reviewId, "attach")).rejects.toBeInstanceOf(ProjectLockedError);
  });

  for (const decision of ["attach", "discard"] as const) {
    for (const point of ["before-audit", "before-marker-delete"] as CrashPoint[]) {
      it(`${decision}: a crash at ${point} leaves the decision whole or not at all`, async () => {
        const w = await world();
        const r = await hold(w);
        seams.crashAt = point;
        await expect(resolveHeldFile(coreOf(), w.p.id, r.reviewId, decision)).rejects.toBeInstanceOf(SimulatedCrash);
        await kit.reopen();
        const done = point === "before-marker-delete";
        expect(await heldFiles(w)).toHaveLength(done ? 0 : 1);
        expect(await pending(w)).toHaveLength(done ? 0 : 1);
        expect(await stateOf(w)).toBe(done ? (decision === "attach" ? "in-library" : "no-open-copy") : "needs-check");
        expect((await kit.repo.getSource(w.p.id, w.sourceId)).assets).toHaveLength(done && decision === "attach" ? 1 : 0);
      });
    }
  }
});

describe("nothing is ever left orphaned", () => {
  it("removing the entry discards its held file and closes its review entry, in one change", async () => {
    const w = await world();
    await hold(w);
    await removeFindEntryWithHeld(coreOf(), w.p.id, needsCheck(w));
    expect(await heldFiles(w)).toEqual([]);
    expect(await pending(w)).toEqual([]);
    expect((await readReviewEntries(coreOf(), coreOf().state(w.p.id)))[0]).toMatchObject({ status: "resolved", decision: "entry-removed" });
    expect((await readFindQueue(coreOf(), w.p.id)).has(w.entry.id)).toBe(false);
  });

  it("removing the entry: a crash before the commit leaves the entry, its file and its review entry", async () => {
    const w = await world();
    await hold(w);
    seams.crashAt = "before-audit";
    await expect(removeFindEntryWithHeld(coreOf(), w.p.id, needsCheck(w))).rejects.toBeInstanceOf(SimulatedCrash);
    await kit.reopen();
    expect(await heldFiles(w)).toHaveLength(1);
    expect(await pending(w)).toHaveLength(1);
    expect(await stateOf(w)).toBe("needs-check");
  });

  it("deleting the source (or undoing it) takes its held file and closes its review entry", async () => {
    const w = await world();
    await hold(w);
    await kit.repo.deleteSource(w.p.id, w.sourceId);
    expect(await heldFiles(w)).toEqual([]);
    expect(await pending(w)).toEqual([]);
    // The entry can still be removed; nothing is left behind.
    await removeFindEntryWithHeld(coreOf(), w.p.id, needsCheck(w));
    expect((await readFindQueue(coreOf(), w.p.id)).size).toBe(0);
  });

  it("no title, address or file name in any audit entry of these changes", async () => {
    const w = await world();
    const r = await hold(w);
    await resolveHeldFile(coreOf(), w.p.id, r.reviewId, "attach");
    const w2 = { ...w, entry: { ...w.entry, id: newId() } };
    await appendFindEntries(coreOf(), w.p.id, [w2.entry], "add");
    const r2 = await holdMismatchedFile(coreOf(), w.p.id, { entry: needsCheck(w2), sourceId: w.sourceId, fromPath: w.pdf, facts: facts() });
    await resolveHeldFile(coreOf(), w.p.id, r2.reviewId, "discard");
    const w3 = { ...w, entry: { ...w.entry, id: newId() } };
    await appendFindEntries(coreOf(), w.p.id, [w3.entry], "add");
    await holdMismatchedFile(coreOf(), w.p.id, { entry: needsCheck(w3), sourceId: w.sourceId, fromPath: w.pdf, facts: facts() });
    await removeFindEntryWithHeld(coreOf(), w.p.id, needsCheck(w3));
    const text = JSON.stringify(await auditEvents(kit, w.p));
    for (const s of ["Different Paper", "arxiv.org", ADDRESS, "10.5555/ao.f11.other", "find/held", ".pdf", "Rivers and Memory"]) expect(text).not.toContain(s);
    expect(text).toContain("project.find.hold");
    expect(text).toContain("project.find.held-attach");
    expect(text).toContain("project.find.held-discard");
  });
});

describe("backups (A2)", () => {
  it("a backup of an encrypted project that holds a held file and its review entry restores: the held file readable, encrypted at rest", async () => {
    const w = await world(true);
    const r = await hold(w);
    const b = await backupProject(kit.repo, w.p.id);
    const restored = await restoreBackup(kit.repo, b.path);
    const folder = kit.repo.getProject(restored.projectId).folder;
    const raw = await readFile(join(kit.lib.root, folder, r.held));
    expect(raw.includes("%PDF-")).toBe(false);
    expect((await plainOf(kit, { ...w.p, id: restored.projectId }, `${folder}/${r.held}`)).equals(await readFile(w.pdf))).toBe(true);
    const reviews = (await readReviewEntries(coreOf(), coreOf().state(restored.projectId))).filter((e) => e.status === "pending");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ cause: { kind: "acquired-file-mismatch", findEntryId: w.entry.id, held: r.held }, heldFile: facts() });
    expect((await readFindQueue(coreOf(), restored.projectId)).get(w.entry.id)?.state).toBe("needs-check");
    // And the copy's held file can be decided on.
    const out = await resolveHeldFile(coreOf(), restored.projectId, reviews[0]!.id, "attach");
    expect(out.entry?.state).toBe("in-library");
  });
});
