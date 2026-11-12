/**
 * The media worker as the apps use it (CLI, local service): started from `AO_WORKER_BIN` or the venv
 * made by `pnpm setup:py`, with a WorkerClient bound to the open library, the tools' versions and
 * the yt-dlp update. Moved here from the CLI (Task 30) so both apps share it.
 */
import type { IndexHandle } from "./index/db.js";
import type { Repo } from "./repo/repo.js";
import { WorkerClient, WorkerToolsClient, WorkerUnavailableError, startWorker, type WorkerHandle } from "./worker-client.js";

export interface ToolsUpdate {
  ytDlp: { old: string | null; new: string | null; managed: boolean };
  galleryDl: { version: string | null; pinned: boolean };
}

export interface MediaWorker {
  handle: WorkerHandle;
  /** A client bound to the library given at start (throws when none was given). */
  readonly client: WorkerClient;
  /** `GET /health`: the tools' versions. */
  versions(): Promise<Record<string, string | null>>;
  /** `POST /tools/update` (yt-dlp). A failure is a WorkerJobError with the worker's code (WorkerToolError naming the tool). */
  updateTools(): Promise<ToolsUpdate>;
  /** The optional tools (Task 48a): catalogue, install / update / remove as worker jobs. */
  readonly tools: WorkerToolsClient;
  stop(): Promise<void>;
}

async function call<T>(handle: WorkerHandle, method: "GET" | "POST", path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(handle.baseUrl + path, { method, headers: { Authorization: `Bearer ${handle.token}` }, ...(method === "POST" ? { body: "{}" } : {}) });
  } catch (err) {
    throw new WorkerUnavailableError(`the media worker is not reachable (${err instanceof Error ? err.message : String(err)})`);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & Record<string, unknown>;
  if (!res.ok) throw new Error(json.error?.message ?? `The media helper answered ${res.status}.`);
  return json as T;
}

/** Starts the media worker (`AO_WORKER_BIN`, or the venv made by `pnpm setup:py`). */
export async function startMediaWorker(opts: { repo?: Repo | undefined; index?: IndexHandle | undefined; onLog?: (line: string) => void; pollMs?: number } = {}): Promise<MediaWorker> {
  let handle: WorkerHandle;
  try {
    handle = await startWorker({ ...(opts.onLog ? { onLog: opts.onLog } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WorkerUnavailableError(/venv not found|ENOENT/.test(message) ? "The media helper is not set up yet. Run `pnpm setup:py` once, then try again." : `The media helper could not be started (${message}).`);
  }
  const { repo, index } = opts;
  let client: WorkerClient | undefined;
  const tools = new WorkerToolsClient(handle, { pollMs: opts.pollMs ?? 200 });
  return {
    handle,
    get client() {
      if (!repo) throw new Error("this worker was started without a library");
      client ??= new WorkerClient({ repo, worker: handle, pollMs: opts.pollMs ?? 200, ...(index ? { index } : {}) });
      return client;
    },
    versions: async () => (await call<{ versions: Record<string, string | null> }>(handle, "GET", "/health")).versions,
    updateTools: () => tools.updateCaptureTools<ToolsUpdate>(),
    tools,
    stop: () => handle.stop(),
  };
}
