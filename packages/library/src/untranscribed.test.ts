/**
 * Whole channels (Task 7): "Transcribe everything without a transcript" — the sources of a project that have a
 * recording and no transcript, and are neither on the transcription list nor waiting for a transcription job.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project, SourceDraft, SourceFile } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSource, makeKit, makeProject, scratchFile, type Kit } from "./export/test-kit.js";
import { appendJobRecords, type JobRecord } from "./job-journal.js";
import { addToTranscriptionList } from "./lists/transcription-list.js";
import { projectDataKey } from "./repo/repo.js";
import { untranscribedSources } from "./untranscribed.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-untranscribed-");
});
afterEach(async () => {
  await kit.close();
});

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

async function transcribed(p: Project, sf: SourceFile): Promise<void> {
  const dir = join(kit.tmp, "out", sf.source.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "transcript.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello.\n");
  const derivation = { parents: [sf.assets[0]!.id], operation: "transcribe", provider: "faster-whisper", model: "small", ranAt: "local", params: { model: "small" }, at: kit.clock.now.toISOString(), triggeredBy: "user" };
  await kit.repo.addDerivedAsset(p.id, sf.source.id, { fromPath: join(dir, "transcript.vtt"), kind: "transcript", lang: "en", tool: "whisper-small", ext: "vtt", metadata: {}, derivation });
}

/** A transcription job of the source, as the worker client records one, in the given state. */
async function job(p: Project, sourceId: string, status: JobRecord["status"], error?: string): Promise<void> {
  const at = kit.clock.now.toISOString();
  const rec: JobRecord = {
    v: 1, id: `job-${sourceId}`, projectId: p.id, kind: "audio.transcribe", status, createdAt: at, updatedAt: at,
    about: { sourceId, model: "small" }, ...(error ? { error } : {}),
  };
  await appendJobRecords(kit.lib.root, kit.repo.getProject(p.id).folder, projectDataKey(kit.repo, p.id), [rec]);
}

describe("untranscribedSources", () => {
  it("untranscribedSources leaves out sources with a transcript, on the list, or pending", async () => {
    const p = await makeProject(kit);
    const plain = await audioSource(p, "Plain", 90);
    const unknown = await audioSource(p, "Unknown");
    const withTranscript = await audioSource(p, "Done");
    await transcribed(p, withTranscript);
    const onList = await audioSource(p, "Listed");
    await addToTranscriptionList(kit.repo, p.id, [{ sourceId: onList.source.id }]);
    const queuedJob = await audioSource(p, "Queued");
    await job(p, queuedJob.source.id, "queued");
    const lockedJob = await audioSource(p, "Locked");
    await job(p, lockedJob.source.id, "cancelled", "PROJECT_LOCKED"); // runs again at the unlock (R142)
    const failedJob = await audioSource(p, "Failed");
    await job(p, failedJob.source.id, "failed", "FAILED"); // ended: it can be transcribed again
    await addSource(kit, p, { title: "A paper" }); // no recording
    const gone = await audioSource(p, "Gone");
    await kit.repo.deleteSource(p.id, gone.source.id);

    const got = await untranscribedSources(kit.repo, p.id);
    expect(got.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""))).toEqual([
      { sourceId: failedJob.source.id, title: "Failed" },
      { sourceId: plain.source.id, title: "Plain", soundSec: 90 },
      { sourceId: unknown.source.id, title: "Unknown" },
    ]);
  });

  it("a source a link capture is transcribing right now is left out (its job names the recording, not the source) (R692)", async () => {
    const p = await makeProject(kit);
    const capturing = await audioSource(p, "Capturing", 60);
    const ended = await audioSource(p, "Ended", 60);
    const at = kit.clock.now.toISOString();
    const linkJob = (id: string, assetId: string, status: JobRecord["status"], linked = false): JobRecord => ({
      v: 1, id, projectId: p.id, kind: "audio.transcribe", status, createdAt: at, updatedAt: at,
      // As link-capture's runTranscription submits it: no `about`, the recording as the job's entity.
      ...(status === "queued" || status === "running"
        ? { job: { type: "audio.transcribe", input: linked ? "" : "x.mp3", ...(linked ? { inputAsset: { sourceId: "", assetId } } : {}), output: "out", params: { model: "medium" }, ...(linked ? {} : { entity: { type: "asset" as const, id: assetId } }) } }
        : {}),
    });
    await appendJobRecords(kit.lib.root, kit.repo.getProject(p.id).folder, projectDataKey(kit.repo, p.id), [
      linkJob("link-1", capturing.assets[0]!.id, "running"),
      linkJob("link-2", ended.assets[0]!.id, "done"),
    ]);
    expect((await untranscribedSources(kit.repo, p.id)).map((x) => x.title)).toEqual(["Ended"]);
    // "Transcribe everything" puts nothing on the list for it.
    const listed = await untranscribedSources(kit.repo, p.id);
    expect(await addToTranscriptionList(kit.repo, p.id, listed.map((x) => ({ sourceId: x.sourceId })))).toEqual({ added: 1 });
    // A file linked in place is named by its input asset.
    const linked = await audioSource(p, "Linked", 60);
    await appendJobRecords(kit.lib.root, kit.repo.getProject(p.id).folder, projectDataKey(kit.repo, p.id), [linkJob("link-3", linked.assets[0]!.id, "queued", true)]);
    expect(await untranscribedSources(kit.repo, p.id)).toEqual([]);
  });

  it("only a derived transcript that is not destroyed counts, and a running job leaves the source out (R692)", async () => {
    const p = await makeProject(kit);
    const original = await audioSource(p, "Original transcript", 60);
    const destroyed = await audioSource(p, "Destroyed transcript", 60);
    await transcribed(p, destroyed);
    const running = await audioSource(p, "Running", 60);
    await job(p, running.source.id, "running");
    const real = kit.repo.getSource.bind(kit.repo);
    vi.spyOn(kit.repo, "getSource").mockImplementation(async (pid, sid) => {
      const sf = await real(pid, sid);
      if (sid === original.source.id) {
        // A transcript file the researcher brought in as an original (not one the app derived).
        return { ...sf, assets: [...sf.assets, { ...sf.assets[0]!, id: "original-vtt", kind: "transcript", role: "original" }] };
      }
      if (sid === destroyed.source.id) return { ...sf, assets: sf.assets.map((a) => (a.kind === "transcript" ? { ...a, status: "destroyed" as const } : a)) };
      return sf;
    });
    expect((await untranscribedSources(kit.repo, p.id)).map((x) => x.title).sort()).toEqual(["Destroyed transcript", "Original transcript"]);
  });
});
