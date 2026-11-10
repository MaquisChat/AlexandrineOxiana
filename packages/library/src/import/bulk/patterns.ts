/**
 * User file-name patterns under a watchdog (R49d). Patterns are vetted when the options are
 * accepted (`vetFileNamePattern`: no nested quantifiers, no backreferences), and then run in one
 * long-lived worker thread per batch, with a time budget per pattern per name (50 ms). A pattern
 * that runs over its budget is disabled for the rest of the batch (the worker is terminated, a new
 * one is started for the others) and the batch report says so. The clock of a run starts only
 * once the worker is online and has answered a warm-up message (at start and after every restart),
 * so starting a thread never counts against a pattern.
 */
import { Worker } from "node:worker_threads";
import { parsedFromGroups, patternSubject, type FileNamePattern, type ParsedFileName } from "@ao/core";

export const PATTERN_BUDGET_MS = 50;
/** How long a worker may take to come online and answer its warm-up. */
const STARTUP_MS = 10_000;

// CommonJS, evaluated: no file to resolve in any build or test setup.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const res = workerData.map((r) => { try { return new RegExp(r); } catch { return null; } });
parentPort.on("message", (m) => {
  if (m.i < 0) {
    // Warm-up: one match with a fixed (safe) expression through the same path, so the first timed
    // run measures the user's pattern only. User patterns are never run untimed.
    /^(?<title>.+)$/.exec("warm-up");
    parentPort.postMessage({ seq: m.seq, groups: null });
    return;
  }
  const re = res[m.i];
  let groups = null;
  if (re) {
    const x = re.exec(m.subject);
    if (x && x.groups) groups = Object.assign({}, x.groups);
  }
  parentPort.postMessage({ seq: m.seq, groups });
});
`;

export interface PatternMatch {
  parsed?: ParsedFileName;
  /** Ids of patterns that ran over budget on this name (now disabled). */
  timedOut: string[];
}

export class PatternWatchdog {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly waiting = new Map<number, (groups: Record<string, string | undefined> | null) => void>();
  /** Pattern ids disabled for the rest of the batch. */
  readonly disabled = new Set<string>();

  constructor(
    private readonly patterns: FileNamePattern[],
    private readonly budgetMs = PATTERN_BUDGET_MS,
  ) {}

  get active(): boolean {
    return this.patterns.some((p) => !this.disabled.has(p.id));
  }

  private ready: Promise<Worker | null> | null = null;

  /** The worker, online and warmed up (null when it could not be started: patterns are then off). */
  private ensure(): Promise<Worker | null> {
    if (this.worker && this.ready) return this.ready;
    const w = new Worker(WORKER_SOURCE, { eval: true, workerData: this.patterns.map((p) => p.regex) });
    w.unref();
    w.on("message", (m: { seq: number; groups: Record<string, string | undefined> | null }) => {
      const done = this.waiting.get(m.seq);
      this.waiting.delete(m.seq);
      done?.(m.groups);
    });
    w.on("error", () => this.drop(w));
    w.on("exit", () => this.drop(w));
    this.worker = w;
    this.ready = (async () => {
      const online = await Promise.race([
        new Promise<boolean>((r) => w.once("online", () => r(true))),
        new Promise<boolean>((r) => w.once("exit", () => r(false))),
        new Promise<boolean>((r) => setTimeout(() => r(false), STARTUP_MS).unref()),
      ]);
      if (!online) return null;
      const seq = ++this.seq;
      const warmed = await Promise.race([
        new Promise<boolean>((r) => {
          this.waiting.set(seq, () => r(this.worker === w));
          w.postMessage({ seq, i: -1, subject: "" });
        }),
        new Promise<boolean>((r) => setTimeout(() => r(false), STARTUP_MS).unref()),
      ]);
      return warmed ? w : null;
    })();
    return this.ready;
  }

  private drop(w: Worker): void {
    if (this.worker !== w) return;
    this.worker = null;
    this.ready = null;
    for (const [, done] of this.waiting) done(null);
    this.waiting.clear();
  }

  /** Runs one pattern on one subject: its groups, null for no match, or "timeout". */
  private async run(i: number, subject: string): Promise<Record<string, string | undefined> | null | "timeout" | "unavailable"> {
    const w = await this.ensure();
    if (!w) {
      await this.close();
      return "unavailable";
    }
    const seq = ++this.seq;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v: Record<string, string | undefined> | null | "timeout") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiting.delete(seq);
        resolve(v);
      };
      this.waiting.set(seq, (g) => finish(g));
      const timer = setTimeout(() => {
        // A busy main thread may fire the timer late with the answer already queued: look once more.
        setImmediate(() => {
          if (settled) return;
          finish("timeout");
          if (this.worker === w) {
            this.worker = null;
            this.ready = null;
            void w.terminate().catch(() => {});
          }
        });
      }, this.budgetMs);
      w.postMessage({ seq, i, subject });
    });
  }

  /** The first enabled user pattern's parse of `fileName` (extension stripped, length-capped), if any. */
  async match(fileName: string): Promise<PatternMatch> {
    const timedOut: string[] = [];
    const subject = patternSubject(fileName);
    for (let i = 0; i < this.patterns.length; i++) {
      const p = this.patterns[i]!;
      if (this.disabled.has(p.id)) continue;
      const r = await this.run(i, subject);
      if (r === "unavailable") {
        // The worker thread could not start: user patterns are off for this batch (built-ins still run).
        for (const q of this.patterns) if (!this.disabled.has(q.id)) {
          this.disabled.add(q.id);
          timedOut.push(q.id);
        }
        break;
      }
      if (r === "timeout") {
        this.disabled.add(p.id);
        timedOut.push(p.id);
        continue;
      }
      const parsed = parsedFromGroups(r ?? undefined);
      if (parsed) return { parsed, timedOut };
    }
    return { timedOut };
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.ready = null;
    if (w) await w.terminate().catch(() => {});
  }
}
