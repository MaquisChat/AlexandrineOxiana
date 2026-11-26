/**
 * "Transcribe everything without a transcript" (whole channels, Task 7): the sources of a project that have a
 * recording (`recordingOf`), no transcript (a derived `transcript` asset that is not destroyed: the rule
 * `transcriptVersions` uses), and are neither pending on the transcription list nor waiting for a transcription job
 * (queued, running, or cancelled by a lock and so run again at the unlock, R142). A job started by a single-link
 * capture or a link queue names no source (no `about`): it is matched by the recording it transcribes, its entity or
 * its input asset (R692). Read only; ProjectLockedError while the project is locked.
 */
import { primary } from "@ao/core";
import { readJobJournal } from "./job-journal.js";
import { readTranscriptionList, soundSecondsOf } from "./lists/transcription-list.js";
import { NotFoundError } from "./repo/errors.js";
import { projectDataKey, repoLibrary, type Repo } from "./repo/repo.js";
import { transcriptVersions } from "./source-actions.js";
import { TRANSCRIBE_KIND, recordingOf } from "./transcription-jobs.js";

/** The sources, and the assets, that a pending transcription job of the project names. */
async function pendingTranscriptions(repo: Repo, projectId: string): Promise<{ sources: Set<string>; assets: Set<string> }> {
  const journal = await readJobJournal(repoLibrary(repo).root, repo.getProject(projectId).folder, projectId, projectDataKey(repo, projectId));
  const sources = new Set<string>();
  const assets = new Set<string>();
  for (const r of journal.records.values()) {
    if (r.kind !== TRANSCRIBE_KIND) continue;
    if (!(r.status === "queued" || r.status === "running" || (r.status === "cancelled" && r.error === "PROJECT_LOCKED"))) continue;
    if (r.about?.sourceId !== undefined) sources.add(r.about.sourceId);
    if (r.job?.entity?.type === "asset") assets.add(r.job.entity.id);
    if (r.job?.inputAsset) assets.add(r.job.inputAsset.assetId);
  }
  return { sources, assets };
}

export async function untranscribedSources(repo: Repo, projectId: string): Promise<Array<{ sourceId: string; title?: string; soundSec?: number }>> {
  const listed = new Set((await readTranscriptionList(repo, projectId)).pending.map((e) => e.entry.sourceId));
  const waiting = await pendingTranscriptions(repo, projectId);
  const out: Array<{ sourceId: string; title?: string; soundSec?: number }> = [];
  for (const sourceId of repo.listSourceIds(projectId)) {
    if (listed.has(sourceId) || waiting.sources.has(sourceId)) continue;
    const sf = await repo.getSource(projectId, sourceId).catch((err: unknown) => {
      if (err instanceof NotFoundError) return undefined; // gone meanwhile
      throw err;
    });
    if (!sf || !recordingOf(sf)) continue;
    if (sf.assets.some((a) => waiting.assets.has(a.id))) continue;
    if (transcriptVersions(sf).length > 0) continue;
    const title = primary(sf.source.title);
    const soundSec = soundSecondsOf(sf);
    out.push({ sourceId, ...(title ? { title } : {}), ...(soundSec !== undefined ? { soundSec } : {}) });
  }
  return out;
}
