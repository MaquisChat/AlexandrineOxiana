/**
 * Whole-channel capture and transcription (R668, R669): the project's transcription list, written to its job
 * journal (R31) as one `transcription.list` record and a `transcription.entry` record per source.
 */
import type { Project, SourceDraft, SourceFile } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OPEN_GOV, addSource, auditEvents, makeKit, makeProject, scratchFile, type Kit } from "../export/test-kit.js";
import { PolicyDeniedError } from "../repo/errors.js";
import {
  TRANSCRIPTION_LIST_ID, addToTranscriptionList, markTranscriptionEntry, readTranscriptionList, setTranscriptionListState, soundSecondsOf,
  stopTranscriptionList,
} from "./transcription-list.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-transcription-list-");
});
afterEach(async () => {
  await kit.close();
});

/** A source with a recording; `duration` is the platform's length of it (in its details, as a capture keeps them). */
async function audioSource(p: Project, title: string, duration?: number): Promise<SourceFile> {
  const audio = await scratchFile(kit, `${title}.mp3`, Buffer.alloc(64, title.length));
  const draft: SourceDraft = {
    projectIds: [p.id], type: "audio", title: { variants: [{ lang: "en", kind: "original", value: title }] }, creators: [], identifiers: {},
    caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [],
  };
  return kit.repo.createSource(p.id, draft, [{ path: audio, role: "original", handling: "copy" }], {
    provenance: {
      captureMethod: "manual_upload", capturedAt: kit.clock.now.toISOString(), tool: { name: "test", version: "1" }, fileHashes: {},
      legal: { status: "public", basis: "test basis" }, identifiable: false, ...(duration !== undefined ? { platformSnapshot: { id: title, duration } } : {}),
    },
  });
}

const pendingIds = async (p: Project) => (await readTranscriptionList(kit.repo, p.id)).pending.map((e) => e.entry.sourceId);

describe("the transcription list", () => {
  it("addToTranscriptionList evaluates process transcription once and adds each new source once", async () => {
    const denied = await makeProject(kit, `${OPEN_GOV}processing:\n  transcription: []\n`);
    const d1 = await audioSource(denied, "One");
    const d2 = await audioSource(denied, "Two");
    const before = (await auditEvents(kit, denied)).length;
    await expect(addToTranscriptionList(kit.repo, denied.id, [{ sourceId: d1.source.id }, { sourceId: d2.source.id }])).rejects.toBeInstanceOf(PolicyDeniedError);
    const events = (await auditEvents(kit, denied)).slice(before);
    expect(events.filter((e) => e.decision?.result === "deny")).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(await readTranscriptionList(kit.repo, denied.id)).toEqual({ state: "running", total: 0, done: 0, failed: 0, pending: [] });

    const p = await makeProject(kit);
    const a = await audioSource(p, "Alpha", 125);
    const b = await audioSource(p, "Beta");
    const paper = await addSource(kit, p, { title: "Paper" });
    const n = (await auditEvents(kit, p)).length;
    const r = await addToTranscriptionList(kit.repo, p.id, [
      { sourceId: a.source.id, model: "small" }, { sourceId: a.source.id }, { sourceId: paper.source.id }, { sourceId: b.source.id },
    ]);
    expect(r).toEqual({ added: 2 });
    expect((await auditEvents(kit, p)).length).toBe(n); // an allow is not audited here
    const list = await readTranscriptionList(kit.repo, p.id);
    expect(list).toMatchObject({ state: "running", total: 2, done: 0, failed: 0 });
    expect(list.pending.map((e) => [e.status, e.entry])).toEqual([
      ["queued", { sourceId: a.source.id, model: "small", title: "Alpha", soundSec: 125 }],
      ["queued", { sourceId: b.source.id, model: "medium", title: "Beta" }],
    ]);
    expect(new Set([TRANSCRIPTION_LIST_ID, ...list.pending.map((e) => e.entryId)]).size).toBe(3);
    expect(list.pending.every((e) => e.addedAt >= kit.clock.now.toISOString())).toBe(true);
    // Already pending: not added again.
    expect(await addToTranscriptionList(kit.repo, p.id, [{ sourceId: a.source.id }])).toEqual({ added: 0 });
    expect(await pendingIds(p)).toEqual([a.source.id, b.source.id]);
    // A source that is gone is not added.
    await kit.repo.deleteSource(p.id, paper.source.id);
    expect(await addToTranscriptionList(kit.repo, p.id, [{ sourceId: paper.source.id }])).toEqual({ added: 0 });
  });

  it("adding to an empty list resets total, done and failed", async () => {
    const p = await makeProject(kit);
    const a = await audioSource(p, "Alpha");
    const b = await audioSource(p, "Beta");
    const c = await audioSource(p, "Gamma");
    await addToTranscriptionList(kit.repo, p.id, [{ sourceId: a.source.id }, { sourceId: b.source.id }]);
    const [ea, eb] = (await readTranscriptionList(kit.repo, p.id)).pending;
    await markTranscriptionEntry(kit.repo, p.id, ea!.entryId, { status: "done" });
    await markTranscriptionEntry(kit.repo, p.id, eb!.entryId, { status: "failed", error: "WORKER_FAILED" });
    expect(await readTranscriptionList(kit.repo, p.id)).toMatchObject({ total: 2, done: 1, failed: 1, pending: [] });
    await addToTranscriptionList(kit.repo, p.id, [{ sourceId: c.source.id }]);
    expect(await readTranscriptionList(kit.repo, p.id)).toMatchObject({ total: 1, done: 0, failed: 0 });
    // Not empty: added on top.
    await addToTranscriptionList(kit.repo, p.id, [{ sourceId: a.source.id }]);
    expect(await readTranscriptionList(kit.repo, p.id)).toMatchObject({ total: 2, done: 0, failed: 0 });
    expect(await pendingIds(p)).toEqual([c.source.id, a.source.id]);
  });

  it("markTranscriptionEntry done and failed move the counters", async () => {
    const p = await makeProject(kit);
    const s = [await audioSource(p, "Alpha"), await audioSource(p, "Beta"), await audioSource(p, "Gamma")];
    await addToTranscriptionList(kit.repo, p.id, s.map((x) => ({ sourceId: x.source.id })));
    const [e0, e1, e2] = (await readTranscriptionList(kit.repo, p.id)).pending;
    await markTranscriptionEntry(kit.repo, p.id, e0!.entryId, { status: "running", jobId: "job-0" });
    let list = await readTranscriptionList(kit.repo, p.id);
    expect(list.pending.map((e) => [e.status, e.entry.jobId])).toEqual([["running", "job-0"], ["queued", undefined], ["queued", undefined]]);
    expect(list.pending[0]!.entryId).toBe(e0!.entryId); // the head stays the head
    await markTranscriptionEntry(kit.repo, p.id, e0!.entryId, { status: "done" });
    await markTranscriptionEntry(kit.repo, p.id, e1!.entryId, { status: "failed", error: "WORKER_FAILED" });
    list = await readTranscriptionList(kit.repo, p.id);
    expect(list).toMatchObject({ total: 3, done: 1, failed: 1 });
    expect(list.pending.map((e) => e.entryId)).toEqual([e2!.entryId]);
    // Marked again: counted once.
    await markTranscriptionEntry(kit.repo, p.id, e0!.entryId, { status: "done" });
    expect(await readTranscriptionList(kit.repo, p.id)).toMatchObject({ total: 3, done: 1, failed: 1 });
    // A cancelled entry (its source was deleted) is no longer one to do.
    await markTranscriptionEntry(kit.repo, p.id, e2!.entryId, { status: "cancelled", error: "NOT_FOUND" });
    expect(await readTranscriptionList(kit.repo, p.id)).toMatchObject({ total: 2, done: 1, failed: 1, pending: [] });
  });

  it("stopTranscriptionList cancels every pending entry and returns the running entries' job ids", async () => {
    const p = await makeProject(kit);
    const s = [await audioSource(p, "Alpha"), await audioSource(p, "Beta"), await audioSource(p, "Gamma"), await audioSource(p, "Delta")];
    await addToTranscriptionList(kit.repo, p.id, s.map((x) => ({ sourceId: x.source.id })));
    const [e0, e1] = (await readTranscriptionList(kit.repo, p.id)).pending;
    await markTranscriptionEntry(kit.repo, p.id, e0!.entryId, { status: "done" });
    await markTranscriptionEntry(kit.repo, p.id, e1!.entryId, { status: "running", jobId: "job-1" });
    await setTranscriptionListState(kit.repo, p.id, "paused");
    expect(await stopTranscriptionList(kit.repo, p.id)).toEqual({ jobIds: ["job-1"] });
    const list = await readTranscriptionList(kit.repo, p.id);
    expect(list).toMatchObject({ pending: [], done: 1, failed: 0, total: 1 });
    expect(await stopTranscriptionList(kit.repo, p.id)).toEqual({ jobIds: [] });
  });

  it("the list state survives a re-read", async () => {
    const p = await makeProject(kit, OPEN_GOV, true);
    const a = await audioSource(p, "Alpha");
    await addToTranscriptionList(kit.repo, p.id, [{ sourceId: a.source.id }]);
    await setTranscriptionListState(kit.repo, p.id, "paused");
    const repo = await kit.reopen();
    expect(await readTranscriptionList(repo, p.id)).toMatchObject({ state: "paused", total: 1, pending: [{ status: "queued", entry: { sourceId: a.source.id } }] });
    await setTranscriptionListState(repo, p.id, "running");
    expect((await readTranscriptionList(repo, p.id)).state).toBe("running");
  });

  it("soundSecondsOf prefers the platform duration, then the recording's durationSec", () => {
    const sf = (snapshot: unknown, metadata: unknown, kind = "video") =>
      ({
        source: { provenance: { platformSnapshot: snapshot } },
        assets: [{ id: "a", role: "original", kind, path: "x", metadata }],
      }) as unknown as SourceFile;
    expect(soundSecondsOf(sf({ duration: 125 }, { durationSec: 99 }))).toBe(125);
    expect(soundSecondsOf(sf({ duration: "long" }, { durationSec: 99 }))).toBe(99);
    expect(soundSecondsOf(sf(undefined, { durationSec: 42.5 }, "audio"))).toBe(42.5);
    expect(soundSecondsOf(sf({ duration: 0 }, undefined))).toBeUndefined();
    expect(soundSecondsOf(sf(undefined, { durationSec: 10 }, "image"))).toBeUndefined();
  });
});
