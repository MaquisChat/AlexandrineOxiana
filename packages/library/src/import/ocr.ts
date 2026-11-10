/**
 * OCR of PDFs without a text layer (spec 5.2; Task 30 carry-over). A source's PDF originals that
 * need OCR are recorded as `pendingOcr` jobs in its source.json (sealed in encrypted projects) in a
 * governed change (R31), so a job queued while no media worker runs, or interrupted by a quit, is
 * run later (`resumePending`, at launch and when a worker becomes available). Each job runs the
 * worker's `pdf.ocr` (evaluated as `process: ocr`, audited on deny) and records the text it
 * produced as a derived asset (kind `ocr-text`) in the change that removes the job. A transient
 * failure is retried with backoff (OCR_ATTEMPTS) before it is recorded as failed; failures are
 * listed for the researcher (`failures`) and can be retried (`retryFailed`).
 */
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { newId, type PendingOcr, type SourceFile } from "@ao/core";
import type { Library } from "../library.js";
import { DestroyedParentError, MissingParentError, PolicyDeniedError, ProjectLockedError, ProxyRecordRefusedError } from "../repo/errors.js";
import { addOcrAsset, editPendingOcr, editPendingOcrMany, repoLibrary, type Repo } from "../repo/repo.js";
import { activeTemp } from "../tmp-registry.js";
import { WorkerJobError, WorkerUnavailableError, type WorkerClient } from "../worker-client.js";

export const OCR_ATTEMPTS = 3;
const FINAL_CODES = new Set(["POLICY_DENIED", "ORIGINAL_GONE", "PENDING", "ALREADY_RECORDED", "CANCELLED", "ENCRYPTION_REQUIRED", "INPUT_NOT_DECRYPTABLE", "NO_TEXT"]);

export interface OcrResult {
  projectId: string;
  sourceId: string;
  jobId: string;
  ok: boolean;
  code?: string;
  assetId?: string;
}

export interface OcrFailure {
  projectId: string;
  sourceId: string;
  jobId: string;
  code: string;
  at: string;
  attempts: number;
}

export interface OcrQueueOptions {
  repo: Repo;
  worker?: WorkerClient | null;
  attempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** OCR languages (tesseract codes) passed to the worker; default its own. */
  languages?: string[];
  debug?: (note: string) => void;
}

const isPdf = (mime: string) => mime === "application/pdf";

export class OcrQueue {
  private readonly repo: Repo;
  private worker: WorkerClient | null;
  private readonly attempts: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly languages: string[] | undefined;
  private readonly debug: ((note: string) => void) | undefined;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly listeners = new Set<(r: OcrResult) => void>();

  constructor(opts: OcrQueueOptions) {
    this.repo = opts.repo;
    this.worker = opts.worker ?? null;
    this.attempts = Math.max(1, opts.attempts ?? OCR_ATTEMPTS);
    this.backoffMs = opts.backoffMs ?? 2000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
    this.languages = opts.languages;
    this.debug = opts.debug;
  }

  get available(): boolean {
    return this.worker !== null;
  }

  setWorker(worker: WorkerClient | null): void {
    if (!this.disposed) this.worker = worker;
  }

  onResult(fn: (r: OcrResult) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Records OCR jobs for the source's PDF originals that have no OCR text and no job yet (governed),
   * then runs them after those already queued when a worker is available. Returns the jobs added.
   */
  enqueue(projectId: string, sourceId: string): Promise<number> {
    return this.enqueueMany(projectId, [sourceId]);
  }

  /** `enqueue` for several sources, recorded in one governed change (a Bulk Import group, R106). */
  async enqueueMany(projectId: string, sourceIds: string[]): Promise<number> {
    if (this.disposed || !sourceIds.length) return 0;
    let added = 0;
    await editPendingOcrMany(this.repo, projectId, sourceIds, (list, sf) => {
      const done = new Set(sf.assets.filter((a) => a.role === "derived" && a.kind === "ocr-text").flatMap((a) => a.derivation?.parents ?? []));
      const queued = new Set(list.map((j) => j.assetId));
      const at = new Date().toISOString();
      for (const a of sf.assets) {
        if (a.role !== "original" || !isPdf(a.mime) || a.status === "destroyed" || done.has(a.id) || queued.has(a.id)) continue;
        list.push({ id: newId(), assetId: a.id, queuedAt: at });
        added++;
      }
      return list;
    });
    if (this.worker) for (const id of sourceIds) this.then(() => this.runSource(projectId, id)).catch(() => {});
    return added;
  }

  /** Runs every pending (not failed) OCR job of the project: at launch, or once a worker is available. */
  resumePending(projectId: string): Promise<OcrResult[]> {
    return this.then(async () => {
      const out: OcrResult[] = [];
      for (const id of this.repo.listSourceIds(projectId)) out.push(...(await this.runSource(projectId, id)));
      return out;
    });
  }

  async failures(projectId: string): Promise<OcrFailure[]> {
    const out: OcrFailure[] = [];
    for (const id of this.repo.listSourceIds(projectId)) {
      let sf: SourceFile;
      try {
        sf = await this.repo.getSource(projectId, id);
      } catch {
        continue;
      }
      for (const j of sf.pendingOcr ?? []) if (j.failed) out.push({ projectId, sourceId: id, jobId: j.id, code: j.failed.code, at: j.failed.at, attempts: j.failed.attempts ?? 1 });
    }
    return out;
  }

  async retryFailed(projectId: string, sourceId?: string): Promise<OcrResult[]> {
    for (const id of sourceId ? [sourceId] : this.repo.listSourceIds(projectId)) {
      let sf: SourceFile;
      try {
        sf = await this.repo.getSource(projectId, id);
      } catch {
        continue;
      }
      if ((sf.pendingOcr ?? []).some((j) => j.failed)) await editPendingOcr(this.repo, projectId, id, (list) => list.map(({ failed: _f, ...j }) => j));
    }
    if (sourceId) return this.then(() => this.runSource(projectId, sourceId));
    return this.resumePending(projectId);
  }

  /** Waits until no job is queued or running. */
  async idle(): Promise<void> {
    let seen: Promise<void> | undefined;
    while (seen !== this.chain) {
      seen = this.chain;
      await seen;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.worker = null;
    this.listeners.clear();
    await this.idle().catch(() => {});
  }

  private then<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runSource(projectId: string, sourceId: string): Promise<OcrResult[]> {
    let sf: SourceFile;
    try {
      sf = await this.repo.getSource(projectId, sourceId);
    } catch {
      return [];
    }
    const out: OcrResult[] = [];
    for (const job of sf.pendingOcr ?? []) {
      if (job.failed) continue;
      let r: OcrResult;
      for (let attempt = 1; ; attempt++) {
        if (!this.worker) {
          r = { projectId, sourceId, jobId: job.id, ok: false, code: "PENDING" };
          break;
        }
        r = await this.runJob(this.worker, projectId, sf, job);
        const last = attempt >= this.attempts;
        if (r.ok || FINAL_CODES.has(r.code ?? "") || last) {
          if (!r.ok && r.code !== "PENDING" && r.code !== "ALREADY_RECORDED") await this.recordFailure(projectId, sourceId, job, r.code ?? "FAILED", attempt);
          break;
        }
        this.debug?.(`OCR attempt ${attempt} failed (${r.code}); retrying`);
        await this.sleep(this.backoffMs * 4 ** (attempt - 1));
      }
      out.push(r);
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

  private async recordFailure(projectId: string, sourceId: string, job: PendingOcr, code: string, attempts: number): Promise<void> {
    try {
      await editPendingOcr(this.repo, projectId, sourceId, (list) =>
        code === "ORIGINAL_GONE"
          ? list.filter((j) => j.id !== job.id)
          : list.map((j) => (j.id === job.id ? { ...j, failed: { code: code.slice(0, 64), at: new Date().toISOString(), attempts } } : j)),
      );
    } catch {
      this.debug?.("a failed OCR job could not be recorded");
    }
  }

  private async runJob(worker: WorkerClient, projectId: string, sf: SourceFile, job: PendingOcr): Promise<OcrResult> {
    const sourceId = sf.source.id;
    const base = { projectId, sourceId, jobId: job.id };
    const asset = sf.assets.find((a) => a.id === job.assetId && a.role === "original" && a.status !== "destroyed");
    if (!asset) return { ...base, ok: false, code: "ORIGINAL_GONE" };
    const root = repoLibrary(this.repo).root;
    const input = asset.linked ? asset.linked.absolutePath : join(root, ...asset.path.split("/"));
    const name = `worker-ocr-${randomUUID()}`;
    const work = join(root, ".tmp", name);
    activeTemp.add(name);
    try {
      await fsp.mkdir(work, { recursive: true, mode: 0o700 });
      const r = await worker.submit(projectId, {
        type: "pdf.ocr",
        input,
        inputEncrypted: asset.encrypted,
        output: join(work, "ocr.pdf"),
        params: this.languages ? { languages: this.languages } : {},
        entity: { type: "asset", id: asset.id },
      });
      const text = r.files.find((f) => /\.txt(\.enc)?$/i.test(f));
      if (!text) return { ...base, ok: false, code: "NO_TEXT" };
      const added = await addOcrAsset(
        this.repo,
        projectId,
        sourceId,
        {
          fromPath: text,
          kind: "ocr-text",
          tool: "ocrmypdf",
          ext: "txt",
          ...(r.encrypted ? { fromEncrypted: true } : {}),
          derivation: {
            parents: [asset.id],
            operation: "ocr",
            provider: "ao-worker",
            ranAt: "local",
            params: this.languages ? { languages: this.languages } : {},
            at: new Date().toISOString(),
            triggeredBy: "import",
          },
        },
        job.id,
      );
      return { ...base, ok: true, assetId: added.id };
    } catch (err) {
      if (err instanceof WorkerUnavailableError || err instanceof ProjectLockedError) return { ...base, ok: false, code: "PENDING" };
      if (err instanceof ProxyRecordRefusedError) return { ...base, ok: false, code: err.code };
      if (err instanceof MissingParentError || err instanceof DestroyedParentError) return { ...base, ok: false, code: "ORIGINAL_GONE" };
      if (err instanceof PolicyDeniedError) return { ...base, ok: false, code: "POLICY_DENIED" };
      if (err instanceof WorkerJobError) return { ...base, ok: false, code: err.code };
      this.debug?.(`OCR failed: ${err instanceof Error ? err.name : "error"}`);
      return { ...base, ok: false, code: "FAILED" };
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
      activeTemp.delete(name);
    }
  }
}

const queues = new WeakMap<Library, OcrQueue>();

/** The library's OCR queue (one per library), made on first use with no worker. */
export function ocrQueueFor(repo: Repo): OcrQueue {
  const lib = repoLibrary(repo);
  let q = queues.get(lib);
  if (!q) {
    q = new OcrQueue({ repo });
    queues.set(lib, q);
  }
  return q;
}

/** Disposes of the library's OCR queue (on library close). */
export async function disposeOcrQueue(repo: Repo): Promise<void> {
  const lib = repoLibrary(repo);
  const q = queues.get(lib);
  queues.delete(lib);
  await q?.dispose();
}
