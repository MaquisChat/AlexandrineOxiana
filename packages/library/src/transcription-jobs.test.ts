/**
 * Task 62: transcription of a source as a worker job — stored before it is recorded done, run again
 * with its finish step when it was left pending, and found again in the project's job journal.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@ao/core";
import { OPEN_GOV, addSource, makeKit, makeProject, scratchFile, type Kit } from "./export/test-kit.js";
import { NoMediaError } from "./capture/link-capture.js";
import { transcriptVersions } from "./source-actions.js";
import { readTranscript } from "./transcript-segments.js";
import { transcriptionJob, transcriptionRecords, transcriptionRerun } from "./transcription-jobs.js";
import { WorkerClient, WorkerUnavailableError } from "./worker-client.js";
import { stubWorker, type StubJob } from "./worker-testing.js";

let kit: Kit;
const closers: Array<() => Promise<void> | void> = [];
beforeEach(async () => {
  kit = await makeKit("ao-transcription-jobs-");
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await kit.close();
});

/** The worker's transcription: a WebVTT and a segments file, one of two segments flagged. */
async function transcribe(job: StubJob) {
  await mkdir(job.body.output, { recursive: true });
  await writeFile(join(job.body.output, "segments.json"), JSON.stringify([
    { start: 0, end: 2, text: "Welcome.", lang: "en", flags: [] },
    { start: 2, end: 4, text: "Thanks for watching!", lang: "en", flags: ["outside-speech"] },
  ]));
  await writeFile(join(job.body.output, "transcript.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nWelcome.\n\nNOTE flags: outside-speech\n\n00:00:02.000 --> 00:00:04.000\nThanks for watching!\n");
  return { status: "done", result: { output: job.body.output, meta: { model: job.body.params.model, detectedLanguages: ["en"], flaggedCount: 1 } } };
}

async function audioSource(p: Project) {
  const audio = await scratchFile(kit, "talk.mp3", Buffer.alloc(64, 1));
  return addSource(kit, p, { type: "audio" as never, title: "Talk", files: [{ path: audio, role: "original", handling: "copy" }] });
}

const client = async (onSubmit = transcribe) => new WorkerClient({ repo: kit.repo, worker: await stubWorker(onSubmit, { closers }), pollMs: 5 });

describe("transcription as a job", () => {
  it("stores the transcript before the job is recorded done; the record names the source and the model", async () => {
    const p = await makeProject(kit);
    const sf = await audioSource(p);
    const id = randomUUID();
    let stored: unknown;
    const c = await client(async (job) => {
      expect(job.body.params).toEqual({ model: "small", language: "pt" });
      return transcribe(job);
    });
    const job = await transcriptionJob(kit.repo, p.id, sf.source.id, { model: "small", language: "pt" }, { id, onStored: (s) => (stored = s) });
    const r = await c.submit(p.id, job);
    expect(r.id).toBe(id);
    const versions = transcriptVersions(await kit.repo.getSource(p.id, sf.source.id));
    expect(versions.map((v) => v.mime).sort()).toEqual(["application/json", "text/vtt"]);
    expect(stored).toEqual({ files: versions.map((v) => v.path), flaggedSegments: 1 });
    const t = await readTranscript(kit.repo, p.id, sf.source.id, versions[0]!.id);
    expect(t.segments.map((s) => s.flags)).toEqual([[], ["outside-speech"]]);
    const recs = await transcriptionRecords(kit.repo, p.id, sf.source.id);
    expect(recs.map((x) => [x.id, x.status, x.about])).toEqual([[id, "done", { sourceId: sf.source.id, model: "small" }]]);
    expect(await transcriptionRecords(kit.repo, p.id, randomUUID())).toEqual([]);
  });

  it("the default model is the app's (R158); a source without a recording is refused before anything is recorded", async () => {
    const p = await makeProject(kit);
    const sf = await audioSource(p);
    const job = await transcriptionJob(kit.repo, p.id, sf.source.id, {}, { id: randomUUID() });
    expect(job.params).toEqual({ model: "medium" });
    const paper = await addSource(kit, p, { title: "Paper" });
    await expect(transcriptionJob(kit.repo, p.id, paper.source.id, {}, { id: randomUUID() })).rejects.toBeInstanceOf(NoMediaError);
  });

  it("a transcription left pending is run again with its finish step: the transcript is stored once", async () => {
    const p = await makeProject(kit, OPEN_GOV, true);
    const sf = await audioSource(p);
    const down = await stubWorker(() => ({ status: "done" }), { closers });
    await closers.pop()!();
    const id = randomUUID();
    const job = await transcriptionJob(kit.repo, p.id, sf.source.id, { model: "small" }, { id });
    await expect(new WorkerClient({ repo: kit.repo, worker: down, pollMs: 5 }).submit(p.id, job)).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(transcriptVersions(await kit.repo.getSource(p.id, sf.source.id))).toEqual([]);
    const c = await client();
    let stored = 0;
    const out = await c.resumePending(undefined, { prepare: (rec) => transcriptionRerun(kit.repo, rec, () => stored++) });
    expect(out.map((x) => [x.id, x.error])).toEqual([[id, undefined]]);
    expect(stored).toBe(1);
    const versions = transcriptVersions(await kit.repo.getSource(p.id, sf.source.id));
    expect(versions).toHaveLength(2);
    expect(versions.every((v) => v.encrypted)).toBe(true);
    expect((await transcriptionRecords(kit.repo, p.id, sf.source.id)).map((x) => x.status)).toEqual(["done"]);
    expect(await c.resumePending(undefined, { prepare: (rec) => transcriptionRerun(kit.repo, rec) })).toEqual([]);
  });

  it("a rerun reads the recording from the library as it is now, not from the path recorded", async () => {
    const p = await makeProject(kit);
    const sf = await audioSource(p);
    const rec = {
      v: 1 as const,
      id: randomUUID(),
      projectId: p.id,
      kind: "audio.transcribe",
      status: "queued" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      about: { sourceId: sf.source.id, model: "small" },
      job: { type: "audio.transcribe" as const, input: "/old/library/place/talk.mp3", output: "/old/library/place/.tmp/out", params: { model: "small" }, entity: { type: "asset" as const, id: sf.assets[0]!.id } },
    };
    const extras = await transcriptionRerun(kit.repo, rec);
    expect(extras?.input).toBe(join(kit.lib.root, ...sf.assets[0]!.path.split("/")));
    expect(extras?.output).toBe(join(kit.lib.root, ".tmp", `worker-${rec.id}`, "transcript"));
    expect(await transcriptionRerun(kit.repo, { ...rec, kind: "image.proxy" })).toBeUndefined();
  });
});
