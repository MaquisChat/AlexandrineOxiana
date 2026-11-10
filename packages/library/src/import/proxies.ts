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
import { PolicyDeniedError, ProjectLockedError } from "../repo/errors.js";
import { addProxyAsset, editPendingProxies, projectDataKey, repoLibrary, type Repo } from "../repo/repo.js";
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
}

/** Runs pending viewing-proxy jobs one at a time (per library), in the background. */
export class ProxyQueue {
  private readonly repo: Repo;
  private worker: WorkerClient | null;
  private readonly debug: ((note: string) => void) | undefined;
  private chain: Promise<void> = Promise.resolve();
  private results: ProxyResult[] = [];

  constructor(opts: ProxyQueueOptions) {
    this.repo = opts.repo;
    this.worker = opts.worker ?? null;
    this.debug = opts.debug;
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
      if (!this.worker) {
        out.push({ projectId, sourceId, jobId: job.id, ok: false, code: "PENDING" });
        continue;
      }
      const r = await this.runJob(this.worker, projectId, sf, job);
      out.push(r);
      this.results.push(r);
    }
    return out;
  }

  private async fail(projectId: string, sourceId: string, job: PendingProxy, code: string): Promise<ProxyResult> {
    try {
      await editPendingProxies(this.repo, projectId, sourceId, (list) =>
        list.map((j) => (j.id === job.id ? { ...j, failed: { code: code.slice(0, 64), at: new Date().toISOString() } } : j)),
      );
    } catch {
      this.debug?.("a failed viewing-proxy job could not be recorded");
    }
    return { projectId, sourceId, jobId: job.id, ok: false, code };
  }

  private async runJob(worker: WorkerClient, projectId: string, sf: SourceFile, job: PendingProxy): Promise<ProxyResult> {
    const sourceId = sf.source.id;
    const base = { projectId, sourceId, jobId: job.id };
    const asset = sf.assets.find((a) => a.id === job.assetId && a.role === "original");
    if (!asset) {
      await editPendingProxies(this.repo, projectId, sourceId, (list) => list.filter((j) => j.id !== job.id)).catch(() => {});
      return { ...base, ok: false, code: "ORIGINAL_GONE" };
    }
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
        output: join(work, `proxy.${ext}`),
        params: { location: job.location },
        entity: { type: "asset", id: asset.id },
      });
      const file = r.files[0];
      if (!file) return await this.fail(projectId, sourceId, job, "NO_OUTPUT");
      // The proxy's location is checked on the file itself before it is recorded (R83).
      let check = file;
      if (r.encrypted) {
        const k = projectDataKey(this.repo, projectId);
        if (!k) return await this.fail(projectId, sourceId, job, "NOT_DECRYPTABLE");
        check = join(work, `check.${ext}`);
        await copyFileAtomic(file, check, { transform: (rs) => rs.pipe(decryptStream((id) => (id === k.keyId ? k.key : undefined))), mode: 0o600 });
      }
      const verdict = await checkProxyLocation(check, job.location);
      if (!verdict.ok) {
        this.debug?.(`viewing proxy discarded: ${verdict.reason}`);
        return await this.fail(projectId, sourceId, job, "LOCATION_MISMATCH");
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
            params: { location: job.location },
            at: new Date().toISOString(),
            triggeredBy: "import",
          },
        },
        job.id,
      );
      return { ...base, ok: true, assetId: added.id };
    } catch (err) {
      // No worker reachable, or the project locked: the job stays pending and runs later.
      if (err instanceof WorkerUnavailableError || err instanceof ProjectLockedError) return { ...base, ok: false, code: "PENDING" };
      if (err instanceof PolicyDeniedError) return await this.fail(projectId, sourceId, job, "POLICY_DENIED");
      if (err instanceof WorkerJobError) return await this.fail(projectId, sourceId, job, err.code);
      this.debug?.(`viewing proxy failed: ${err instanceof Error ? err.name : "error"}`);
      return await this.fail(projectId, sourceId, job, "FAILED");
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
      activeTemp.delete(name);
    }
  }
}
