/**
 * Viewing proxies of stored media under the project's location rule (spec 5.3, R83). Shared by
 * drag-and-drop attach, Bulk Import (folders, ZIPs, exports, Zotero local and web) and device
 * import: originals are never modified; a photo or video whose `store` decision carries a location
 * condition (coarsen or strip) is stored as the decision allows (encrypted where it says so), and
 * an image.proxy / video.proxy job of the media worker makes a JPEG / MP4 copy with the location
 * coarsened (latitude and longitude to one decimal, about city level) or removed. Device import
 * makes a proxy of every photo and video (HEIC, RAW and MOV are not viewable as they are), under
 * the project's rule.
 *
 * The jobs are written to the source's source.json (`pendingProxies`, sealed in encrypted
 * projects) in the same change that stores the original (R31), so a job queued while no media
 * worker is configured (the source is "proxy pending", LOCATION_REASON) or interrupted by a quit
 * is run later (`resumePending`). A finished proxy is re-read (exiftool) before it is recorded:
 * if its location does not match the rule it is discarded and the job fails (LOCATION_MISMATCH);
 * else it is recorded as a derived asset (kind `proxy`, named by derivedFileName) in the change
 * that removes the job.
 */
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { Asset, PendingProxy, SourceFile } from "@ao/core";
import { newId } from "@ao/core";
import { decryptStream } from "../crypto/format.js";
import { extractMetadata } from "../extract/index.js";
import { checkProxyLocation } from "../extract/exif.js";
import { copyFileAtomic } from "../fs/atomic.js";
import { stricterLocation } from "../repo/assets.js";
import { PolicyDeniedError, ProxyRecordRefusedError, isLockedRefusal } from "../repo/errors.js";
import { addProxyAsset, currentProjectLocationMode, editPendingProxies, projectDataKey, repoLibrary, type Repo } from "../repo/repo.js";
import type { Library } from "../library.js";
import { activeTemp } from "../tmp-registry.js";
import { WorkerJobError, WorkerUnavailableError, type WorkerClient } from "../worker-client.js";
import { LOCATION_REASON, type LocationMode } from "./common.js";
import { LOCATED_MEDIA, mayHaveLocation } from "./resolve.js";

export type ProxyJobType = PendingProxy["type"];

/** The proxy job for a stored file's MIME type or asset kind (undefined: no proxy for it, e.g. audio). */
export function proxyTypeFor(mimeOrKind: string): ProxyJobType | undefined {
  const m = mimeOrKind.toLowerCase();
  if (m === "image" || m.startsWith("image/")) return "image.proxy";
  if (m === "video" || m.startsWith("video/")) return "video.proxy";
  return undefined;
}

export interface ProxyPlan {
  /** Some file may carry a location (GPS, or media whose metadata cannot be read: R57): `store` is asked with hasLocation. */
  located: boolean;
  /** Indexes of the files (photos and videos) that get a viewing proxy, with the job type. */
  proxies: Array<{ index: number; type: ProxyJobType }>;
}

/**
 * Which of an item's files may carry a location, and which get a proxy: located photos and videos
 * (they need one under a location rule), or every photo and video with `all` (device import).
 */
export async function planProxies(files: Array<{ path: string; mime?: string | undefined }>, opts: { all?: boolean } = {}): Promise<ProxyPlan> {
  const plan: ProxyPlan = { located: false, proxies: [] };
  for (const [index, f] of files.entries()) {
    const mime = f.mime ?? "";
    if (!LOCATED_MEDIA.test(mime)) continue;
    const located = mayHaveLocation(mime, await extractMetadata(f.path, mime));
    if (located) plan.located = true;
    const type = proxyTypeFor(mime);
    if (type && (located || opts.all)) plan.proxies.push({ index, type });
  }
  return plan;
}

/**
 * The pending-proxy entries for stored originals, once the `store` decision is known: a located
 * file under a location condition gets the condition's mode; with `all`, every planned file gets
 * one, with `mode` (the caller passes the project's rule when the decision had no condition).
 * Without a mode and without `all`, nothing is needed.
 */
export function pendingFor(plan: ProxyPlan, assets: Asset[], mode: LocationMode | undefined, all = false): PendingProxy[] {
  if (!mode && !all) return [];
  const at = new Date().toISOString();
  const out: PendingProxy[] = [];
  for (const p of plan.proxies) {
    const a = assets[p.index];
    if (!a) continue;
    out.push({ id: newId(), type: p.type, assetId: a.id, location: mode ?? "keep", queuedAt: at });
  }
  return out;
}

export interface ProxyResult {
  projectId: string;
  sourceId: string;
  jobId: string;
  ok: boolean;
  /** Failure code: LOCATION_MISMATCH, POLICY_DENIED, a worker error code, ORIGINAL_GONE; PENDING: not run now (no worker, locked project). */
  code?: string;
  /** The recorded proxy asset. */
  assetId?: string;
}

export interface ProxyQueueOptions {
  repo: Repo;
  /** The media worker; null or absent: none is configured (jobs stay pending, LOCATION_REASON). */
  worker?: WorkerClient | null;
  debug?: (note: string) => void;
  /** Attempts per job before it is recorded as failed (default PROXY_ATTEMPTS). */
  attempts?: number;
  /** Wait before the second attempt, multiplied by 4 for each further one (default 2 s). */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Attempts of a viewing-proxy job (a transient worker failure is retried with backoff) before it is recorded as failed (R96). */
export const PROXY_ATTEMPTS = 3;
/** Failures that another attempt cannot fix: recorded at once. */
const FINAL_CODES = new Set(["LOCATION_MISMATCH", "POLICY_DENIED", "NOT_DECRYPTABLE", "ORIGINAL_GONE", "PENDING", "ALREADY_RECORDED", "RULE_CHANGED", "CANCELLED", "ENCRYPTION_REQUIRED", "INPUT_NOT_DECRYPTABLE"]);

/** A job recorded as failed (after its attempts), for the researcher to see and retry. */
export interface ProxyFailure {
  projectId: string;
  sourceId: string;
  jobId: string;
  type: PendingProxy["type"];
  code: string;
  at: string;
  attempts: number;
}

/** Runs pending viewing-proxy jobs one at a time (per library), in the background. */
export class ProxyQueue {
  private readonly repo: Repo;
  private worker: WorkerClient | null;
  private readonly debug: ((note: string) => void) | undefined;
  private chain: Promise<void> = Promise.resolve();
  private results: ProxyResult[] = [];
  private readonly attempts: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private disposed = false;
  private readonly listeners = new Set<(r: ProxyResult) => void>();

  constructor(opts: ProxyQueueOptions) {
    this.repo = opts.repo;
    this.worker = opts.worker ?? null;
    this.debug = opts.debug;
    this.attempts = Math.max(1, opts.attempts ?? PROXY_ATTEMPTS);
    this.backoffMs = opts.backoffMs ?? 2000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
  }

  /** Called with each job's result as it finishes (progress for the researcher). Returns an unsubscribe function. */
  onResult(fn: (r: ProxyResult) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Jobs of the project recorded as failed, with their codes (surfaced to the researcher, R96). */
  async failures(projectId: string): Promise<ProxyFailure[]> {
    const out: ProxyFailure[] = [];
    for (const id of this.repo.listSourceIds(projectId)) {
      let sf: SourceFile;
      try {
        sf = await this.repo.getSource(projectId, id);
      } catch {
        continue;
      }
      for (const j of sf.pendingProxies ?? []) {
        if (j.failed) out.push({ projectId, sourceId: id, jobId: j.id, type: j.type, code: j.failed.code, at: j.failed.at, attempts: j.failed.attempts ?? 1 });
      }
    }
    return out;
  }

  /** Clears the failed mark of the project's failed jobs (or one source's) and runs them again. */
  async retryFailed(projectId: string, sourceId?: string): Promise<ProxyResult[]> {
    const ids = sourceId ? [sourceId] : this.repo.listSourceIds(projectId);
    for (const id of ids) {
      let sf: SourceFile;
      try {
        sf = await this.repo.getSource(projectId, id);
      } catch {
        continue;
      }
      if (!(sf.pendingProxies ?? []).some((j) => j.failed)) continue;
      await editPendingProxies(this.repo, projectId, id, (list) => list.map(({ failed: _f, ...j }) => j));
    }
    if (sourceId) return this.then(() => this.runSource(projectId, sourceId));
    return this.resumePending(projectId);
  }

  /** Stops taking work (the library is closing): waits for the job running now; later jobs stay pending. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.worker = null;
    this.listeners.clear();
    await this.idle().catch(() => {});
  }

  /** Whether proxy jobs can be run now (a media worker is configured). */
  get available(): boolean {
    return this.worker !== null;
  }

  /** The note for an item whose proxies stay pending because no worker is configured. */
  get pendingNote(): string | undefined {
    return this.available ? undefined : LOCATION_REASON;
  }

  /** A worker became available (or went away). Call `resumePending` for each open project afterwards. */
  setWorker(worker: WorkerClient | null): void {
    if (this.disposed) return;
    this.worker = worker;
  }

  /** Runs the source's pending jobs after those already queued (nothing while no worker is configured). */
  enqueue(projectId: string, sourceId: string): void {
    if (!this.worker) return;
    this.then(() => this.runSource(projectId, sourceId)).catch(() => {});
  }

  /** Runs every pending (not failed) job of the project's sources: e.g. at launch, or once a worker is available. */
  resumePending(projectId: string): Promise<ProxyResult[]> {
    return this.then(async () => {
      const out: ProxyResult[] = [];
      for (const id of this.repo.listSourceIds(projectId)) out.push(...(await this.runSource(projectId, id)));
      return out;
    });
  }

  /** Waits until no job is queued or running; the results since the previous call. */
  async idle(): Promise<ProxyResult[]> {
    let seen: Promise<void> | undefined;
    while (seen !== this.chain) {
      seen = this.chain;
      await seen;
    }
    return this.results.splice(0);
  }

  private then<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runSource(projectId: string, sourceId: string): Promise<ProxyResult[]> {
    let sf: SourceFile;
    try {
      sf = await this.repo.getSource(projectId, sourceId);
    } catch {
      return []; // gone, unreadable or locked: its jobs stay where they are
    }
    const out: ProxyResult[] = [];
    for (const job of sf.pendingProxies ?? []) {
      if (job.failed) continue;
      let r: ProxyResult | undefined;
      for (let attempt = 1; ; attempt++) {
        if (!this.worker) {
          r = { projectId, sourceId, jobId: job.id, ok: false, code: "PENDING" };
          break;
        }
        const last = attempt >= this.attempts;
        r = await this.runJob(this.worker, projectId, sf, job, last ? attempt : 0);
        if (r.ok || last || FINAL_CODES.has(r.code ?? "")) break;
        // A transient failure (the worker failed this time): try again after a pause (R96).
        this.debug?.(`viewing proxy attempt ${attempt} failed (${r.code}); retrying`);
        await this.sleep(this.backoffMs * 4 ** (attempt - 1));
      }
      out.push(r);
      if (r.code !== "PENDING") this.results.push(r);
      for (const l of this.listeners) {
        try {
          l(r);
        } catch {
          // a listener's problem is not the queue's
        }
      }
    }
    return out;
  }

  /** `attempts` > 0: record the failure (the job's last attempt); 0: only report it (it is retried). */
  private async fail(projectId: string, sourceId: string, job: PendingProxy, code: string, attempts = 1): Promise<ProxyResult> {
    if (attempts === 0 && !FINAL_CODES.has(code)) return { projectId, sourceId, jobId: job.id, ok: false, code };
    try {
      await editPendingProxies(this.repo, projectId, sourceId, (list) =>
        list.map((j) => (j.id === job.id ? { ...j, failed: { code: code.slice(0, 64), at: new Date().toISOString(), attempts: Math.max(1, attempts) } } : j)),
      );
    } catch {
      this.debug?.("a failed viewing-proxy job could not be recorded");
    }
    return { projectId, sourceId, jobId: job.id, ok: false, code };
  }

  private async runJob(worker: WorkerClient, projectId: string, sf: SourceFile, job: PendingProxy, attempts: number): Promise<ProxyResult> {
    const sourceId = sf.source.id;
    const base = { projectId, sourceId, jobId: job.id };
    const asset = sf.assets.find((a) => a.id === job.assetId && a.role === "original");
    if (!asset) {
      await editPendingProxies(this.repo, projectId, sourceId, (list) => list.filter((j) => j.id !== job.id)).catch(() => {});
      return { ...base, ok: false, code: "ORIGINAL_GONE" };
    }
    // The rule as it is now, if stricter than when the job was queued (R85 C1).
    const mode = stricterLocation(job.location, await currentProjectLocationMode(this.repo, projectId));
    const root = repoLibrary(this.repo).root;
    const input = asset.linked ? asset.linked.absolutePath : join(root, ...asset.path.split("/"));
    const ext = job.type === "image.proxy" ? "jpg" : "mp4";
    const name = `worker-proxy-${randomUUID()}`;
    const work = join(root, ".tmp", name);
    activeTemp.add(name);
    try {
      await fsp.mkdir(work, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await fsp.chmod(work, 0o700);
      const r = await worker.submit(projectId, {
        type: job.type,
        input,
        inputEncrypted: asset.encrypted,
        // A linked file is recorded as its asset, never by its path (R379).
        ...(asset.linked ? { inputAsset: { sourceId, assetId: asset.id } } : {}),
        output: join(work, `proxy.${ext}`),
        params: { location: mode },
        entity: { type: "asset", id: asset.id },
      });
      const file = r.files[0];
      if (!file) return await this.fail(projectId, sourceId, job, "NO_OUTPUT", attempts);
      // The proxy's location is checked on the file itself before it is recorded (R83).
      let check = file;
      if (r.encrypted) {
        const k = projectDataKey(this.repo, projectId);
        if (!k) return await this.fail(projectId, sourceId, job, "NOT_DECRYPTABLE", attempts);
        check = join(work, `check.${ext}`);
        await copyFileAtomic(file, check, { transform: (rs) => rs.pipe(decryptStream((id) => (id === k.keyId ? k.key : undefined))), mode: 0o600 });
      }
      const verdict = await checkProxyLocation(check, mode);
      if (!verdict.ok) {
        this.debug?.(`viewing proxy discarded: ${verdict.reason}`);
        return await this.fail(projectId, sourceId, job, "LOCATION_MISMATCH", attempts);
      }
      const added = await addProxyAsset(
        this.repo,
        projectId,
        sourceId,
        {
          fromPath: file,
          kind: "proxy",
          tool: "ao-worker",
          ext,
          ...(r.encrypted ? { fromEncrypted: true } : {}),
          derivation: {
            parents: [asset.id],
            operation: job.type,
            provider: "ao-worker",
            ranAt: "local",
            params: { location: mode },
            at: new Date().toISOString(),
            triggeredBy: "import",
          },
        },
        job.id,
        mode,
      );
      return { ...base, ok: true, assetId: added.id };
    } catch (err) {
      // No worker reachable, or the project locked (also while its check was read, R386 a): the job stays pending.
      // Only a lock (R435 d): a check sealed under another key id is damage, and the job fails.
      if (err instanceof WorkerUnavailableError || isLockedRefusal(err)) return { ...base, ok: false, code: "PENDING" };
      if (err instanceof ProxyRecordRefusedError) {
        // RULE_CHANGED: stays pending and is made again under the stricter rule; ALREADY_RECORDED: another run did it.
        if (err.code === "ORIGINAL_GONE") await editPendingProxies(this.repo, projectId, sourceId, (list) => list.filter((j) => j.id !== job.id)).catch(() => {});
        return { ...base, ok: false, code: err.code };
      }
      if (err instanceof PolicyDeniedError) return await this.fail(projectId, sourceId, job, "POLICY_DENIED", attempts);
      if (err instanceof WorkerJobError) return await this.fail(projectId, sourceId, job, err.code, attempts);
      this.debug?.(`viewing proxy failed: ${err instanceof Error ? err.name : "error"}`);
      return await this.fail(projectId, sourceId, job, "FAILED", attempts);
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
      activeTemp.delete(name);
    }
  }
}

/** One queue per library (R85 I2): attach, Bulk Import and watched folders share it. */
const queues = new WeakMap<Library, ProxyQueue>();

/** Disposes of the library's queue (on library close, R96): the running job finishes, nothing new starts. */
export async function disposeProxyQueue(repo: Repo): Promise<void> {
  const lib = repoLibrary(repo);
  const q = queues.get(lib);
  queues.delete(lib);
  await q?.dispose();
}

/**
 * The library's viewing-proxy queue, made on first use (with no worker: jobs stay pending until
 * `setWorker` and `resumePending`). Callers that are given a queue explicitly use that one.
 */
export function proxyQueueFor(repo: Repo): ProxyQueue {
  const lib = repoLibrary(repo);
  let q = queues.get(lib);
  if (!q) {
    q = new ProxyQueue({ repo });
    queues.set(lib, q);
  }
  return q;
}
