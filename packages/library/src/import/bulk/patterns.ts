/**
 * User file-name patterns under a watchdog (R49d). Patterns are vetted when the options are
 * accepted (`vetFileNamePattern`: no nested quantifiers, no backreferences), and then run in one
 * long-lived worker thread per batch, with a time budget per pattern per name (50 ms). A pattern
 * that runs over its budget is disabled for the rest of the batch (the worker is terminated, a new
 * one is started for the others) and the batch report says so.
 */
import { Worker } from "node:worker_threads";
import { parsedFromGroups, patternSubject, type FileNamePattern, type ParsedFileName } from "@ao/core";

export const PATTERN_BUDGET_MS = 50;

// CommonJS, evaluated: no file to resolve in any build or test setup.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const res = workerData.map((r) => { try { return new RegExp(r); } catch { return null; } });
parentPort.on("message", (m) => {
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

  private ensure(): Worker {
    if (this.worker) return this.worker;
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
    return w;
  }

  private drop(w: Worker): void {
    if (this.worker !== w) return;
    this.worker = null;
    for (const [, done] of this.waiting) done(null);
    this.waiting.clear();
  }

  /** Runs one pattern on one subject: its groups, null for no match, or "timeout". */
  private run(i: number, subject: string): Promise<Record<string, string | undefined> | null | "timeout"> {
    const w = this.ensure();
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
    if (w) await w.terminate().catch(() => {});
  }
}
