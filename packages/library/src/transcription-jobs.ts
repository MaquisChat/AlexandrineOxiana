/**
 * Transcription of a source as a worker job (Task 62, R99, R142).
 *
 * - `transcriptionJob` builds the job for a source's recording: its id is the caller's (the job's
 *   id in the project's job journal, by which the service and the interface follow it), it records
 *   what it is about (`about.sourceId`, `about.model`), and its `finish` step stores the transcript
 *   (the WebVTT and segments.json, derived assets of kind `transcript`, each a governed, audited
 *   change, R26) before the job is recorded done. The worker writes into the job's own private
 *   temp folder (`.tmp/worker-<id>/`, removed by the worker client when the job ends).
 * - `transcriptionRerun` gives a pending transcription that is run again (at launch, at an unlock)
 *   the same finish step, and its input and output worked out again from the library as it is
 *   now (the recording by its asset id; after a move the old absolute paths would be wrong).
 * - `transcriptionRecords` reads a project's journal for its transcription jobs, newest last.
 */
import { join } from "node:path";
import type { Asset, SourceFile } from "@ao/core";
import { DEFAULT_SPEECH_MODEL } from "@ao/shared";
import { NoMediaError } from "./capture/link-capture.js";
import { readJobJournal, type JobRecord } from "./job-journal.js";
import { NotFoundError } from "./repo/errors.js";
import { authorizeProcessing, projectDataKey, repoLibrary, type Repo } from "./repo/repo.js";
import { storeTranscript, type StoredTranscript, type TranscriptionParams } from "./transcript-store.js";
import type { ResumeExtras, WorkerJob } from "./worker-client.js";

export type { StoredTranscript, TranscriptionParams } from "./transcript-store.js";

export const TRANSCRIBE_KIND = "audio.transcribe" as const;

/** The recording a source is transcribed from: its first video or audio original still stored. */
export function recordingOf(sf: SourceFile): Asset | undefined {
  return sf.assets.find((a) => a.role === "original" && a.status !== "destroyed" && (a.kind === "video" || a.kind === "audio"));
}

/** The worker parameters of a transcription: the shared default model (R158) when none is named, never the worker's own. */
function workerParams(params: TranscriptionParams): Record<string, unknown> {
  return { model: params.model ?? DEFAULT_SPEECH_MODEL, ...(params.language && params.language !== "auto" ? { language: params.language } : {}) };
}

/** Where a transcription job's worker output goes: inside the job's own temp folder. */
const outputFor = (repo: Repo, id: string) => join(repoLibrary(repo).root, ".tmp", `worker-${id}`, "transcript");

/**
 * The job that transcribes source `sourceId`'s recording (NoMediaError when it has none). Submit
 * it with WorkerClient.submit; `onStored` is told what was stored, before the job is recorded done.
 */
export async function transcriptionJob(
  repo: Repo,
  projectId: string,
  sourceId: string,
  params: TranscriptionParams,
  opts: { id: string; triggeredBy?: string; onStored?: (s: StoredTranscript) => void },
): Promise<WorkerJob & { id: string }> {
  const sf = await repo.getSource(projectId, sourceId);
  const media = recordingOf(sf);
  if (!media) throw new NoMediaError(sourceId);
  // Refused at the start (fix 1, I1): the same decision the run makes, so a forbidden transcription
  // is never recorded as a job. A deny is audited and thrown (PolicyDeniedError); an allow is not
  // audited here (the run audits its own decision). Checked again when the job runs.
  await authorizeProcessing(repo, projectId, { action: "process", process: { op: "transcription", provider: "local" } }, { op: `worker.${TRANSCRIBE_KIND}`, entity: { type: "asset", id: media.id } });
  const p = workerParams(params);
  const triggeredBy = opts.triggeredBy ?? "user";
  return {
    id: opts.id,
    type: TRANSCRIBE_KIND,
    input: join(repoLibrary(repo).root, ...media.path.split("/")),
    inputEncrypted: media.encrypted,
    output: outputFor(repo, opts.id),
    params: p,
    entity: { type: "asset", id: media.id },
    about: { sourceId, model: String(p.model) },
    finish: async (r) => {
      const stored = await storeTranscript(repo, projectId, sourceId, media, r, params, triggeredBy);
      opts.onStored?.(stored);
    },
  };
}

/**
 * For a pending transcription run again: its input and output worked out from the library as it
 * is now, and the finish step that stores its transcript. Undefined for a record that is not a
 * transcription of a known source (the client then reruns it as recorded).
 */
export async function transcriptionRerun(repo: Repo, rec: JobRecord, onStored?: (s: StoredTranscript) => void): Promise<ResumeExtras | undefined> {
  if (rec.kind !== TRANSCRIBE_KIND || !rec.about?.sourceId || !rec.job) return undefined;
  const sourceId = rec.about.sourceId;
  // Only a source that is really gone ends the rerun (the caller cancels it); any other failure to
  // read it is thrown, and the record stays pending for the next resubmission (M12).
  const sf = await repo.getSource(rec.projectId, sourceId).catch((err: unknown) => {
    if (err instanceof NotFoundError) return undefined;
    throw err;
  });
  const mediaId = rec.job.entity?.type === "asset" ? rec.job.entity.id : undefined;
  const media = sf?.assets.find((a) => a.id === mediaId && a.status !== "destroyed") ?? (sf ? recordingOf(sf) : undefined);
  if (!sf || !media) return undefined;
  const params: TranscriptionParams = {
    ...(typeof rec.job.params.model === "string" ? { model: rec.job.params.model } : {}),
    ...(typeof rec.job.params.language === "string" ? { language: rec.job.params.language } : {}),
  };
  return {
    input: join(repoLibrary(repo).root, ...media.path.split("/")),
    inputEncrypted: media.encrypted,
    output: outputFor(repo, rec.id),
    finish: async (r) => {
      const stored = await storeTranscript(repo, rec.projectId, sourceId, media, r, params, "user");
      onStored?.(stored);
    },
  };
}

/** The transcription jobs of a project (of one source when given), newest last (ProjectLockedError while locked). */
export async function transcriptionRecords(repo: Repo, projectId: string, sourceId?: string): Promise<JobRecord[]> {
  const key = projectDataKey(repo, projectId);
  const journal = await readJobJournal(repoLibrary(repo).root, repo.getProject(projectId).folder, projectId, key);
  return [...journal.records.values()]
    .filter((r) => r.kind === TRANSCRIBE_KIND && r.about?.sourceId !== undefined && (sourceId === undefined || r.about.sourceId === sourceId))
    .sort((a, b) => (a.updatedAt === b.updatedAt ? 0 : a.updatedAt < b.updatedAt ? -1 : 1));
}
