/**
 * Task 62: transcription of a source as a worker job — stored before it is recorded done, run again
 * with its finish step when it was left pending, and found again in the project's job journal.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@ao/core";
import { OPEN_GOV, addSource, auditEvents, makeKit, makeProject, scratchFile, type Kit } from "./export/test-kit.js";
import { PolicyDeniedError } from "./repo/errors.js";
import { NoMediaError } from "./capture/link-capture.js";
import { transcriptVersions } from "./source-actions.js";
import { parseVtt, readTranscript } from "./transcript-segments.js";
import { transcriptionJob, transcriptionRecords, transcriptionRerun } from "./transcription-jobs.js";
import { JobInterruptedError, WorkerClient, WorkerUnavailableError } from "./worker-client.js";
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

  it("fix 1 I1: a transcription the rules forbid is refused when the job is built: audited once, nothing recorded", async () => {
    const p = await makeProject(kit, `${OPEN_GOV}processing:\n  transcription: []\n`);
    const sf = await audioSource(p);
    const before = (await auditEvents(kit, p)).length;
    await expect(transcriptionJob(kit.repo, p.id, sf.source.id, {}, { id: randomUUID() })).rejects.toBeInstanceOf(PolicyDeniedError);
    const events = (await auditEvents(kit, p)).slice(before);
    expect(events.filter((e) => e.decision?.result === "deny")).toHaveLength(1);
    expect(await transcriptionRecords(kit.repo, p.id, sf.source.id)).toEqual([]);
    // Allowed: no audit entry for the check itself (each run audits its own decision).
    const q = await makeProject(kit);
    const sq = await audioSource(q);
    const n = (await auditEvents(kit, q)).length;
    await transcriptionJob(kit.repo, q.id, sq.source.id, {}, { id: randomUUID() });
    expect((await auditEvents(kit, q)).length).toBe(n);
  });

  it("fix 1 M12: a rerun whose source cannot be read for another reason is left pending, not cancelled", async () => {
    const p = await makeProject(kit);
    const sf = await audioSource(p);
    const rec = {
      v: 1 as const, id: randomUUID(), projectId: p.id, kind: "audio.transcribe", status: "queued" as const,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), about: { sourceId: sf.source.id },
      job: { type: "audio.transcribe" as const, input: "x", output: "y", params: {}, entity: { type: "asset" as const, id: sf.assets[0]!.id } },
    };
    expect(await transcriptionRerun(kit.repo, { ...rec, about: { sourceId: randomUUID() } })).toBeUndefined(); // gone: cancelled by the caller
    const broken = { ...kit.repo, getSource: async () => { throw new Error("disk read failed"); } } as unknown as typeof kit.repo;
    await expect(transcriptionRerun(broken, rec)).rejects.toThrow(/disk read failed/);
  });

  for (const how of ["lock", "crash"] as const) {
    // FR-393 (R464 c): the two files are stored in one change, so there is no point between them any more; a
    // ${how} at the store leaves neither, and the rerun leaves exactly one version of each file.
    it(`F-1: a ${how} at the store, and a rerun whose words differ: one version of each file, every version's files from one run`, async () => {
      const p = await makeProject(kit, OPEN_GOV, true);
      const sf = await audioSource(p);
      const repo = kit.repo;
      let runs = 0;
      const differing = async (job: StubJob) => {
        const first = ++runs === 1;
        await mkdir(job.body.output, { recursive: true });
        const text = first ? "First try words." : "Rerun different words.";
        await writeFile(join(job.body.output, "segments.json"), JSON.stringify([{ start: 0, end: 2, text, lang: "en", flags: first ? ["outside-speech"] : [] }]));
        await writeFile(join(job.body.output, "transcript.vtt"), `WEBVTT\n\n${first ? "NOTE flags: outside-speech\n\n" : ""}00:00:00.000 --> 00:00:02.000\n${text}\n`);
        return { status: "done", result: { output: job.body.output, meta: { model: "small", detectedLanguages: ["en"], flaggedCount: first ? 1 : 0 } } };
      };
      const original = repo.addDerivedAssets.bind(repo);
      let calls = 0;
      repo.addDerivedAssets = (async (...args: Parameters<typeof original>) => {
        if (++calls === 1) {
          if (how === "lock") repo.lockProject(p.id);
          else throw new JobInterruptedError(); // the process stops here: the journal still says running
        }
        return original(...args);
      }) as typeof original;
      const job = await transcriptionJob(repo, p.id, sf.source.id, { model: "small" }, { id: randomUUID() });
      await expect((await client(differing)).submit(p.id, job)).rejects.toThrow();
      repo.addDerivedAssets = original;
      if (how === "lock") await repo.unlockProject(p.id, "correct horse battery staple");
      expect(transcriptVersions(await repo.getSource(p.id, sf.source.id))).toEqual([]); // neither file
      const out = await (await client(differing)).resumePending(p.id, { prepare: (rec) => transcriptionRerun(repo, rec) });
      expect(out.map((x) => x.error)).toEqual([undefined]);
      const versions = transcriptVersions(await repo.getSource(p.id, sf.source.id));
      const runsByTime = new Map<string, typeof versions>();
      for (const v of versions) runsByTime.set(v.derivation!.at, [...(runsByTime.get(v.derivation!.at) ?? []), v]);
      for (const files of runsByTime.values()) {
        const texts = new Set<string>();
        for (const f of files) {
          const t = await readTranscript(repo, p.id, sf.source.id, f.id);
          texts.add(t.segments.map((s) => s.text).join("|"));
          // The count the list shows is what the viewer shows for that file.
          expect(t.segments.filter((s) => s.flags && s.flags.length > 0).length).toBe(f.metadata?.flaggedSegments);
          // The stored WebVTT itself holds the same words as what is shown.
          if (f.mime === "text/vtt") expect(parseVtt(t.text).map((c) => c.text).join("|")).toBe(t.segments.map((s) => s.text).join("|"));
        }
        expect(texts.size).toBe(1); // never two runs' words in one version
      }
      // The rerun's complete pair is the one version: one WebVTT and one segments file.
      expect(versions.map((v) => v.mime).sort()).toEqual(["application/json", "text/vtt"]);
    });
  }

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

/**
 * R367 (FR-A8): an allowed transcription leaves one audit entry of its processing, written where the
 * run is authorised, before anything it stores; once per run of the job (a rerun after a restart,
 * an unlock or a crash continues the same run and adds none); a denial is audited as before.
 */
describe("R367: an allowed transcription is audited once, where it runs", () => {
  const isProcess = (e: { action: string }) => e.action === "process";
  /** A store of the job's output: a derived asset (not, say, the governance edit a test makes). */
  const isDerive = (e: { action: string; details?: Record<string, unknown> }) => e.action === "store" && e.details?.op === "asset.derive";
  const isStore = (e: { action: string; decision?: { result?: string }; details?: Record<string, unknown> }) => isDerive(e) && e.decision?.result !== "deny";
  /** The entries of the processing and of its storing, in order. */
  const ofJob = <E extends { action: string; details?: Record<string, unknown> }>(events: E[]) => events.filter((e) => isProcess(e) || isDerive(e));

  it("allowed and stored: one `process` allow entry naming the job, the recording and the tool, before the one `store` entry of both files (FR-393); the chain verifies", async () => {
    const p = await makeProject(kit);
    const sf = await audioSource(p);
    const before = (await auditEvents(kit, p)).length;
    const job = await transcriptionJob(kit.repo, p.id, sf.source.id, { model: "small" }, { id: randomUUID() });
    await (await client()).submit(p.id, job);
    const events = (await auditEvents(kit, p)).slice(before);
    const processed = events.filter(isProcess);
    expect(processed).toHaveLength(1);
    expect(processed[0]).toMatchObject({
      action: "process",
      entity: { type: "asset", id: sf.assets[0]!.id },
      decision: { result: "allow" },
      details: { op: "worker.audio.transcribe", process: { op: "transcription", provider: "local" } },
    });
    // Nothing of the content: no path, no parameter, no word of the transcript.
    expect(Object.keys(processed[0]!.details ?? {}).sort()).toEqual(["op", "process"]);
    expect(events.map((e) => e.action)).toEqual(["process", "store"]);
    expect(events.filter(isStore).every((e) => (e.details as { op?: string }).op === "asset.derive")).toBe(true);
    expect((await kit.repo.verifyAudit(p.id)).ok).toBe(true);
  });

  for (const how of ["lock", "crash"] as const) {
    it(`allowed, then a ${how} before the store: the \`process\` entry is there and no \`store\`; the rerun adds no second \`process\` entry`, async () => {
      const p = await makeProject(kit, OPEN_GOV, true);
      const sf = await audioSource(p);
      const repo = kit.repo;
      const before = (await auditEvents(kit, p)).length;
      const original = repo.addDerivedAssets.bind(repo);
      repo.addDerivedAssets = (async (...args: Parameters<typeof original>) => {
        if (how === "lock") repo.lockProject(p.id);
        else throw new JobInterruptedError(); // the process stops here: the journal still says running
        return original(...args);
      }) as typeof original;
      const job = await transcriptionJob(repo, p.id, sf.source.id, { model: "small" }, { id: randomUUID() });
      await expect((await client()).submit(p.id, job)).rejects.toThrow();
      repo.addDerivedAssets = original;
      if (how === "lock") await repo.unlockProject(p.id, "correct horse battery staple");
      let events = (await auditEvents(kit, p)).slice(before);
      expect(events.filter(isProcess)).toHaveLength(1);
      expect(events.filter(isDerive)).toEqual([]);
      const out = await (await client()).resumePending(p.id, { prepare: (rec) => transcriptionRerun(repo, rec) });
      expect(out.map((x) => x.error)).toEqual([undefined]);
      events = (await auditEvents(kit, p)).slice(before);
      expect(ofJob(events).map((e) => e.action)).toEqual(["process", "store"]);
      expect((await repo.verifyAudit(p.id)).ok).toBe(true);
    });
  }

  it("allowed, then refused at the store: the `process` entry is there, no allowed `store` entry", async () => {
    const gov = OPEN_GOV.replace("containsIdentifiable: false", "containsIdentifiable: false\n  pseudonymizeFileNames: false");
    const p = await makeProject(kit, gov);
    const audio = await scratchFile(kit, "talk.mp3", Buffer.alloc(64, 1));
    // An identifiable recording with no legal basis, accepted while the project does not ask for one.
    const sf = await kit.repo.createSource(
      p.id,
      {
        projectIds: [p.id], type: "audio" as never, title: { variants: [{ lang: "en", kind: "original", value: "Talk" }] }, creators: [], identifiers: {},
        caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [],
      },
      [{ path: audio, role: "original", handling: "copy" }],
      { provenance: { captureMethod: "manual_upload", capturedAt: kit.clock.now.toISOString(), tool: { name: "test", version: "1" }, fileHashes: {}, legal: { status: "consented" }, identifiable: true } },
    );
    const before = (await auditEvents(kit, p)).length;
    const job = await transcriptionJob(kit.repo, p.id, sf.source.id, {}, { id: randomUUID() });
    // While the worker runs, the project starts to require a legal basis: the store is refused.
    const c = await client(async (j) => {
      const cur = await kit.repo.getGovernance(p.id);
      await kit.repo.setGovernance(p.id, gov.replace("requireLegalBasis: false", "requireLegalBasis: true"), { baseSha256: cur.sha256 });
      return transcribe(j);
    });
    await expect(c.submit(p.id, job)).rejects.toBeInstanceOf(PolicyDeniedError);
    const events = ofJob((await auditEvents(kit, p)).slice(before));
    expect(events.filter(isProcess)).toEqual([expect.objectContaining({ decision: { result: "allow" }, entity: { type: "asset", id: sf.assets[0]!.id } })]);
    expect(events.filter(isStore)).toEqual([]);
    expect(events.map((e) => [e.action, e.decision?.result])).toEqual([["process", "allow"], ["store", "deny"]]);
    expect((await kit.repo.verifyAudit(p.id)).ok).toBe(true);
  });

  it("a rerun after a restart (the worker was unreachable): one `process` entry for the job, not one per resubmission", async () => {
    const p = await makeProject(kit, OPEN_GOV, true);
    const sf = await audioSource(p);
    const down = await stubWorker(() => ({ status: "done" }), { closers });
    await closers.pop()!();
    const before = (await auditEvents(kit, p)).length;
    const job = await transcriptionJob(kit.repo, p.id, sf.source.id, { model: "small" }, { id: randomUUID() });
    await expect(new WorkerClient({ repo: kit.repo, worker: down, pollMs: 5 }).submit(p.id, job)).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect((await auditEvents(kit, p)).slice(before).filter(isProcess)).toHaveLength(1);
    // Two resubmissions at the next launch: one of them runs it; neither audits it again.
    const [a, b] = await Promise.all([
      (await client()).resumePending(undefined, { prepare: (rec) => transcriptionRerun(kit.repo, rec) }),
      (await client()).resumePending(undefined, { prepare: (rec) => transcriptionRerun(kit.repo, rec) }),
    ]);
    expect([...a, ...b].filter((x) => x.error === undefined)).toHaveLength(1);
    const events = (await auditEvents(kit, p)).slice(before);
    expect(ofJob(events).map((e) => e.action)).toEqual(["process", "store"]);
  });

  it("denied: as before, one deny (at the start), no allow entry, no job", async () => {
    const p = await makeProject(kit, `${OPEN_GOV}processing:\n  transcription: []\n`);
    const sf = await audioSource(p);
    const before = (await auditEvents(kit, p)).length;
    await expect(transcriptionJob(kit.repo, p.id, sf.source.id, {}, { id: randomUUID() })).rejects.toBeInstanceOf(PolicyDeniedError);
    const events = (await auditEvents(kit, p)).slice(before);
    expect(events.map((e) => [e.action, e.decision?.result])).toEqual([["process", "deny"]]);
    expect(await transcriptionRecords(kit.repo, p.id, sf.source.id)).toEqual([]);
  });
});
