import { startMediaWorker, type IndexHandle, type MediaWorker, type Repo } from "@ao/library";

export type { ToolsUpdate } from "@ao/library";
export type CaptureWorker = MediaWorker;

/** Starts the media worker (`AO_WORKER_BIN`, or the venv made by `pnpm setup:py`); AO_DEBUG shows its log on stderr. */
export function startCaptureWorker(opts: { repo?: Repo | undefined; index?: IndexHandle | undefined } = {}): Promise<CaptureWorker> {
  return startMediaWorker({ ...opts, ...(process.env.AO_DEBUG ? { onLog: (l: string) => process.stderr.write(`[worker] ${l}\n`) } : {}) });
}
