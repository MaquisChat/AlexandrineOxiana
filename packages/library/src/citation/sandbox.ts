/**
 * Renders with an imported (custom) citation style in worker_threads workers (R88 I3, R89).
 * Bundled styles render in-process (@ao/core); a style someone imported is untrusted, and
 * citeproc-js has no limits of its own (a style whose macros fan out runs for hours).
 *
 * The pool:
 *   - at most `maxWorkers` (2) workers alive at once; further renders wait their turn;
 *   - one warm worker per style (keyed by the sha256 of its XML and the heap cap), whose engine
 *     is kept and reused (each render starts from fresh engine state); a worker for another
 *     style that is idle is retired when a slot is needed, and any worker after `idleMs` (60 s)
 *     idle;
 *   - starting a worker and building its engine for a language has `startTimeoutMs` (10 s); each
 *     render `renderTimeoutMs` (5 s), counted from when the worker begins that render (time spent
 *     waiting for a free worker does not count);
 *   - a heap cap of `maxHeapMb` (256 MB) per worker, given to the worker as `resourceLimits`. A
 *     process-wide `--max-old-space-size` (on the command line or in NODE_OPTIONS) overrides it:
 *     where such a setting is given, every worker's cap is that setting, whatever `maxHeapMb` says
 *     (tried with Node 22: 64 or 512 gives every worker that cap, for a `maxHeapMb` of 16, 256 or
 *     1024; R503 k, FR-740). The desktop app starts the service with `--max-old-space-size=512`
 *     (its memory ceiling, src-tauri/src/service.rs), so in the app a worker's cap is 512 MB: a
 *     style that allocates without end still ends only its worker ("resources"), later than at
 *     256 MB. The render time limit holds whatever the setting;
 *   - on a timeout, a heap overrun or an error the worker is terminated (the next render gets a
 *     fresh one).
 * Every failure is a SandboxError (`reason`: timeout, resources, or error — the last is
 * deterministic: citeproc itself failed); the library process is never affected.
 */
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { CitationFormat, CslItem } from "@ao/core";
import { citeprocRequireFrom, sandboxWorkerUrl } from "../resources.js";

export interface SandboxConfig {
  maxWorkers: number;
  renderTimeoutMs: number;
  startTimeoutMs: number;
  idleMs: number;
  maxHeapMb: number;
}

const DEFAULTS: SandboxConfig = { maxWorkers: 2, renderTimeoutMs: 5000, startTimeoutMs: 10_000, idleMs: 60_000, maxHeapMb: 256 };
export const SANDBOX_TIMEOUT_MS = DEFAULTS.renderTimeoutMs;
export const SANDBOX_MAX_HEAP_MB = DEFAULTS.maxHeapMb;
// Below about 4 MB a worker cannot even start, and V8 then aborts the whole process: never go there.
const SANDBOX_MIN_HEAP_MB = 16;

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly reason: "timeout" | "resources" | "error",
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export interface SandboxRequest {
  /** The independent style's XML. */
  styleXml: string;
  /** Locale XML by tag (the requested one and en-US). */
  locales: Record<string, string>;
  lang: string;
  format: CitationFormat;
  /** "probe": a citation and the bibliography, one per line (an import check). */
  kind: "citation" | "bibliography" | "probe";
  items: CslItem[];
  /** For citations: citeproc's cite items (citeprocCitationItems). */
  cites?: Array<{ id: string; locator?: string; label?: string }>;
}

interface Reply {
  ok: boolean;
  out?: string;
  error?: string;
}

interface Slot {
  key: string;
  worker: Worker;
  busy: boolean;
  dead: boolean;
  langs: Set<string>;
  idle?: ReturnType<typeof setTimeout>;
  pending?: { resolve: (r: Reply) => void; reject: (e: SandboxError) => void; timer: ReturnType<typeof setTimeout> };
}

class SandboxPool {
  config: SandboxConfig = { ...DEFAULTS };
  private readonly slots = new Set<Slot>();
  private waiters: Array<() => void> = [];
  spawned = 0;
  peakWorkers = 0;

  get live(): number {
    return this.slots.size;
  }

  async run(req: SandboxRequest, opts: { timeoutMs?: number; maxHeapMb?: number }): Promise<string> {
    const heap = Math.max(SANDBOX_MIN_HEAP_MB, opts.maxHeapMb ?? this.config.maxHeapMb);
    const key = `${createHash("sha256").update(req.styleXml).digest("hex")}|${heap}`;
    const slot = await this.acquire(key, req.styleXml, heap);
    try {
      if (!slot.langs.has(req.lang)) {
        const r = await this.call(slot, { type: "prepare", lang: req.lang, locales: req.locales }, this.config.startTimeoutMs, "start");
        if (!r.ok) throw new SandboxError(`The citation style could not be loaded: ${r.error ?? "unknown error"}`, "error");
        slot.langs.add(req.lang);
      }
      const { styleXml: _x, locales: _l, ...msg } = req;
      const r = await this.call(slot, { type: "render", ...msg }, opts.timeoutMs ?? this.config.renderTimeoutMs, "render");
      if (!r.ok) throw new SandboxError(`The citation style could not be rendered: ${r.error ?? "unknown error"}`, "error");
      return r.out ?? "";
    } catch (e) {
      this.kill(slot); // timeout, heap or error: never reuse this worker
      throw e;
    } finally {
      this.release(slot);
    }
  }

  private async acquire(key: string, styleXml: string, heap: number): Promise<Slot> {
    for (;;) {
      const mine = [...this.slots].find((s) => s.key === key && !s.dead);
      if (mine && !mine.busy) {
        mine.busy = true;
        if (mine.idle) clearTimeout(mine.idle);
        return mine;
      }
      if (!mine) {
        if (this.slots.size >= this.config.maxWorkers) {
          const idle = [...this.slots].find((s) => !s.busy);
          if (idle) this.kill(idle);
        }
        if (this.slots.size < this.config.maxWorkers) return this.spawn(key, styleXml, heap);
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private spawn(key: string, styleXml: string, heap: number): Slot {
    const worker = new Worker(sandboxWorkerUrl(), {
      workerData: { citeprocFrom: citeprocRequireFrom(), styleXml },
      resourceLimits: { maxOldGenerationSizeMb: heap, maxYoungGenerationSizeMb: Math.min(32, Math.max(1, Math.floor(heap / 4))), stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
    worker.unref(); // an idle warm worker never keeps the process alive
    const slot: Slot = { key, worker, busy: true, dead: false, langs: new Set() };
    const fail = (e: SandboxError) => {
      const p = slot.pending;
      slot.pending = undefined;
      if (p) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      this.kill(slot);
    };
    worker.on("message", (r: Reply) => {
      const p = slot.pending;
      slot.pending = undefined;
      if (p) {
        clearTimeout(p.timer);
        p.resolve(r);
      }
    });
    worker.on("error", (e: Error & { code?: string }) =>
      fail(
        e.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? new SandboxError("The citation style needed too much memory to render.", "resources")
          : new SandboxError(`The citation style could not be rendered: ${e.message.slice(0, 300)}`, "error"),
      ),
    );
    worker.on("exit", (code) => fail(new SandboxError(`The citation style renderer stopped (exit ${code}).`, "error")));
    this.slots.add(slot);
    this.spawned++;
    this.peakWorkers = Math.max(this.peakWorkers, this.slots.size);
    return slot;
  }

  private call(slot: Slot, msg: unknown, timeoutMs: number, phase: "start" | "render"): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      if (slot.dead) return reject(new SandboxError("The citation style renderer stopped.", "error"));
      const timer = setTimeout(() => {
        slot.pending = undefined;
        this.kill(slot);
        reject(new SandboxError(phase === "start" ? "The citation style took too long to load." : "The citation style took too long to render.", "timeout"));
      }, timeoutMs);
      slot.pending = { resolve, reject, timer };
      slot.worker.postMessage(structuredClone(msg));
    });
  }

  private release(slot: Slot): void {
    slot.busy = false;
    if (!slot.dead) {
      const t = setTimeout(() => {
        if (!slot.busy) this.kill(slot);
      }, this.config.idleMs);
      t.unref?.();
      slot.idle = t;
    }
    this.wake();
  }

  private kill(slot: Slot): void {
    if (slot.idle) clearTimeout(slot.idle);
    if (!slot.dead) {
      slot.dead = true;
      void slot.worker.terminate();
    }
    this.slots.delete(slot);
    this.wake();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  async shutdown(): Promise<void> {
    const all = [...this.slots];
    for (const s of all) {
      if (s.idle) clearTimeout(s.idle);
      s.dead = true;
      this.slots.delete(s);
    }
    await Promise.all(all.map((s) => s.worker.terminate()));
    this.wake();
  }
}

const pool = new SandboxPool();

/** Renders `req` in the pool. `timeoutMs` overrides the render timeout, `maxHeapMb` the heap cap. */
export function renderInSandbox(req: SandboxRequest, opts: { timeoutMs?: number; maxHeapMb?: number } = {}): Promise<string> {
  return pool.run(req, opts);
}

/** Sets the pool's limits (anything left out: the defaults). For tests and the app's settings. */
export function configureSandbox(config: Partial<SandboxConfig>): void {
  pool.config = { ...DEFAULTS, ...config };
}

/** Workers started so far, the most alive at once, and those alive now. */
export function sandboxStats(): { spawned: number; peakWorkers: number; live: number } {
  return { spawned: pool.spawned, peakWorkers: pool.peakWorkers, live: pool.live };
}

/** Terminates every worker (app shutdown, tests). */
export function shutdownSandbox(): Promise<void> {
  return pool.shutdown();
}
