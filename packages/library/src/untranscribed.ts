/**
 * "Transcribe everything without a transcript" (whole channels, Task 7): the sources of a project that have a
 * recording (`recordingOf`), no transcript (a derived `transcript` asset that is not destroyed), and are neither
 * pending on the transcription list nor waiting for a transcription job (queued, running, or cancelled by a lock and
 * so run again at the unlock, R142). Read only; ProjectLockedError while the project is locked.
 */
import { primary } from "@ao/core";
import { readTranscriptionList, soundSecondsOf } from "./lists/transcription-list.js";
import { NotFoundError } from "./repo/errors.js";
import type { Repo } from "./repo/repo.js";
import { recordingOf, transcriptionRecords } from "./transcription-jobs.js";

export async function untranscribedSources(repo: Repo, projectId: string): Promise<Array<{ sourceId: string; title?: string; soundSec?: number }>> {
  const listed = new Set((await readTranscriptionList(repo, projectId)).pending.map((e) => e.entry.sourceId));
  const waiting = new Set(
    (await transcriptionRecords(repo, projectId))
      .filter((r) => r.status === "queued" || r.status === "running" || (r.status === "cancelled" && r.error === "PROJECT_LOCKED"))
      .map((r) => r.about!.sourceId!),
  );
  const out: Array<{ sourceId: string; title?: string; soundSec?: number }> = [];
  for (const sourceId of repo.listSourceIds(projectId)) {
    if (listed.has(sourceId) || waiting.has(sourceId)) continue;
    const sf = await repo.getSource(projectId, sourceId).catch((err: unknown) => {
      if (err instanceof NotFoundError) return undefined; // gone meanwhile
      throw err;
    });
    if (!sf || !recordingOf(sf)) continue;
    if (sf.assets.some((a) => a.kind === "transcript" && a.status !== "destroyed")) continue;
    const title = primary(sf.source.title);
    const soundSec = soundSecondsOf(sf);
    out.push({ sourceId, ...(title ? { title } : {}), ...(soundSec !== undefined ? { soundSec } : {}) });
  }
  return out;
}
