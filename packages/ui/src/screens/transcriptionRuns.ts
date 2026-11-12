/**
 * Re-transcription runs started in this session, per project and source (R143).
 *
 * The service's transcribe route answers only when the run is finished (Task 62 will make it a job
 * with progress). So the run outlives the screen that started it: its state lives here, for the
 * whole session, and a viewer opened again for the same source shows it — still running, finished,
 * failed, or with an outcome the UI cannot know (the connection was lost while it ran). While a run
 * is running or unknown, Re-transcribe stays off for that source, so the same recording is not
 * transcribed twice.
 */
import type { TranscribeResult } from "../api/transcripts";

export type TranscriptionRun =
  | { state: "running"; model: string; startedAt: string }
  /** The connection was lost after the request was sent: the run may still be going. */
  | { state: "unknown"; model: string; startedAt: string }
  | { state: "finished"; model: string; startedAt: string; result: TranscribeResult }
  | { state: "failed"; model: string; startedAt: string; error: unknown };

const runs = new Map<string, TranscriptionRun>();
const listeners = new Set<() => void>();

export const runKey = (projectId: string, sourceId: string): string => `${projectId}\u0000${sourceId}`;

export function transcriptionRun(key: string): TranscriptionRun | undefined {
  return runs.get(key);
}

export function setTranscriptionRun(key: string, run: TranscriptionRun | undefined): void {
  if (run) runs.set(key, run);
  else runs.delete(key);
  for (const fn of [...listeners]) fn();
}

export function subscribeTranscriptionRuns(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Tests only: forget every run. */
export function resetTranscriptionRuns(): void {
  runs.clear();
}
