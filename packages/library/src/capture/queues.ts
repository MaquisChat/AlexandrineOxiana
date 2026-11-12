/**
 * The capture queues a running service knows of, readable again (Task 63, R146): what each queue is
 * (links or a profile run, who started it), its items' outcomes in order, and how it ended. Memory
 * only: nothing here is written to the library, and a restart forgets it (the sources a queue saved
 * are in the library).
 *
 * Bounded (the limits are in @ao/shared): a finished queue is kept for CAPTURE_QUEUE_KEEP_MS and at
 * most CAPTURE_QUEUES_KEPT finished queues are kept in all; a queue keeps at most CAPTURE_ITEMS_KEPT
 * items; a list answer holds at most CAPTURE_QUEUES_LISTED summaries. Running queues are always kept.
 *
 * Outcomes are carried through with their known fields only (url, status, sourceId, the library's
 * own sentence, its code and a missing tool's id); a queue's error is kept as the kind of error only,
 * never its message (which could name a path).
 */
import {
  CAPTURE_ITEMS_KEPT,
  CAPTURE_QUEUE_KEEP_MS,
  CAPTURE_QUEUES_KEPT,
  CAPTURE_QUEUES_LISTED,
  type CaptureItemOutcome,
  type CaptureQueueDetail,
  type CaptureQueueKind,
  type CaptureQueueSummary,
  type CaptureRunReport,
  type CaptureStartedBy,
} from "@ao/shared";
import type { CaptureOutcome } from "./link-capture.js";
import { classifyUrl } from "./platforms.js";
import type { ProfileCaptureReport } from "./profile-capture.js";

export interface CaptureQueueRegistryOptions {
  now?: () => number;
}

interface Entry {
  queueId: string;
  projectId: string;
  kind: CaptureQueueKind;
  startedBy: CaptureStartedBy;
  url?: string;
  urls?: string[];
  /** Canonical keys of `urls` (or of the profile's address), for the running-address check. */
  keys: string[];
  done: number;
  total: number | null;
  finished: boolean;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  report?: CaptureRunReport;
  items: CaptureItemOutcome[];
  itemsOmitted: number;
}

/** The address's canonical form (tracking parameters, host case and short forms set aside). */
const keyOf = (u: string): string => classifyUrl(u).canonicalUrl;

function outcomeOf(o: CaptureOutcome): CaptureItemOutcome {
  return {
    url: o.url,
    status: o.status,
    ...(typeof o.sourceId === "string" ? { sourceId: o.sourceId } : {}),
    ...(typeof o.reason === "string" ? { reason: o.reason } : {}),
    ...(typeof o.errorCode === "string" ? { errorCode: o.errorCode } : {}),
    ...(typeof o.tool === "string" ? { tool: o.tool } : {}),
  };
}

function reportOf(r: ProfileCaptureReport): CaptureRunReport {
  const out: CaptureRunReport = {
    status: r.status,
    listComplete: r.listComplete,
    created: r.created,
    duplicates: r.duplicates,
    incomplete: r.incomplete,
    failed: r.failed,
    newlyUnavailable: r.newlyUnavailable,
    reappeared: r.reappeared,
    edited: r.edited,
  };
  if (r.profileSourceId !== undefined) out.profileSourceId = r.profileSourceId;
  if (r.batchId !== undefined) out.batchId = r.batchId;
  if (r.errorCode !== undefined) out.errorCode = r.errorCode;
  if (r.reason !== undefined) out.reason = r.reason;
  if (r.tool !== undefined) out.tool = r.tool;
  return out;
}

function errorName(err: unknown): string {
  if (err instanceof Error) return /^\w{1,64}$/.test(err.name) ? err.name : "Error";
  if (typeof err === "string") return /^(\w{1,64})/.exec(err)?.[1] ?? "Error";
  return "Error";
}

export class CaptureQueueRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(opts: CaptureQueueRegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** A links queue (again: a queue carried on after a move keeps what it had). */
  startLinks(queueId: string, projectId: string, urls: string[], startedBy: CaptureStartedBy): void {
    this.prune();
    if (this.entries.has(queueId)) return;
    this.entries.set(queueId, this.entry(queueId, projectId, "links", startedBy, { urls: [...urls], keys: urls.map(keyOf), total: urls.length }));
  }

  /** A profile run of `url`. */
  startProfile(queueId: string, projectId: string, url: string, startedBy: CaptureStartedBy): void {
    this.prune();
    if (this.entries.has(queueId)) return;
    this.entries.set(queueId, this.entry(queueId, projectId, "profile", startedBy, { url, keys: [keyOf(url)], total: null }));
  }

  /** Item `done` (counted from 1 over the whole queue) has finished with `outcome`. */
  progress(queueId: string, done: number, total: number | undefined, outcome?: CaptureOutcome): void {
    const e = this.entries.get(queueId);
    if (!e || !Number.isInteger(done) || done < 1) return;
    e.done = Math.max(e.done, done);
    if (typeof total === "number" && Number.isInteger(total) && total >= 0) e.total = total;
    if (!outcome) return;
    const i = done - 1;
    if (i < CAPTURE_ITEMS_KEPT) {
      while (e.items.length < i) e.items.push({ url: "", status: "unknown" });
      e.items[i] = outcomeOf(outcome);
    } else e.itemsOmitted = Math.max(e.itemsOmitted, done - CAPTURE_ITEMS_KEPT);
  }

  /** The queue has ended: with a profile run's report, or stopped as a whole by `error`. */
  finish(queueId: string, end: { report?: ProfileCaptureReport; error?: unknown }): void {
    const e = this.entries.get(queueId);
    if (!e) return;
    e.finished = true;
    e.finishedAt = this.now();
    if (end.error !== undefined) e.error = errorName(end.error);
    if (end.report) e.report = reportOf(end.report);
    this.prune();
  }

  /** Whether the queue is known and still running. */
  running(queueId: string): boolean {
    const e = this.entries.get(queueId);
    return !!e && !e.finished;
  }

  /** Queues kept now (tests, diagnostics). */
  size(): number {
    this.prune();
    return this.entries.size;
  }

  /** The project's queues: running first (newest first), then the most recently finished; summaries only. */
  list(projectId: string): CaptureQueueSummary[] {
    this.prune();
    const mine = [...this.entries.values()].filter((e) => e.projectId === projectId);
    const running = mine.filter((e) => !e.finished).sort((a, b) => b.startedAt - a.startedAt);
    const finished = mine.filter((e) => e.finished).sort((a, b) => b.finishedAt! - a.finishedAt!);
    return [...running, ...finished].slice(0, CAPTURE_QUEUES_LISTED).map((e) => this.summary(e));
  }

  /** One queue of `projectId` with its items; undefined for another project's, an unknown or a forgotten one. */
  detail(projectId: string, queueId: string): CaptureQueueDetail | undefined {
    this.prune();
    const e = this.entries.get(queueId);
    if (!e || e.projectId !== projectId) return undefined;
    return {
      ...this.summary(e),
      ...(e.urls ? { urls: [...e.urls] } : {}),
      items: e.items.map((i) => ({ ...i })),
      ...(e.itemsOmitted ? { itemsOmitted: e.itemsOmitted } : {}),
    };
  }

  /**
   * The running queue of `projectId` in which one of `urls` is still waiting or being captured (a
   * links queue's addresses not yet finished, or a profile run's own address), by canonical form.
   */
  runningConflict(projectId: string, urls: string[]): string | undefined {
    const wanted = new Set(urls.map(keyOf));
    for (const e of this.entries.values()) {
      if (e.finished || e.projectId !== projectId) continue;
      const pending = e.kind === "links" ? e.keys.slice(e.done) : e.keys;
      if (pending.some((k) => wanted.has(k))) return e.queueId;
    }
    return undefined;
  }

  private entry(queueId: string, projectId: string, kind: CaptureQueueKind, startedBy: CaptureStartedBy, x: { url?: string; urls?: string[]; keys: string[]; total: number | null }): Entry {
    return { queueId, projectId, kind, startedBy, ...x, done: 0, finished: false, startedAt: this.now(), items: [], itemsOmitted: 0 };
  }

  private summary(e: Entry): CaptureQueueSummary {
    return {
      queueId: e.queueId,
      projectId: e.projectId,
      kind: e.kind,
      startedBy: e.startedBy,
      ...(e.url !== undefined ? { url: e.url } : {}),
      done: e.done,
      total: e.total,
      finished: e.finished,
      startedAt: new Date(e.startedAt).toISOString(),
      ...(e.finishedAt !== undefined ? { finishedAt: new Date(e.finishedAt).toISOString() } : {}),
      ...(e.error !== undefined ? { error: e.error } : {}),
      ...(e.report ? { report: { ...e.report } } : {}),
    };
  }

  /** Forgets finished queues older than CAPTURE_QUEUE_KEEP_MS, then the oldest finished beyond CAPTURE_QUEUES_KEPT. */
  private prune(): void {
    const t = this.now();
    const finished: Entry[] = [];
    for (const e of this.entries.values()) {
      if (!e.finished) continue;
      if (t - e.finishedAt! > CAPTURE_QUEUE_KEEP_MS) this.entries.delete(e.queueId);
      else finished.push(e);
    }
    if (finished.length <= CAPTURE_QUEUES_KEPT) return;
    finished.sort((a, b) => a.finishedAt! - b.finishedAt!);
    for (const e of finished.slice(0, finished.length - CAPTURE_QUEUES_KEPT)) this.entries.delete(e.queueId);
  }
}
