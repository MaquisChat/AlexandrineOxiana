/**
 * Task F11 (R277 b–c, A2): a file that did not clearly match its record is held in the project for the researcher.
 * The held file, its review entry and the queue entry's line are one governed change; "Use this file" and "Not this
 * file" are one change each; removing the entry, or the source, takes the held file and closes its review entry in
 * the same change. Nothing is ever left orphaned; an encrypted project's held file is encrypted at rest, and its
 * backup restores.
 */
import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { newId, type Project } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { backupProject, restoreBackup } from "../export/backup.js";
import { DEID_GOV, OPEN_GOV, PASS, PSEUDO_GOV, addSource, auditEvents, makeKit, makeProject, plainOf, scratchFile, type Kit } from "../export/test-kit.js";
import { appendFindEntries, mendSeams, readFindQueue } from "../find/queue-store.js";
import { decideReview } from "../import/bulk/review.js";
import { undoBatch } from "../import/bulk/undo.js";
import { FIND_QUEUE_OPS, type FindEntry } from "../find/types.js";
import { ProjectLockedError, ReviewEntryDecidedError } from "./errors.js";
import {
  FIND_HELD_MAX,
  FIND_HELD_OPS,
  HELD_FILE_REASON,
  HeldFileEntryGoneError,
  HeldFileLimitError,
  HeldFileSourceHasFileError,
  heldWaitingCount,
  holdMismatchedFile,
  readReviewEntries,
  removeFindEntryWithHeld,
  resolveHeldFile,
  type HeldFileFacts,
} from "./review.js";
import { SimulatedCrash, seams, type CrashPoint } from "./testing.js";
import { addCapturedOriginal } from "./repo.js";
import { runMutation } from "./mutate.js";
import { REVIEW_FILE } from "./review.js";
import { FIND_REASON_TEXT, HELD_FILE_LOOKS_RIGHT_TEXT, HELD_FILE_REVIEW_TEXT } from "@ao/shared";
import type { RepoCore } from "./state.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-review-held-");
});
afterEach(async () => {
  seams.crashAt = undefined;
  mendSeams.afterMend = undefined;
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

/** R296 b: what the check said of a file it matched — advice only; the file waits for the researcher all the same. */
const LOOKS_RIGHT: Partial<HeldFileFacts> = { why: "looks-right", by: "title" };
const needsCheck = (w: World, why: HeldFileFacts["why"] = "other-doi"): FindEntry => ({ ...w.entry, state: "needs-check", reason: { code: `file-${why}` }, updatedAt: "2026-11-10T09:31:00.000Z" });
const hold = (w: World, extra: Partial<HeldFileFacts> = {}) => holdMismatchedFile(coreOf(), w.p.id, { entry: needsCheck(w, extra.why), sourceId: w.sourceId, fromPath: w.pdf, facts: facts(extra) });
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
    // R296 d: at most 50, and the refusal says so in the queue's own words; the count is one read of the review file.
    expect(FIND_HELD_MAX).toBe(50);
    expect(new HeldFileLimitError().message).toBe(FIND_REASON_TEXT["held-full"]);
    expect(await heldWaitingCount(coreOf(), w.p.id)).toBe(FIND_HELD_MAX);
    expect(await heldFiles(w)).toHaveLength(FIND_HELD_MAX);
    expect(await pending(w)).toHaveLength(FIND_HELD_MAX);
    expect((await readFindQueue(coreOf(), w.p.id)).get(last.id)?.state).toBe("fetching");
    // A decision frees a place.
    await resolveHeldFile(coreOf(), w.p.id, (await pending(w))[0]!.id, "discard");
    expect(await heldWaitingCount(coreOf(), w.p.id)).toBe(FIND_HELD_MAX - 1);
    await holdMismatchedFile(coreOf(), w.p.id, { entry: { ...last, state: "needs-check" }, sourceId: w.sourceId, fromPath: w.pdf, facts: facts() });
    expect(await heldFiles(w)).toHaveLength(FIND_HELD_MAX);
  });

  it("R296 b: a file the check matched is held exactly as one it did not match, with the looks-right sentence as its reason", async () => {
    const w = await world();
    const r = await hold(w, LOOKS_RIGHT);
    expect(r.held).toBe(`find/held/${w.entry.id}.pdf`);
    expect(await heldFiles(w)).toEqual([`${w.entry.id}.pdf`]);
    const [e] = await pending(w);
    expect(e).toMatchObject({ id: r.reviewId, sourceId: w.sourceId, kind: "verification", reasons: [HELD_FILE_LOOKS_RIGHT_TEXT], cause: { kind: "acquired-file-mismatch", findEntryId: w.entry.id, held: r.held } });
    expect(e!.heldFile).toEqual(facts(LOOKS_RIGHT));
    expect((await readFindQueue(coreOf(), w.p.id)).get(w.entry.id)).toMatchObject({ state: "needs-check", reason: { code: "file-looks-right" } });
    // The mismatch's sentence is the one declared in the shared module.
    expect(HELD_FILE_REASON).toBe(HELD_FILE_REVIEW_TEXT);
  });

  it("an entry removed meanwhile: nothing is kept (no orphaned file or review entry)", async () => {
    const w = await world();
    await appendFindEntries(coreOf(), w.p.id, [w.entry], "remove");
    await expect(hold(w)).rejects.toBeInstanceOf(HeldFileEntryGoneError);
    expect(await heldFiles(w)).toEqual([]);
    expect(await pending(w)).toEqual([]);
  });

  for (const [what, extra] of [["did not match", {}], ["looks right (R296)", LOOKS_RIGHT]] as const)
  for (const encrypted of [false, true]) {
    for (const point of ["before-changes", "before-audit", "between-audit", "before-marker-delete"] as CrashPoint[]) {
      it(`the held file (${what}), its review entry and the entry's line are one change: a crash at ${point} leaves all or none (${encrypted ? "sealed" : "plain"})`, async () => {
        const w = await world(encrypted);
        seams.crashAt = point;
        await expect(hold(w, extra)).rejects.toBeInstanceOf(SimulatedCrash);
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

  for (const encrypted of [false, true]) {
    it(`R296 b: Use this file on a file that looks right records the check's result, match (${encrypted ? "sealed" : "plain"})`, async () => {
      const w = await world(encrypted);
      const r = await hold(w, LOOKS_RIGHT);
      const out = await resolveHeldFile(coreOf(), w.p.id, r.reviewId, "attach");
      expect(out.entry?.state).toBe("in-library");
      const a = (await kit.repo.getSource(w.p.id, w.sourceId)).assets.find((x) => x.role === "original")!;
      expect(a.acquired).toEqual({ ...facts().acquired, check: { result: "match", by: "title" } });
      expect(await heldFiles(w)).toEqual([]);
      expect((await readReviewEntries(coreOf(), coreOf().state(w.p.id)))[0]).toMatchObject({ status: "resolved", decision: "file-attached" });
    });
  }

  it("a locked project refuses a decision before anything is read", async () => {
    const w = await world(true);
    const r = await hold(w);
    kit.repo.lockProject(w.p.id);
    await expect(resolveHeldFile(coreOf(), w.p.id, r.reviewId, "attach")).rejects.toBeInstanceOf(ProjectLockedError);
  });

  for (const [what, extra] of [["did not match", {}], ["looks right (R296)", LOOKS_RIGHT]] as const)
  for (const decision of ["attach", "discard"] as const) {
    for (const point of ["before-audit", "before-marker-delete"] as CrashPoint[]) {
      it(`${decision} (${what}): a crash at ${point} leaves the decision whole or not at all`, async () => {
        const w = await world();
        const r = await hold(w, extra);
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

describe("R305 c: a source that has a readable file gets no waiting file", () => {
  /** The researcher's own file, added to the record by hand. */
  const mineFile = async () => scratchFile(kit, `mine-${newId()}.pdf`, await buildPdf({ title: TITLE, author: "Amara Okafor", lines: [TITLE, "Amara Okafor"] }));
  const addFrom = (w: World, mine: string) => addCapturedOriginal(kit.repo, w.p.id, w.sourceId, { fromPath: mine, kind: "pdf", ext: "pdf", mime: "application/pdf", label: "mine" }, "manual_upload");
  const addMine = async (w: World) => addFrom(w, await mineFile());
  const opOf = (e: { details?: unknown }) => (e.details as { op?: string } | undefined)?.op;
  const holdOps = async (w: World) => (await auditEvents(kit, w.p)).filter((e) => opOf(e) === "project.find.hold");

  for (const [what, extra] of [["did not match", {}], ["looks right", LOOKS_RIGHT]] as const) {
    it(`the hold is refused inside its change when the source already has a readable original; nothing is written (${what})`, async () => {
      const w = await world();
      await addMine(w);
      await expect(hold(w, extra)).rejects.toBeInstanceOf(HeldFileSourceHasFileError);
      expect(await heldFiles(w)).toEqual([]);
      expect(await pending(w)).toEqual([]);
      expect(await stateOf(w)).toBe("fetching");
      expect(await holdOps(w)).toEqual([]);
      expect((await kit.repo.getSource(w.p.id, w.sourceId)).assets).toHaveLength(1);
    });
  }

  it("the file added and the hold at the same moment: either held (the source had no file when the hold's change began) or refused with nothing held — never both", async () => {
    for (let i = 0; i < 6; i++) {
      const w = await world();
      const mine = await mineFile();
      // Started in both orders, in the same tick: the two changes queue one behind the other, whichever comes first.
      const [h, a] =
        i % 2 === 0
          ? await Promise.allSettled([hold(w, LOOKS_RIGHT), addFrom(w, mine)])
          : await (async () => {
              const added = addFrom(w, mine);
              const held = hold(w, LOOKS_RIGHT);
              const [x, y] = await Promise.allSettled([held, added]);
              return [x, y] as const;
            })();
      expect(a.status).toBe("fulfilled");
      const ops = (await auditEvents(kit, w.p)).map(opOf);
      if (h.status === "fulfilled") {
        // Held: the hold's change came first; the researcher's file after it.
        expect(await heldFiles(w)).toHaveLength(1);
        expect(ops.indexOf("project.find.hold")).toBeLessThan(ops.indexOf("asset.add-original"));
      } else {
        expect(h.reason).toBeInstanceOf(HeldFileSourceHasFileError);
        expect(await heldFiles(w)).toEqual([]);
        expect(await pending(w)).toEqual([]);
        expect(ops).not.toContain("project.find.hold");
      }
    }
  });
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
    // R305 c: the first record has its file now; the next holds are for a second record without one.
    const second = (await addSource(kit, w.p, { title: TITLE, creators: [{ role: "author", family: "Okafor", given: "Amara" }] })).source.id;
    const w2 = { ...w, sourceId: second, entry: { ...w.entry, id: newId(), sourceId: second } };
    await appendFindEntries(coreOf(), w.p.id, [w2.entry], "add");
    const r2 = await holdMismatchedFile(coreOf(), w.p.id, { entry: needsCheck(w2), sourceId: second, fromPath: w.pdf, facts: facts() });
    await resolveHeldFile(coreOf(), w.p.id, r2.reviewId, "discard");
    const w3 = { ...w, sourceId: second, entry: { ...w.entry, id: newId(), sourceId: second } };
    await appendFindEntries(coreOf(), w.p.id, [w3.entry], "add");
    await holdMismatchedFile(coreOf(), w.p.id, { entry: needsCheck(w3), sourceId: second, fromPath: w.pdf, facts: facts() });
    await removeFindEntryWithHeld(coreOf(), w.p.id, needsCheck(w3));
    const text = JSON.stringify(await auditEvents(kit, w.p));
    for (const s of ["Different Paper", "arxiv.org", ADDRESS, "10.5555/ao.f11.other", "find/held", ".pdf", "Rivers and Memory"]) expect(text).not.toContain(s);
    expect(text).toContain("project.find.hold");
    expect(text).toContain("project.find.held-attach");
    expect(text).toContain("project.find.held-discard");
  });
});

describe("R503 a: a queue whose last line an unclean stop tore", () => {
  const queueFile = (w: World) => join(kit.lib.root, kit.repo.getProject(w.p.id).folder, "find", "queue.jsonl");
  const tear = (w: World) => appendFile(queueFile(w), '{"id":"half'); // by something else (no newline)
  /** The ops of the audit entries written since `from` (one per change: its store request's entry). */
  const opsSince = async (w: World, from: number) =>
    (await auditEvents(kit, w.p))
      .slice(from)
      .filter((e) => e.action === "store")
      .map((e) => e.details?.op);

  it("the hold, a decision and the entry's removal each cut it first by a change of its own, then make their own change", async () => {
    for (const decide of ["attach", "discard", "remove"] as const) {
      const w = await world();
      await tear(w);
      let from = (await auditEvents(kit, w.p)).length;
      await hold(w);
      expect(await opsSince(w, from)).toEqual([FIND_QUEUE_OPS.repair, FIND_HELD_OPS.hold]);
      expect(await stateOf(w)).toBe("needs-check");
      await tear(w);
      from = (await auditEvents(kit, w.p)).length;
      if (decide === "remove") await removeFindEntryWithHeld(coreOf(), w.p.id, needsCheck(w));
      else await resolveHeldFile(coreOf(), w.p.id, (await pending(w))[0]!.id, decide);
      expect(await opsSince(w, from)).toEqual([FIND_QUEUE_OPS.repair, decide === "remove" ? FIND_QUEUE_OPS.remove : FIND_HELD_OPS[decide]]);
      const raw = await readFile(queueFile(w), "utf8");
      expect(raw).not.toContain("half");
      expect(raw.endsWith("\n")).toBe(true);
      expect(await heldFiles(w)).toEqual([]);
    }
  });

  /*
   * R505 b, R509 (I1): the three changes that remove a source holding a file (deleting it; an import's decision on a
   * duplicate, "merge" or "skip"; undoing an import) add the queue entry's "record-removed" line inside their own
   * change. Each cuts a torn last line first, by a change of its own (the queue's repair), so that line is always
   * written; a crash between the two leaves the queue whole and the removal not begun.
   */
  const BATCH = "019a0000-0000-7000-8000-0000000000b1";
  type Way = "delete" | "skip" | "merge" | "undo";
  const LARGER: Record<Way, string> = { delete: "source.delete", skip: "review.decide", merge: "review.decide", undo: "source.delete" };
  interface Removal extends World {
    run(): Promise<unknown>;
  }
  async function removal(way: Way, gov = OPEN_GOV, identifiable = false): Promise<Removal> {
    const p = await makeProject(kit, gov);
    const sf = await kit.repo.createSource(
      p.id,
      { projectIds: [p.id], type: "article-journal", title: { variants: [{ lang: "en", kind: "original", value: TITLE }] }, creators: [{ role: "author", family: "Okafor", given: "Amara" }], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [],
      {
        provenance: {
          captureMethod: "manual_upload",
          capturedAt: NOW,
          tool: { name: "test", version: "1" },
          fileHashes: {},
          ...(way === "undo" ? { importBatchId: BATCH } : {}),
          legal: { status: "unknown" },
          identifiable,
        },
        ...(way === "skip" || way === "merge" ? { reviewItem: { kind: "import" as const, fields: {}, reasons: ["It may be a duplicate."] } } : {}),
      },
    );
    const entry: FindEntry = { id: newId(), projectId: p.id, typed: "Okafor, Rivers and Memory", state: "fetching", createdAt: NOW, updatedAt: NOW, attempts: 0, sourceId: sf.source.id };
    await appendFindEntries(coreOf(), p.id, [entry], "add");
    const pdf = await scratchFile(kit, "1.pdf", await buildPdf({ title: "A Different Paper Entirely", lines: ["A Different Paper Entirely"] }));
    const w: World = { p, sourceId: sf.source.id, entry, pdf };
    await hold(w);
    const importItem = async () => (await pending(w)).find((e) => e.kind === "import")!.id;
    let run: () => Promise<unknown>;
    if (way === "delete") run = () => kit.repo.deleteSource(p.id, sf.source.id);
    else if (way === "skip") run = async () => decideReview(kit.repo, p.id, await importItem(), { action: "skip" });
    else if (way === "merge") {
      const target = await addSource(kit, p, { title: "The Same Paper, Kept", identifiable });
      run = async () => decideReview(kit.repo, p.id, await importItem(), { action: "merge", sourceId: target.source.id });
    } else {
      // A batch record as an import leaves it (the one source it created).
      await kit.repo.mutate(p.id, { action: "store", store: { identifiable: false, hasLocation: false } }, async (tx) => {
        const base = `${p.folder}/imports/batch-0001`;
        await tx.mkdir(base);
        await tx.writeFile(
          `${base}/batch.json`,
          JSON.stringify({ id: BATCH, projectId: p.id, number: 1, source: { kind: "folder", location: "Papers" }, options: {}, startedAt: NOW, counts: { created: 1, merged: 0, skipped: 0, failed: 0, needsReview: 0 }, state: "finished", createdSourceIds: [sf.source.id] }),
        );
        await tx.appendLine(`${base}/journal.jsonl`, JSON.stringify({ key: "a.pdf", outcome: "created", sourceId: sf.source.id }));
      });
      run = () => undoBatch(kit.repo, p.id, BATCH);
    }
    return { ...w, run };
  }
  const txnMarkers = async () => (await readdir(join(kit.lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => /^txn-.*\.json$/u.test(n));
  /** Each change's op once, in order (a change audits one entry per request it evaluates). */
  const changesSince = async (w: World, from: number) =>
    (await auditEvents(kit, w.p))
      .slice(from)
      .map((e) => (e.details as { op?: string } | undefined)?.op ?? e.action)
      .filter((op, i, all) => op !== all[i - 1]);
  const recordRemoved = async (w: World) => {
    const e = (await readFindQueue(coreOf(), w.p.id)).get(w.entry.id);
    return e?.state === "no-open-copy" && e.reason?.code === "record-removed";
  };
  const queueWhole = async (w: World) => {
    const raw = await readFile(queueFile(w), "utf8");
    return !raw.includes("half") && raw.endsWith("\n");
  };

  for (const way of ["delete", "skip", "merge", "undo"] as const) {
    it(`${way}: the torn line is cut by a change of its own first; then the removal writes the entry's "record-removed" line`, async () => {
      const w = await removal(way);
      await tear(w);
      const from = (await auditEvents(kit, w.p)).length;
      await w.run();
      const ops = await changesSince(w, from);
      expect(ops[0]).toBe(FIND_QUEUE_OPS.repair);
      expect(ops.filter((op) => op === FIND_QUEUE_OPS.repair)).toHaveLength(1);
      expect(ops).toContain(LARGER[way]);
      expect(kit.repo.listSourceIds(w.p.id)).not.toContain(w.sourceId);
      expect(await heldFiles(w)).toEqual([]);
      expect((await pending(w)).filter((e) => e.sourceId === w.sourceId)).toEqual([]);
      expect(await recordRemoved(w)).toBe(true);
      expect(await queueWhole(w)).toBe(true);
      expect(await txnMarkers()).toEqual([]);
    });

    it(`${way}: a crash between the queue's repair and the removal leaves the queue whole and the removal not begun; the next try finishes it`, async () => {
      const w = await removal(way);
      await tear(w);
      const waiting = (await pending(w)).length;
      mendSeams.afterMend = () => {
        throw new SimulatedCrash("simulated crash between the two changes");
      };
      await expect(w.run()).rejects.toBeInstanceOf(SimulatedCrash);
      mendSeams.afterMend = undefined;
      expect(await queueWhole(w)).toBe(true);
      expect(await txnMarkers()).toEqual([]);
      expect(kit.repo.listSourceIds(w.p.id)).toContain(w.sourceId);
      expect(await heldFiles(w)).toHaveLength(1);
      expect(await pending(w)).toHaveLength(waiting);
      expect(await stateOf(w)).toBe("needs-check");
      // Tried again: nothing is left to repair, and the removal writes its line.
      const from = (await auditEvents(kit, w.p)).length;
      await w.run();
      expect(await changesSince(w, from)).not.toContain(FIND_QUEUE_OPS.repair);
      expect(kit.repo.listSourceIds(w.p.id)).not.toContain(w.sourceId);
      expect(await recordRemoved(w)).toBe(true);
    });
  }

  for (const way of ["skip", "merge"] as const) {
    it(`${way}: a decision the project's rules refuse leaves the queue repaired and nothing else changed (the torn line was an earlier crash's)`, async () => {
      const w = await removal(way, DEID_GOV, true);
      await tear(w);
      // The rules now ask for a legal basis the identifiable source does not have: the decision's store is refused.
      const g = await kit.repo.getGovernance(w.p.id);
      await kit.repo.setGovernance(w.p.id, DEID_GOV.replace("requireLegalBasis: false", "requireLegalBasis: true"), { baseSha256: g.sha256, reason: "test: a legal basis is now required" });
      const waiting = (await pending(w)).length;
      const from = (await auditEvents(kit, w.p)).length;
      await expect(w.run()).rejects.toThrow(/legal basis/i);
      expect((await changesSince(w, from))[0]).toBe(FIND_QUEUE_OPS.repair);
      expect(await queueWhole(w)).toBe(true);
      expect(await txnMarkers()).toEqual([]);
      expect(kit.repo.listSourceIds(w.p.id)).toContain(w.sourceId);
      expect(await heldFiles(w)).toHaveLength(1);
      expect(await pending(w)).toHaveLength(waiting);
      expect(await stateOf(w)).toBe("needs-check");
    });
  }
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

describe("Task F17 (R329 e, f): a file handed over through the researcher's library waits like a found copy", () => {
  /** Free copies not allowed; the library allowed. */
  const LIB_ONLY = `${OPEN_GOV}acquireMethods: [reference_lookup, library_access]\n`;
  /** Free copies allowed; the library not. */
  const FREE_ONLY = `${OPEN_GOV}acquireMethods: [reference_lookup, free_copy]\n`;
  const LIB_ADDRESS = "https://ezproxy.lib.example.edu/login";
  const viaLibrary: Partial<HeldFileFacts> = {
    acquired: { method: "library_access", via: "sign-in-window", address: LIB_ADDRESS, at: NOW, tool: { name: "find-and-acquire", version: "0.1.0" }, access: "signed-in-session" },
  };
  async function worldUnder(gov: string): Promise<World> {
    const p = await makeProject(kit, gov);
    const sf = await addSource(kit, p, { title: TITLE, creators: [{ role: "author", family: "Okafor", given: "Amara" }] });
    const entry: FindEntry = { id: newId(), projectId: p.id, typed: "Okafor, Rivers and Memory", state: "waiting-sign-in", returnTo: { state: "no-open-copy" }, createdAt: NOW, updatedAt: NOW, attempts: 0, sourceId: sf.source.id };
    await appendFindEntries(coreOf(), p.id, [entry], "add");
    const pdf = await scratchFile(kit, "lib.pdf", await buildPdf({ title: TITLE, lines: [TITLE, "Amara Okafor"] }));
    return { p, sourceId: sf.source.id, entry, pdf };
  }
  const opOf = (e: { details?: unknown }) => (e.details as { op?: string } | undefined)?.op;
  const setRules = async (p: Project, yaml: string) => {
    const g = await kit.repo.getGovernance(p.id);
    await kit.repo.setGovernance(p.id, yaml, { baseSha256: g.sha256, reason: "test: the rules changed meanwhile" });
  };
  const holdHanded = (w: World, extra: Partial<HeldFileFacts> = {}) =>
    holdMismatchedFile(coreOf(), w.p.id, { entry: needsCheck(w, extra.why), sourceId: w.sourceId, fromPath: w.pdf, facts: facts({ ...viaLibrary, ...extra }), handedOver: true });

  it("the hold evaluates library_access for a file the library gave (not free_copy), and the audit says the method", async () => {
    const w = await worldUnder(LIB_ONLY);
    await holdHanded(w);
    expect(await heldFiles(w)).toHaveLength(1);
    const ev = (await auditEvents(kit, w.p)).filter((e) => opOf(e) === "project.find.hold");
    // One change: its capture (of library_access) and its store, each audited.
    expect(ev.map((e) => e.action)).toEqual(["capture", "store"]);
    for (const e of ev) expect(e.details).toMatchObject({ method: "library_access" });
    expect(JSON.stringify(ev)).not.toContain("ezproxy");
  });

  it("a found free copy's hold says its method too (free_copy)", async () => {
    const w = await world();
    await hold(w);
    const ev = (await auditEvents(kit, w.p)).filter((e) => opOf(e) === "project.find.hold");
    expect(ev[0]!.details).toMatchObject({ method: "free_copy" });
  });

  it("rules that refuse library_access refuse the hold of the library's file, even where free copies are allowed; nothing is written", async () => {
    const w = await worldUnder(FREE_ONLY);
    await expect(holdHanded(w)).rejects.toMatchObject({ name: "PolicyDeniedError" });
    expect(await heldFiles(w)).toEqual([]);
    expect(await pending(w)).toEqual([]);
    expect(await stateOf(w)).toBe("waiting-sign-in");
  });

  it("a found free copy is still asked as free_copy: refused where only the library is allowed", async () => {
    const w = await worldUnder(LIB_ONLY);
    await expect(hold(w)).rejects.toMatchObject({ name: "PolicyDeniedError" });
    expect(await heldFiles(w)).toEqual([]);
  });

  it(`R329 f: with ${FIND_HELD_MAX} files waiting a handed-over file is still held (${FIND_HELD_MAX + 1}); a found copy is not`, async () => {
    const w = await worldUnder(OPEN_GOV);
    const entries: FindEntry[] = Array.from({ length: FIND_HELD_MAX + 1 }, () => ({ ...w.entry, id: newId(), state: "fetching" as const, returnTo: undefined }));
    await appendFindEntries(coreOf(), w.p.id, entries, "add");
    for (const e of entries.slice(0, FIND_HELD_MAX)) await holdMismatchedFile(coreOf(), w.p.id, { entry: { ...e, state: "needs-check" }, sourceId: w.sourceId, fromPath: w.pdf, facts: facts() });
    await expect(holdMismatchedFile(coreOf(), w.p.id, { entry: { ...entries[FIND_HELD_MAX]!, state: "needs-check" }, sourceId: w.sourceId, fromPath: w.pdf, facts: facts() })).rejects.toBeInstanceOf(HeldFileLimitError);
    await holdHanded(w);
    expect(await heldWaitingCount(coreOf(), w.p.id)).toBe(FIND_HELD_MAX + 1);
    expect(await stateOf(w)).toBe("needs-check");
  });

  it("Use this file on the library's file evaluates library_access again and records how it was got; the audit says the method", async () => {
    const w = await worldUnder(LIB_ONLY);
    const r = await holdHanded(w, LOOKS_RIGHT);
    const out = await resolveHeldFile(coreOf(), w.p.id, r.reviewId, "attach");
    expect(out.entry?.state).toBe("in-library");
    const a = (await kit.repo.getSource(w.p.id, w.sourceId)).assets.find((x) => x.role === "original")!;
    expect(a.acquired).toEqual({ ...viaLibrary.acquired, check: { result: "match", by: "title" } });
    const ev = (await auditEvents(kit, w.p)).filter((e) => opOf(e) === "project.find.held-attach");
    expect(ev[0]!.details).toMatchObject({ method: "library_access" });
    expect(JSON.stringify(ev)).not.toContain("ezproxy");
  });

  it("Use this file is refused when the rules no longer allow library_access (allowing free copies does not help); nothing changes", async () => {
    const w = await worldUnder(LIB_ONLY);
    const r = await holdHanded(w);
    await setRules(w.p, FREE_ONLY);
    await expect(resolveHeldFile(coreOf(), w.p.id, r.reviewId, "attach")).rejects.toMatchObject({ name: "PolicyDeniedError" });
    expect((await kit.repo.getSource(w.p.id, w.sourceId)).assets).toEqual([]);
    expect(await pending(w)).toHaveLength(1);
    expect(await heldFiles(w)).toHaveLength(1);
  });

  it("R338 e: the method is looked at again inside the attach's change — an entry rewritten meanwhile under another method is refused; nothing is attached", async () => {
    const w = await worldUnder(LIB_ONLY);
    const r = await holdHanded(w, LOOKS_RIGHT);
    const core = coreOf();
    const [held] = (await pending(w)).filter((e) => e.id === r.reviewId);
    // Another change holds the write turn. Meanwhile "Use this file" reads the entry (library_access, which the rules
    // allow), asks the rules about that method, and waits behind it; the other change then rewrites the entry as a free
    // copy (which the rules do not allow).
    let open!: () => void;
    const gate = new Promise<void>((res) => (open = res));
    const serial = core.serial.bind(core);
    let queued = 0;
    core.serial = ((fn: () => Promise<unknown>) => {
      queued++;
      return serial(fn);
    }) as typeof core.serial;
    try {
      const rewriting = runMutation(core, w.p.id, { action: "store", store: { identifiable: false, hasLocation: false } }, async (tx) => {
        await gate;
        await tx.appendLine(`${tx.state.rel}/${REVIEW_FILE}`, JSON.stringify({ ...held!, heldFile: { ...held!.heldFile!, acquired: facts().acquired } }));
      });
      const attach = resolveHeldFile(core, w.p.id, r.reviewId, "attach");
      attach.catch(() => undefined);
      const end = Date.now() + 15_000;
      while (queued < 2) {
        if (Date.now() > end) throw new Error("timed out waiting for the attach to queue its change");
        await new Promise((res) => setTimeout(res, 5));
      }
      open();
      await rewriting;
      await expect(attach).rejects.toThrow(/how this file was got/u);
    } finally {
      core.serial = serial;
    }
    expect((await kit.repo.getSource(w.p.id, w.sourceId)).assets).toEqual([]);
    expect(await heldFiles(w)).toHaveLength(1);
  });

  it("a held file whose record names a method the app does not know is never held", async () => {
    const w = await worldUnder(OPEN_GOV);
    const odd = { ...facts(), acquired: { ...facts().acquired, method: "shadow" as unknown as "free_copy" } };
    await expect(holdMismatchedFile(coreOf(), w.p.id, { entry: needsCheck(w), sourceId: w.sourceId, fromPath: w.pdf, facts: odd })).rejects.toThrow(/how this file was got/u);
    expect(await heldFiles(w)).toEqual([]);
  });
});

describe("R347 c: the label of a used file (in its file's name, `<source> - <label>.pdf`) says how it was got", () => {
  const labelAfterUse = async (acquired: HeldFileFacts["acquired"]) => {
    const w = await world();
    const r = await holdMismatchedFile(coreOf(), w.p.id, { entry: needsCheck(w, "looks-right"), sourceId: w.sourceId, fromPath: w.pdf, facts: facts({ ...LOOKS_RIGHT, acquired }), ...(acquired.via === "sign-in-window" ? { handedOver: true as const } : {}) });
    await resolveHeldFile(coreOf(), w.p.id, r.reviewId, "attach");
    const a = (await kit.repo.getSource(w.p.id, w.sourceId)).assets.find((x) => x.role === "original")!;
    expect(a.acquired).toMatchObject({ method: acquired.method, via: acquired.via });
    return a.path.slice(a.path.lastIndexOf("/") + 1);
  };
  const window_ = { via: "sign-in-window" as const, address: "https://repository.example.edu/handle/1/2", at: NOW, tool: { name: "find-and-acquire", version: "0.1.0" }, access: "signed-in-session" as const };

  it("a free copy fetched in the app's own window is a \"fetched copy <date>\", never a \"free copy\"", async () => {
    const name = await labelAfterUse({ method: "free_copy", ...window_ });
    expect(name).toMatch(/ - fetched copy \d{4}-\d{2}-\d{2}\.pdf$/u);
    expect(name).not.toContain("free copy");
  });

  it("a service's free copy stays a \"free copy <date>\"; the library's file a \"library copy <date>\"", async () => {
    expect(await labelAfterUse(facts().acquired)).toMatch(/ - free copy \d{4}-\d{2}-\d{2}\.pdf$/u);
    expect(await labelAfterUse({ method: "library_access", ...window_, address: "https://ezproxy.lib.example.edu/x.pdf" })).toMatch(/ - library copy \d{4}-\d{2}-\d{2}\.pdf$/u);
  });
});
