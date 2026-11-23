/**
 * R470 a (FR-504, FR-527): a record whose ONLY original is a linked file that cannot be found now. The hold accepts it
 * (a found copy waits for the researcher's check), and "Use this file" ADDS the copy beside the linked original — the
 * link is never replaced, changed or removed, and the Missing files check still lists it — in the same governed,
 * audited, crash-safe change as any accepted found file. A record with a reachable linked file, or a stored one, is
 * still refused at the hold (R305 c).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { newId, type Project } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { OPEN_GOV, addSource, auditEvents, makeKit, makeProject, scratchFile, type Kit } from "../export/test-kit.js";
import { appendFindEntries, readFindQueue } from "../find/queue-store.js";
import type { FindEntry } from "../find/types.js";
import { checkIntegrity } from "../reconnect.js";
import { HeldFileSourceHasFileError, holdMismatchedFile, readReviewEntries, resolveHeldFile, type HeldFileFacts } from "./review.js";
import { SimulatedCrash, seams } from "./testing.js";
import type { RepoCore } from "./state.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-review-held-linked-");
});
afterEach(async () => {
  seams.crashAt = undefined;
  await kit.close();
});
const coreOf = () => (kit.repo as unknown as { core: RepoCore }).core;

const NOW = "2026-11-10T09:30:00.000Z";
const TITLE = "Rivers and Memory in Upland Villages";
const facts = (): HeldFileFacts => ({
  why: "looks-right",
  by: "title",
  kind: "pdf",
  bytes: 1234,
  acquired: { method: "free_copy", via: "service", service: "arxiv", address: "https://arxiv.org/pdf/2101.00001", at: NOW, tool: { name: "find-and-acquire", version: "0.1.0" }, access: "public" },
});

interface World {
  p: Project;
  sourceId: string;
  entry: FindEntry;
  /** The linked (or stored) file's place outside the library. */
  linkedAt: string;
  pdf: string;
}

/** A record with one original — linked from outside the library (removed when "linked-missing"), or stored — and its entry. */
async function world(file: "linked" | "linked-missing" | "stored"): Promise<World> {
  const p = await makeProject(kit, OPEN_GOV);
  const linkedAt = join(kit.tmp, "Drive", newId(), "rivers.pdf");
  await mkdir(dirname(linkedAt), { recursive: true });
  await writeFile(linkedAt, await buildPdf({ title: TITLE, lines: [TITLE] }));
  const sf = await addSource(kit, p, { title: TITLE, creators: [{ role: "author", family: "Okafor", given: "Amara" }], files: [{ path: linkedAt, role: "original", handling: file === "stored" ? "copy" : "link" }] });
  if (file === "linked-missing") await rm(linkedAt);
  const entry: FindEntry = { id: newId(), projectId: p.id, typed: "Okafor, Rivers and Memory", state: "fetching", createdAt: NOW, updatedAt: NOW, attempts: 0, sourceId: sf.source.id, copyDespiteLink: true };
  await appendFindEntries(coreOf(), p.id, [entry], "add");
  const pdf = await scratchFile(kit, "found.pdf", await buildPdf({ title: TITLE, author: "Amara Okafor", lines: [TITLE, "Amara Okafor"] }));
  return { p, sourceId: sf.source.id, entry, linkedAt, pdf };
}
const hold = (w: World) => holdMismatchedFile(coreOf(), w.p.id, { entry: { ...w.entry, state: "needs-check", reason: { code: "file-looks-right" }, updatedAt: "2026-11-10T09:31:00.000Z" }, sourceId: w.sourceId, fromPath: w.pdf, facts: facts() });
const pending = async (w: World) => (await readReviewEntries(coreOf(), coreOf().state(w.p.id))).filter((e) => e.status === "pending");
const opOf = (e: { details?: unknown }) => (e.details as { op?: string } | undefined)?.op;

describe("R470 a: the hold accepts a record whose only original is a linked file that cannot be found", () => {
  it("the found copy is held for the researcher's check; nothing is attached", async () => {
    const w = await world("linked-missing");
    const before = (await kit.repo.getSource(w.p.id, w.sourceId)).assets;
    await hold(w);
    expect(await pending(w)).toHaveLength(1);
    expect((await readFindQueue(coreOf(), w.p.id)).get(w.entry.id)?.state).toBe("needs-check");
    expect((await kit.repo.getSource(w.p.id, w.sourceId)).assets).toEqual(before);
  });

  for (const file of ["linked", "stored"] as const) {
    it(`a record whose ${file === "linked" ? "linked file can be reached" : "original is stored"} is still refused, and nothing is written`, async () => {
      const w = await world(file);
      await expect(hold(w)).rejects.toBeInstanceOf(HeldFileSourceHasFileError);
      expect(await pending(w)).toEqual([]);
      expect((await readFindQueue(coreOf(), w.p.id)).get(w.entry.id)?.state).toBe("fetching");
    });
  }
});

describe("R470 a: Use this file ADDS the found copy beside the missing linked original", () => {
  it("the link is kept exactly as it was, the copy is a stored original of the source, and the Missing files check still lists the link", async () => {
    const w = await world("linked-missing");
    const [link] = (await kit.repo.getSource(w.p.id, w.sourceId)).assets;
    const { reviewId } = await hold(w);
    const out = await resolveHeldFile(coreOf(), w.p.id, reviewId, "attach");
    expect(out.entry?.state).toBe("in-library");
    const assets = (await kit.repo.getSource(w.p.id, w.sourceId)).assets;
    expect(assets).toHaveLength(2);
    expect(assets[0]).toEqual(link);
    expect(assets[1]).toMatchObject({ id: out.asset!.id, role: "original", kind: "pdf", acquired: { method: "free_copy", check: { result: "match", by: "title" } } });
    expect(assets[1]!.linked).toBeUndefined();
    // The Missing files screen's check: the linked file is still missing; the copy is there.
    const report = await checkIntegrity(kit.lib, "full", { keyRing: kit.ring });
    expect(report.missing.map((m) => m.assetId)).toEqual([link!.id]);
    // The audit says a copy was added (the asset's id), never that a file was replaced.
    const ev = (await auditEvents(kit, w.p)).filter((e) => opOf(e) === "project.find.held-attach");
    // One change: its capture and its store, each naming the asset added.
    expect(ev.map((e) => [e.action, e.entity, (e.details as { asset?: string }).asset])).toEqual([
      ["capture", { type: "asset", id: out.asset!.id }, out.asset!.id],
      ["store", { type: "asset", id: out.asset!.id }, out.asset!.id],
    ]);
    expect(JSON.stringify(ev)).not.toMatch(/replac/iu);
    expect(JSON.stringify(ev)).not.toContain(link!.id);
  });

  it("when the linked file comes back, both are there", async () => {
    const w = await world("linked-missing");
    const { reviewId } = await hold(w);
    await resolveHeldFile(coreOf(), w.p.id, reviewId, "attach");
    await writeFile(w.linkedAt, await buildPdf({ title: TITLE, lines: [TITLE] }));
    const report = await checkIntegrity(kit.lib, "full", { keyRing: kit.ring });
    expect(report.missing).toEqual([]);
    expect((await kit.repo.getSource(w.p.id, w.sourceId)).assets.map((a) => !!a.linked)).toEqual([true, false]);
  });

  it("a crash inside the change leaves the source as it was: the link alone, the copy still waiting", async () => {
    const w = await world("linked-missing");
    const before = (await kit.repo.getSource(w.p.id, w.sourceId)).assets;
    const { reviewId } = await hold(w);
    seams.crashAt = "before-audit";
    await expect(resolveHeldFile(coreOf(), w.p.id, reviewId, "attach")).rejects.toBeInstanceOf(SimulatedCrash);
    seams.crashAt = undefined;
    await kit.reopen();
    expect((await kit.repo.getSource(w.p.id, w.sourceId)).assets).toEqual(before);
    expect(await pending(w)).toHaveLength(1);
  });
});
