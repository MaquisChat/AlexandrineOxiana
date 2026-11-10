import { WorkerClient, WorkerUnavailableError, startWorker, type IndexHandle, type Repo, type WorkerHandle } from "@ao/library";

export interface CaptureWorker {
  handle: WorkerHandle;
  client: WorkerClient;
  /** `GET /health`: the tools' versions. */
  versions(): Promise<Record<string, string | null>>;
  /** `POST /tools/update` (yt-dlp). */
  updateTools(): Promise<ToolsUpdate>;
  stop(): Promise<void>;
}

export interface ToolsUpdate {
  ytDlp: { old: string | null; new: string | null; managed: boolean };
  galleryDl: { version: string | null; pinned: boolean };
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
export async function startCaptureWorker(opts: { repo?: Repo | undefined; index?: IndexHandle | undefined } = {}): Promise<CaptureWorker> {
  let handle: WorkerHandle;
  try {
    handle = await startWorker({ ...(process.env.AO_DEBUG ? { onLog: (l: string) => process.stderr.write(`[worker] ${l}\n`) } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WorkerUnavailableError(/venv not found|ENOENT/.test(message) ? "The media helper is not set up yet. Run `pnpm setup:py` once, then try again." : `The media helper could not be started (${message}).`);
  }
  const { repo, index } = opts;
  let client: WorkerClient | undefined;
  return {
    handle,
    get client() {
      if (!repo) throw new Error("this worker was started without a library");
      client ??= new WorkerClient({ repo, worker: handle, pollMs: 200, ...(index ? { index: { db: index.db } } : {}) });
      return client;
    },
    versions: async () => (await call<{ versions: Record<string, string | null> }>(handle, "GET", "/health")).versions,
    updateTools: () => call<ToolsUpdate>(handle, "POST", "/tools/update"),
    stop: () => handle.stop(),
  };
}
