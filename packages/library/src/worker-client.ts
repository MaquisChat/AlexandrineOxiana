/**
 * Client for the Python media worker (`services/media-worker`, spec 2.1 / 5.2 / 5.3).
 *
 * `startWorker` spawns the worker, writes a random token as one line on its standard input (which stays
 * open: the worker stops when it closes, R155), and waits for `AO_WORKER_READY port=<n>`.
 * `WorkerClient.submit` runs one job for a project:
 *
 *   1. policy: `process` with `{ op, provider: 'local' }` (transcription, image_proxy, video_proxy,
 *      ocr), evaluated by the repo with the system tz and `now`; a deny is audited through the repo
 *      and thrown as PolicyDeniedError before the worker is contacted. `capture.download` is not
 *      evaluated here: the caller has already passed a `capture` decision.
 *   2. a `jobs` row (status queued → running → done | failed | cancelled) so that a job the app
 *      did not see finish is resubmitted on the next launch (`resumePending`). `capture.download`
 *      is never resumed (its capture decision and caller are gone): it is marked failed
 *      `INTERRUPTED`, and leftover `.tmp/capture-*` / `worker-*` / `batch-*` folders are swept. For an encrypted
 *      project the row's payload is sealed with the project key.
 *   3. a private temp folder `<Library>/.tmp/worker-<id>/` (0700): an encrypted input is decrypted
 *      into it (0600), and the worker writes its outputs there.
 *   4. polling every 500 ms, progress forwarded; an aborted signal cancels the worker job.
 *   5. outputs are moved to the caller's `output` (encrypted with the project key when the project
 *      is encrypted or the decision requires it); the temp folder is removed in `finally`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import type { EntityType, PolicyDecision, ProcessingOp } from "@ao/core";
import { decryptStream, encryptStream } from "./crypto/format.js";
import { copyFileAtomic, renameWithRetry } from "./fs/atomic.js";
import type { IndexDb } from "./index/db.js";
import { activeTemp, isStaleWorkDir } from "./tmp-registry.js";
import { decryptBytes, encryptBytes } from "./repo/io.js";
import { authorizeProcessing, projectDataKey, repoLibrary, type Repo } from "./repo/repo.js";
import { mediaWorkerSourceDir } from "./resources.js";

export type WorkerJobType = "audio.transcribe" | "capture.download" | "image.proxy" | "video.proxy" | "pdf.ocr";

/** The processing op each job type is evaluated as (null: the caller passed a `capture` decision). */
export const JOB_OPS: Record<WorkerJobType, ProcessingOp | null> = {
  "audio.transcribe": "transcription",
  "capture.download": null,
  "image.proxy": "image_proxy",
  "video.proxy": "video_proxy",
  "pdf.ocr": "ocr",
};

/** Job types whose `output` is a folder; the others produce a file (pdf.ocr also `<output>.txt`). */
const DIR_OUTPUTS: ReadonlySet<WorkerJobType> = new Set(["audio.transcribe", "capture.download"]);

export interface WorkerJob {
  type: WorkerJobType;
  /** Absolute path of the input file, or the URL for `capture.download`. */
  input: string;
  /** The input is in the library's encrypted file format (decrypted with the project key first). */
  inputEncrypted?: boolean;
  /** Final destination: a folder for audio.transcribe and capture.download, else a file. */
  output: string;
  params?: Record<string, unknown>;
  /** Entity recorded on a deny audit event. */
  entity?: { type: EntityType; id: string };
  /** Called with 0..1 whenever the worker reports progress. */
  onProgress?: (progress: number) => void;
  /** Aborting cancels the job (the worker kills its child processes). */
  signal?: AbortSignal;
}

export interface JobResult {
  /** The client's job id (the `jobs` row). */
  id: string;
  type: WorkerJobType;
  /** The caller's `output`. */
  output: string;
  /** Every file written under the destination. */
  files: string[];
  /** Worker meta, with worker temp paths rewritten to their final paths. */
  meta: Record<string, unknown>;
  /** True when the files were written encrypted with the project key. */
  encrypted: boolean;
}

export class WorkerJobError extends Error {
  override name = "WorkerJobError";
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** The worker could not be reached (or no longer accepts our token). The job stays pending. */
export class WorkerUnavailableError extends Error {
  override name = "WorkerUnavailableError";
}

export interface WorkerEndpoint {
  baseUrl: string;
  token: string;
}

export interface WorkerClientOptions {
  repo: Repo;
  worker: WorkerEndpoint;
  /** The library index; its `jobs` table records jobs so pending ones survive a restart. */
  index?: { db: IndexDb };
  /** Poll interval (default 500 ms). */
  pollMs?: number;
}

interface StoredJob {
  type: WorkerJobType;
  input: string;
  inputEncrypted?: boolean;
  output: string;
  params: Record<string, unknown>;
  entity?: { type: EntityType; id: string };
}

interface WorkerJobState {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress?: number;
  result?: { output: string; meta?: Record<string, unknown> };
  error?: { code: string; message: string; detail?: string };
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);
/** Failed polls retried (with backoff) before the worker is treated as gone. */
const POLL_RETRIES = 3;

export class WorkerClient {
  private readonly repo: Repo;
  private readonly worker: WorkerEndpoint;
  private readonly db?: IndexDb;
  private readonly pollMs: number;
  private readonly active = new Set<string>();

  constructor(opts: WorkerClientOptions) {
    this.repo = opts.repo;
    this.worker = opts.worker;
    this.db = opts.index?.db;
    this.pollMs = opts.pollMs ?? 500;
  }

  submit(projectId: string, job: WorkerJob): Promise<JobResult> {
    return this.run(randomUUID(), projectId, job, true);
  }

  /**
   * Resubmits jobs recorded as queued or running (the app quit or the worker died before they
   * finished). Call once at launch, before new submissions; stale worker temp folders are removed.
   * Jobs of locked projects are reported with ProjectLockedError and stay pending.
   */
  async resumePending(): Promise<Array<{ id: string; projectId: string; result?: JobResult; error?: unknown }>> {
    if (!this.db) return [];
    await this.removeStaleTemp();
    const rows = this.db
      .prepare("SELECT id, project_id, kind, payload_json FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at, id")
      .all() as Array<{ id: string; project_id: string; kind: string; payload_json: string }>;
    const out: Array<{ id: string; projectId: string; result?: JobResult; error?: unknown }> = [];
    for (const row of rows) {
      if (row.kind === "capture.download") {
        // Never resumed: its caller (and the capture decision it made) is gone, and its output
        // folder has been swept. The researcher captures the link again.
        this.setStatus(row.id, "failed", true);
        out.push({ id: row.id, projectId: row.project_id, error: new WorkerJobError("INTERRUPTED", "the capture was interrupted; capture the link again") });
        continue;
      }
      try {
        const stored = await this.unseal(row.project_id, row.payload_json);
        out.push({ id: row.id, projectId: row.project_id, result: await this.run(row.id, row.project_id, stored, false) });
      } catch (error) {
        out.push({ id: row.id, projectId: row.project_id, error });
      }
    }
    return out;
  }

  // ---- internals ----

  private async run(id: string, projectId: string, job: WorkerJob, fresh: boolean): Promise<JobResult> {
    const op = JOB_OPS[job.type];
    if (op === undefined) throw new TypeError(`unknown worker job type "${String(job.type)}"`);
    let decision: PolicyDecision | undefined;
    if (op !== null) {
      decision = await authorizeProcessing(
        this.repo,
        projectId,
        { action: "process", process: { op, provider: "local" } },
        { op: `worker.${job.type}`, entity: job.entity },
      );
    }
    const dataKey = projectDataKey(this.repo, projectId); // throws ProjectLockedError when locked
    const mustEncrypt = decision?.result === "allow_with_conditions" && decision.conditions.some((c) => c.type === "encrypt");
    if (mustEncrypt && !dataKey) throw new WorkerJobError("ENCRYPTION_REQUIRED", "the decision requires encryption but the project is not encrypted");
    const stored: StoredJob = {
      type: job.type,
      input: job.input,
      ...(job.inputEncrypted ? { inputEncrypted: true } : {}),
      output: job.output,
      params: job.params ?? {},
      ...(job.entity ? { entity: job.entity } : {}),
    };
    if (fresh) await this.insertRow(id, projectId, stored, dataKey);
    else this.setStatus(id, "queued");

    const root = repoLibrary(this.repo).root;
    const tmp = join(root, ".tmp", `worker-${id}`);
    this.active.add(id);
    activeTemp.add(`worker-${id}`);
    try {
      await fsp.mkdir(join(root, ".tmp"), { recursive: true });
      await fsp.rm(tmp, { recursive: true, force: true });
      await privateDir(tmp);
      let input = job.input;
      if (job.inputEncrypted) {
        if (!dataKey) throw new WorkerJobError("INPUT_NOT_DECRYPTABLE", "the input is encrypted but the project is not");
        await privateDir(join(tmp, "in"));
        input = join(tmp, "in", basename(job.input).replace(/\.enc$/i, ""));
        const getKey = (keyId: string) => (keyId === dataKey.keyId ? dataKey.key : undefined);
        await copyFileAtomic(job.input, input, { transform: (r) => r.pipe(decryptStream(getKey)), mode: 0o600 });
      }
      const outDir = join(tmp, "out");
      await privateDir(outDir);
      const isDir = DIR_OUTPUTS.has(job.type);
      const workerOutput = isDir ? outDir : join(outDir, basename(job.output));
      const finalBase = isDir ? job.output : dirname(job.output);

      if (job.signal?.aborted) throw new WorkerJobError("CANCELLED", "the job was cancelled");
      const { id: workerId } = await this.request<{ id: string }>("POST", "/jobs", {
        type: job.type,
        input,
        output: workerOutput,
        params: job.params ?? {},
      });
      this.setStatus(id, "running");
      const state = await this.poll(workerId, job);

      if (state.status === "cancelled") throw new WorkerJobError("CANCELLED", "the job was cancelled");
      if (state.status === "failed") {
        const e = state.error ?? { code: "FAILED", message: "the job failed" };
        throw new WorkerJobError(e.code, e.message, e.detail);
      }
      const files = await publish(outDir, finalBase, dataKey);
      const meta = rewritePaths(state.result?.meta ?? {}, outDir, finalBase) as Record<string, unknown>;
      this.setStatus(id, "done", true);
      return { id, type: job.type, output: job.output, files, meta, encrypted: dataKey !== null };
    } catch (err) {
      if (!(err instanceof WorkerUnavailableError)) {
        this.setStatus(id, err instanceof WorkerJobError && err.code === "CANCELLED" ? "cancelled" : "failed", true);
      }
      throw err;
    } finally {
      this.active.delete(id);
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      activeTemp.delete(`worker-${id}`);
    }
  }

  private async poll(workerId: string, job: WorkerJob): Promise<WorkerJobState> {
    let cancelSent = false;
    let last = -1;
    let failures = 0;
    for (;;) {
      if (job.signal?.aborted && !cancelSent) {
        cancelSent = true;
        await this.request("POST", `/jobs/${encodeURIComponent(workerId)}/cancel`).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
      let state: WorkerJobState;
      try {
        state = await this.request<WorkerJobState>("GET", `/jobs/${encodeURIComponent(workerId)}`);
        failures = 0;
      } catch (err) {
        if (!(err instanceof WorkerUnavailableError)) throw err;
        if (++failures <= POLL_RETRIES) {
          await new Promise((r) => setTimeout(r, this.pollMs * 2 ** failures)); // backoff
          continue;
        }
        // Give up: ask the worker (best effort) to stop, so it does not keep writing into the temp
        // folder we are about to delete. The job stays pending and is resubmitted on next launch.
        await this.request("POST", `/jobs/${encodeURIComponent(workerId)}/cancel`).catch(() => {});
        throw err;
      }
      if (typeof state.progress === "number" && state.progress !== last && state.status !== "cancelled") {
        last = state.progress;
        try {
          job.onProgress?.(state.progress);
        } catch {
          // a progress callback must not break the job
        }
      }
      if (TERMINAL.has(state.status)) return state;
    }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.worker.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${this.worker.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new WorkerUnavailableError(`the media worker is not reachable (${err instanceof Error ? err.message : String(err)})`);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.status === 401) throw new WorkerUnavailableError("the media worker rejected the token (was it restarted?)");
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; detail?: string } } | undefined)?.error;
      throw new WorkerJobError(e?.code ?? `HTTP_${res.status}`, e?.message ?? `the media worker answered ${res.status}`, e?.detail);
    }
    return json as T;
  }

  private async insertRow(id: string, projectId: string, stored: StoredJob, dataKey: { key: Uint8Array; keyId: string } | null): Promise<void> {
    if (!this.db) return;
    const json = JSON.stringify(stored);
    // R30: an encrypted project's paths, URLs and params never reach the persistent index in the clear.
    const payload = dataKey ? JSON.stringify({ sealed: (await encryptBytes(dataKey.key, dataKey.keyId, json)).toString("base64") }) : json;
    this.db
      .prepare("INSERT INTO jobs (id, project_id, kind, status, payload_json, created_at) VALUES (?, ?, ?, 'queued', ?, ?)")
      .run(id, projectId, stored.type, payload, new Date().toISOString());
  }

  private setStatus(id: string, status: WorkerJobState["status"], clearPayload = false): void {
    if (!this.db?.open) return;
    if (clearPayload) this.db.prepare("UPDATE jobs SET status = ?, payload_json = '{}' WHERE id = ?").run(status, id);
    else this.db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, id);
  }

  private async unseal(projectId: string, payloadJson: string): Promise<StoredJob> {
    const parsed = JSON.parse(payloadJson) as StoredJob | { sealed: string };
    if (!("sealed" in parsed)) return parsed;
    const k = projectDataKey(this.repo, projectId); // ProjectLockedError while locked
    if (!k) throw new Error("job payload is sealed but the project is not encrypted");
    const plain = await decryptBytes((keyId) => (keyId === k.keyId ? k.key : undefined), Buffer.from(parsed.sealed, "base64"));
    return JSON.parse(plain.toString("utf8")) as StoredJob;
  }

  private async removeStaleTemp(): Promise<void> {
    const dir = join(repoLibrary(this.repo).root, ".tmp");
    let names: string[] = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (isStaleWorkDir(n) && !this.active.has(n.slice("worker-".length))) {
        await fsp.rm(join(dir, n), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

async function privateDir(path: string): Promise<void> {
  await fsp.mkdir(path, { mode: 0o700 });
  if (process.platform !== "win32") await fsp.chmod(path, 0o700); // the umask may have narrowed nothing, but be explicit
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(p)));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

/** Moves (or encrypts) every file under `from` to the same relative path under `to`. */
async function publish(from: string, to: string, dataKey: { key: Uint8Array; keyId: string } | null): Promise<string[]> {
  const written: string[] = [];
  for (const src of await walkFiles(from)) {
    const dest = join(to, relative(from, src));
    await fsp.mkdir(dirname(dest), { recursive: true });
    if (dataKey) {
      await copyFileAtomic(src, dest, { transform: (r) => r.pipe(encryptStream(dataKey.key, dataKey.keyId)), mode: 0o600 });
    } else {
      try {
        await renameWithRetry(src, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        await copyFileAtomic(src, dest);
      }
    }
    written.push(dest);
  }
  return written;
}

function rewritePaths(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") {
    if (value === from) return to;
    if (value.startsWith(from + sep)) return join(to, value.slice(from.length + 1));
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => rewritePaths(v, from, to));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewritePaths(v, from, to)]));
  }
  return value;
}

// ---------- starting the worker ----------

export interface StartWorkerOptions {
  /** Explicit argv. Default: `$AO_WORKER_BIN` (packaged sidecar), else `<venv python> -m ao_worker`. */
  command?: string[];
  /** Python for the dev worker (default `services/media-worker/.venv`'s). */
  python?: string;
  /** Extra environment, e.g. AO_MODELS_DIR and AO_TOOLS_DIR. */
  env?: Record<string, string>;
  /** Default 30 s. */
  readyTimeoutMs?: number;
  /** Worker stderr lines (its log). */
  onLog?: (line: string) => void;
}

export interface WorkerHandle extends WorkerEndpoint {
  process: ChildProcess;
  /** Stops the worker (SIGTERM, SIGKILL after 5 s) and waits for it to exit. */
  stop(): Promise<void>;
}

/** The media worker's source folder (its dev venv); none in a built folder, where AO_WORKER_BIN is required. */
const workerDir = (): string => {
  const dir = mediaWorkerSourceDir();
  if (!dir) throw new Error("The media worker is not configured: set AO_WORKER_BIN to the packaged worker.");
  return dir;
};
const READY_RE = /^AO_WORKER_READY port=(\d+)\s*$/;

// The worker (and the tools it runs) get only what they need from the app's environment.
const WORKER_ENV_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "USERPROFILE", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TEMP", "TMP",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "DBUS_SESSION_BUS_ADDRESS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "TESSDATA_PREFIX",
]);
const WORKER_ENV_PREFIXES = ["LC_", "XDG_", "AO_"];
// Secrets of the app that the worker (and the tools it runs) must never see.
// AO_SERVICE_TOKEN: the library service refuses to start with it set (it takes its token on standard
// input, R98), so it cannot be here; denied anyway, in case another host process ever sets it.
const WORKER_ENV_DENY = new Set(["AO_WORKER_TOKEN", "AO_PASSPHRASE", "AO_SERVICE_TOKEN"]);

/** The allowlisted subset of `env` passed to the worker (names compared case-insensitively). */
export function workerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || WORKER_ENV_DENY.has(k.toUpperCase())) continue;
    const u = k.toUpperCase();
    if (WORKER_ENV_NAMES.has(u) || WORKER_ENV_PREFIXES.some((p) => u.startsWith(p))) out[k] = v;
  }
  return out;
}

export function devWorkerPython(): string {
  return join(workerDir(), ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
}

export async function startWorker(opts: StartWorkerOptions = {}): Promise<WorkerHandle> {
  let argv = opts.command;
  let cwd: string | undefined;
  if (!argv) {
    if (process.env.AO_WORKER_BIN) {
      argv = [process.env.AO_WORKER_BIN];
    } else {
      const py = opts.python ?? devWorkerPython();
      if (!existsSync(py)) throw new Error(`media worker venv not found (${py}); run \`pnpm setup:py\``);
      argv = [py, "-m", "ao_worker"];
      cwd = workerDir();
    }
  }
  const token = randomBytes(32).toString("hex");
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    // The token travels on standard input only, as one line (R98, R155); the worker refuses one in
    // its environment or arguments. Standard input then stays open for the worker's whole life: the
    // worker stops when it closes, so this process exiting, crashing or being killed leaves no worker.
    env: {
      ...workerEnv(process.env),
      ...opts.env,
      AO_WORKER_PORT: "0",
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin!.on("error", () => {}); // the worker gone early: its exit is reported below
  child.stdin!.write(`${token}\n`);
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  const stderrTail: string[] = [];
  createInterface({ input: child.stderr! }).on("line", (line) => {
    stderrTail.push(line);
    if (stderrTail.length > 20) stderrTail.shift();
    opts.onLog?.(line);
  });
  const isRunning = () => child.exitCode === null && child.signalCode === null;
  const stop = async (): Promise<void> => {
    if (!isRunning()) return exited;
    child.stdin?.end();
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (isRunning()) child.kill("SIGKILL");
    }, 5000);
    await exited;
    clearTimeout(timer);
  };

  const port = await new Promise<number>((resolve, reject) => {
    const timeoutMs = opts.readyTimeoutMs ?? 30_000;
    const lines = createInterface({ input: child.stdout! });
    let done = false;
    const finish = (err: Error | null, p?: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(p!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      void exited.then(() => finish(new Error(`media worker was not ready within ${timeoutMs} ms`)));
    }, timeoutMs);
    lines.on("line", (line) => {
      const m = READY_RE.exec(line);
      if (m) finish(null, Number(m[1]));
    });
    child.once("error", (err) => finish(new Error(`media worker could not be started: ${err.message}`)));
    child.once("exit", (code, signal) => {
      // let stderr drain so the reason is in the message
      setTimeout(() => {
        finish(new Error(`media worker exited with ${code !== null ? `code ${code}` : `signal ${signal}`} before it was ready${stderrTail.length ? `: ${stderrTail.slice(-5).join(" | ")}` : ""}`));
      }, 50);
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}`, token, process: child, stop };
}
