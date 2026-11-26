/**
 * Whole-channel capture and transcription (R668, R669): the project's transcription list, written to its job
 * journal (R31) as one `transcription.list` record and a `transcription.entry` record per source.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Project, SourceDraft, SourceFile } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_GOV, addSource, auditEvents, makeKit, makeProject, scratchFile, type Kit } from "../export/test-kit.js";
import { appendJobRecords, compactJobJournal, journalPath, readJobJournal, type JobRecord, type ProjectKey } from "../job-journal.js";
import { PolicyDeniedError } from "../repo/errors.js";
import { authorizeProcessing, projectDataKey } from "../repo/repo.js";
import {
  TRANSCRIPTION_LIST_ID, addToTranscriptionList, markTranscriptionEntry, readTranscriptionList, setTranscriptionListState, soundSecondsOf,
  stopTranscriptionList,
} from "./transcription-list.js";

// The seam that counts how often the project's rules are asked (R672): the real function, observed.
vi.mock("../repo/repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repo/repo.js")>();
  return { ...actual, authorizeProcessing: vi.fn(actual.authorizeProcessing) };
});
const asked = () => vi.mocked(authorizeProcessing).mock.calls.filter(([, , req]) => req.action === "process" && req.process?.op === "transcription").length;

/**
 * What an older build does to this journal when it opens it (R672, I4): it takes every queued or running record
 * with no worker job for a worker job it cannot resume, and claims it as failed UNRECOVERABLE, keeping the data.
 */
async function olderBuildOpens(root: string, folder: string, projectId: string, key: ProjectKey): Promise<void> {
  const records = (await readJobJournal(root, folder, projectId, key)).records;
  const claimed: JobRecord[] = [...records.values()]
    .filter((r) => (r.status === "queued" || r.status === "running") && !r.job)
    .map((r) => {
      const { job: _job, error: _error, ...b } = r;
      return { ...b, status: "failed", updatedAt: new Date().toISOString(), error: "UNRECOVERABLE", attempt: randomUUID() };
    });
  await appendJobRecords(root, folder, key, claimed);
}

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
    vi.mocked(authorizeProcessing).mockClear();
    await expect(addToTranscriptionList(kit.repo, denied.id, [{ sourceId: d1.source.id }, { sourceId: d2.source.id }])).rejects.toBeInstanceOf(PolicyDeniedError);
    const events = (await auditEvents(kit, denied)).slice(before);
    expect(events.filter((e) => e.decision?.result === "deny")).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(asked()).toBe(1);
    expect(await readTranscriptionList(kit.repo, denied.id)).toEqual({ state: "running", total: 0, done: 0, failed: 0, pending: [] });

    const p = await makeProject(kit);
    const a = await audioSource(p, "Alpha", 125);
    const b = await audioSource(p, "Beta");
    const paper = await addSource(kit, p, { title: "Paper" });
    const n = (await auditEvents(kit, p)).length;
    vi.mocked(authorizeProcessing).mockClear();
    const r = await addToTranscriptionList(kit.repo, p.id, [
      { sourceId: a.source.id, model: "small" }, { sourceId: a.source.id }, { sourceId: paper.source.id }, { sourceId: b.source.id },
    ]);
    expect(r).toEqual({ added: 2 });
    expect(asked()).toBe(1); // once for the four items, not once per item
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

  it("adding to an emptied list keeps total, done and failed: only a Stop sets them to 0 (R692)", async () => {
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
    expect(await readTranscriptionList(kit.repo, p.id)).toMatchObject({ total: 3, done: 1, failed: 1 });
    // Not empty: added on top.
    await addToTranscriptionList(kit.repo, p.id, [{ sourceId: a.source.id }]);
    expect(await readTranscriptionList(kit.repo, p.id)).toMatchObject({ total: 4, done: 1, failed: 1 });
    expect(await pendingIds(p)).toEqual([c.source.id, a.source.id]);
    // A Stop (or "Remove from this list") is what sets them to 0.
    await stopTranscriptionList(kit.repo, p.id);
    expect(await readTranscriptionList(kit.repo, p.id)).toMatchObject({ total: 0, done: 0, failed: 0, pending: [] });
    await addToTranscriptionList(kit.repo, p.id, [{ sourceId: b.source.id }]);
    expect(await readTranscriptionList(kit.repo, p.id)).toMatchObject({ total: 1, done: 0, failed: 0 });
  });

  it("an entry that has ended never moves again: a Stop that lands as its job ends leaves the counters at 0 (R692)", async () => {
    const p = await makeProject(kit);
    const a = await audioSource(p, "Alpha");
    await addToTranscriptionList(kit.repo, p.id, [{ sourceId: a.source.id }]);
    const [ea] = (await readTranscriptionList(kit.repo, p.id)).pending;
    await markTranscriptionEntry(kit.repo, p.id, ea!.entryId, { status: "running", jobId: "job-a" });
    await stopTranscriptionList(kit.repo, p.id);
    // The job ended just before the Stop's write: the loop's mark comes after it.
    expect(await markTranscriptionEntry(kit.repo, p.id, ea!.entryId, { status: "done" })).toBe(false);
    expect(await markTranscriptionEntry(kit.repo, p.id, ea!.entryId, { status: "failed", error: "WORKER_FAILED" })).toBe(false);
    expect(await readTranscriptionList(kit.repo, p.id)).toEqual({ state: "running", total: 0, done: 0, failed: 0, pending: [] });
    // done -> failed is refused too.
    const b = await audioSource(p, "Beta");
    await addToTranscriptionList(kit.repo, p.id, [{ sourceId: b.source.id }]);
    const [eb] = (await readTranscriptionList(kit.repo, p.id)).pending;
    await markTranscriptionEntry(kit.repo, p.id, eb!.entryId, { status: "done" });
    expect(await markTranscriptionEntry(kit.repo, p.id, eb!.entryId, { status: "failed", error: "WORKER_FAILED" })).toBe(false);
    expect(await readTranscriptionList(kit.repo, p.id)).toMatchObject({ total: 1, done: 1, failed: 0 });
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
    // R672: Stop also empties the counters and leaves the list running.
    expect(await readTranscriptionList(kit.repo, p.id)).toEqual({ state: "running", total: 0, done: 0, failed: 0, pending: [] });
    expect(await stopTranscriptionList(kit.repo, p.id)).toEqual({ jobIds: [] });
  });

  it("an entry that has ended is never moved back to running or queued (R672)", async () => {
    const p = await makeProject(kit);
    const s = [await audioSource(p, "Alpha"), await audioSource(p, "Beta")];
    await addToTranscriptionList(kit.repo, p.id, s.map((x) => ({ sourceId: x.source.id })));
    const [e0, e1] = (await readTranscriptionList(kit.repo, p.id)).pending;
    expect(await stopTranscriptionList(kit.repo, p.id)).toEqual({ jobIds: [] });
    // The loop started the head's job just before the Stop: its late mark is refused.
    expect(await markTranscriptionEntry(kit.repo, p.id, e0!.entryId, { status: "running", jobId: "late-job" })).toBe(false);
    expect(await markTranscriptionEntry(kit.repo, p.id, e1!.entryId, { status: "queued" } as never)).toBe(false);
    expect(await readTranscriptionList(kit.repo, p.id)).toEqual({ state: "running", total: 0, done: 0, failed: 0, pending: [] });
    // Every other move is made.
    const c = await audioSource(p, "Gamma");
    await addToTranscriptionList(kit.repo, p.id, [{ sourceId: c.source.id }]);
    const [ec] = (await readTranscriptionList(kit.repo, p.id)).pending;
    expect(await markTranscriptionEntry(kit.repo, p.id, ec!.entryId, { status: "running", jobId: "job-c" })).toBe(true);
    expect(await markTranscriptionEntry(kit.repo, p.id, ec!.entryId, { status: "done" })).toBe(true);
    expect(await markTranscriptionEntry(kit.repo, p.id, ec!.entryId, { status: "running", jobId: "job-again" })).toBe(false);
    expect(await readTranscriptionList(kit.repo, p.id)).toEqual({ state: "running", total: 1, done: 1, failed: 0, pending: [] });
  });

  it("a late mark for an entry compaction has already removed returns false and writes nothing (R676)", async () => {
    const p = await makeProject(kit);
    const folder = kit.repo.getProject(p.id).folder;
    const s = [await audioSource(p, "Alpha"), await audioSource(p, "Beta")];
    await addToTranscriptionList(kit.repo, p.id, s.map((x) => ({ sourceId: x.source.id })));
    const [e0] = (await readTranscriptionList(kit.repo, p.id)).pending;
    await stopTranscriptionList(kit.repo, p.id);
    expect(await compactJobJournal(kit.lib.root, folder, p.id, null, 0)).toBe(true);
    expect((await readJobJournal(kit.lib.root, folder, p.id, null)).records.has(e0!.entryId)).toBe(false);
    const before = await readFile(journalPath(kit.lib.root, folder));
    expect(await markTranscriptionEntry(kit.repo, p.id, e0!.entryId, { status: "running", jobId: "late" })).toBe(false);
    expect(await markTranscriptionEntry(kit.repo, p.id, e0!.entryId, { status: "done" })).toBe(false);
    expect(await readFile(journalPath(kit.lib.root, folder))).toEqual(before);
    expect(await readTranscriptionList(kit.repo, p.id)).toEqual({ state: "running", total: 0, done: 0, failed: 0, pending: [] });
  });

  it("an entry failed UNRECOVERABLE without the older build's attempt mark stays failed (R676)", async () => {
    const p = await makeProject(kit);
    const folder = kit.repo.getProject(p.id).folder;
    const s = [await audioSource(p, "Alpha"), await audioSource(p, "Beta")];
    await addToTranscriptionList(kit.repo, p.id, s.map((x) => ({ sourceId: x.source.id })));
    const [e0, e1] = (await readTranscriptionList(kit.repo, p.id)).pending;
    await markTranscriptionEntry(kit.repo, p.id, e0!.entryId, { status: "failed", error: "UNRECOVERABLE" });
    expect((await readJobJournal(kit.lib.root, folder, p.id, null)).records.get(e0!.entryId)).toMatchObject({ status: "failed", error: "UNRECOVERABLE" });
    const list = await readTranscriptionList(kit.repo, p.id);
    expect(list).toMatchObject({ total: 2, done: 0, failed: 1 });
    expect(list.pending.map((e) => e.entryId)).toEqual([e1!.entryId]);
    expect(await markTranscriptionEntry(kit.repo, p.id, e0!.entryId, { status: "running", jobId: "again" })).toBe(false);
  });

  it("stop after 3 of 10 done empties the counters and the list stays running (R672)", async () => {
    const p = await makeProject(kit);
    const s: SourceFile[] = [];
    for (let i = 0; i < 10; i++) s.push(await audioSource(p, `Source ${i}`));
    await addToTranscriptionList(kit.repo, p.id, s.map((x) => ({ sourceId: x.source.id })));
    const pending = (await readTranscriptionList(kit.repo, p.id)).pending;
    for (const e of pending.slice(0, 3)) await markTranscriptionEntry(kit.repo, p.id, e.entryId, { status: "done" });
    await setTranscriptionListState(kit.repo, p.id, "paused");
    expect(await readTranscriptionList(kit.repo, p.id)).toMatchObject({ state: "paused", total: 10, done: 3, failed: 0 });
    await stopTranscriptionList(kit.repo, p.id);
    expect(await readTranscriptionList(kit.repo, p.id)).toEqual({ state: "running", total: 0, done: 0, failed: 0, pending: [] });
  });

  it("a journal an older build opened: the pending entries and the counters stay (R672)", async () => {
    const p = await makeProject(kit, OPEN_GOV, true);
    const key = projectDataKey(kit.repo, p.id);
    const folder = kit.repo.getProject(p.id).folder;
    const s = [await audioSource(p, "Alpha"), await audioSource(p, "Beta"), await audioSource(p, "Gamma"), await audioSource(p, "Delta")];
    await addToTranscriptionList(kit.repo, p.id, s.map((x) => ({ sourceId: x.source.id })));
    const [e0, e1, e2, e3] = (await readTranscriptionList(kit.repo, p.id)).pending;
    await markTranscriptionEntry(kit.repo, p.id, e0!.entryId, { status: "done" });
    await markTranscriptionEntry(kit.repo, p.id, e1!.entryId, { status: "failed", error: "WORKER_FAILED" });
    await markTranscriptionEntry(kit.repo, p.id, e2!.entryId, { status: "running", jobId: "job-2" });
    await setTranscriptionListState(kit.repo, p.id, "paused");
    await olderBuildOpens(kit.lib.root, folder, p.id, key);
    const raw = (await readJobJournal(kit.lib.root, folder, p.id, key)).records;
    expect([TRANSCRIPTION_LIST_ID, e2!.entryId, e3!.entryId].map((id) => [raw.get(id)!.status, raw.get(id)!.error])).toEqual([
      ["failed", "UNRECOVERABLE"], ["failed", "UNRECOVERABLE"], ["failed", "UNRECOVERABLE"],
    ]);
    // 600 newer failed worker jobs: the claimed entries would be beyond the cap of kept failed records.
    const at = Date.now();
    await appendJobRecords(kit.lib.root, folder, key, Array.from({ length: 600 }, (_, i): JobRecord => {
      const t = new Date(at + (i + 1) * 1000).toISOString();
      return { v: 1, id: `ocr-${i}`, projectId: p.id, kind: "pdf.ocr", status: "failed", error: "WORKER_FAILED", createdAt: t, updatedAt: t };
    }));
    expect(await compactJobJournal(kit.lib.root, folder, p.id, key, 0)).toBe(true);

    const list = await readTranscriptionList(kit.repo, p.id);
    expect(list).toMatchObject({ state: "paused", total: 4, done: 1, failed: 1 });
    expect(list.pending.map((e) => [e.entryId, e.status, e.entry.sourceId])).toEqual([
      [e2!.entryId, "queued", s[2]!.source.id],
      [e3!.entryId, "queued", s[3]!.source.id],
    ]);
    // The list carries on from there.
    expect(await markTranscriptionEntry(kit.repo, p.id, e2!.entryId, { status: "running", jobId: "job-2b" })).toBe(true);
    await markTranscriptionEntry(kit.repo, p.id, e2!.entryId, { status: "done" });
    expect(await readTranscriptionList(kit.repo, p.id)).toMatchObject({ state: "paused", total: 4, done: 2, failed: 1, pending: [{ entryId: e3!.entryId }] });
  });

  it("a running entry goes back to waiting, its job forgotten; a paused list says what it waits for (R692)", async () => {
    const p = await makeProject(kit);
    const s = [await audioSource(p, "Alpha"), await audioSource(p, "Beta")];
    await addToTranscriptionList(kit.repo, p.id, s.map((x) => ({ sourceId: x.source.id })));
    const [e0, e1] = (await readTranscriptionList(kit.repo, p.id)).pending;
    await markTranscriptionEntry(kit.repo, p.id, e0!.entryId, { status: "running", jobId: "job-0" });
    expect(await markTranscriptionEntry(kit.repo, p.id, e0!.entryId, { status: "queued" })).toBe(true);
    let list = await readTranscriptionList(kit.repo, p.id);
    expect(list.pending.map((e) => [e.entryId, e.status, e.entry.jobId])).toEqual([[e0!.entryId, "queued", undefined], [e1!.entryId, "queued", undefined]]);
    expect(list).toMatchObject({ total: 2, done: 0, failed: 0 });
    expect(list.tool).toBeUndefined();

    await setTranscriptionListState(kit.repo, p.id, "paused", { tool: "speech-medium" });
    list = await readTranscriptionList(kit.repo, p.id);
    expect(list).toMatchObject({ state: "paused", tool: "speech-medium" });
    expect(list.stalled).toBeUndefined();
    // Running again clears it.
    await setTranscriptionListState(kit.repo, p.id, "running");
    list = await readTranscriptionList(kit.repo, p.id);
    expect(list.state).toBe("running");
    expect(list.tool).toBeUndefined();
    await setTranscriptionListState(kit.repo, p.id, "paused", { stalled: true });
    list = await readTranscriptionList(kit.repo, p.id);
    expect(list).toMatchObject({ state: "paused", stalled: true });
    expect(list.tool).toBeUndefined();
    // A plain Pause says nothing more; a Stop clears it too.
    await setTranscriptionListState(kit.repo, p.id, "paused");
    expect((await readTranscriptionList(kit.repo, p.id)).stalled).toBeUndefined();
    await setTranscriptionListState(kit.repo, p.id, "paused", { tool: "speech-small" });
    await stopTranscriptionList(kit.repo, p.id);
    expect(await readTranscriptionList(kit.repo, p.id)).toEqual({ state: "running", total: 0, done: 0, failed: 0, pending: [] });
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
