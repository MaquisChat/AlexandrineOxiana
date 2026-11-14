/**
 * Task Z10 (R274): the scheduler of automatic Zotero syncs. It decides WHEN a linked Zotero library is synced by
 * itself; it never syncs anything itself. A run it starts goes through the service's one door (`run`: the holder of
 * routes/zotero-sync.ts, exactly as a manual run — the same claim, runner, records and events, R274 d). It holds no
 * lock of its own, writes no file, never reads the key (R78) and logs nothing but fixed notes.
 *
 * ONE timer, re-armed after each pass (never an interval: a computer that slept makes one pass on waking, not one per
 * missed tick). A pass reads the settings and the records afresh and starts the due links one after another, never two
 * at once. A link that cannot start now (a run going, its Zotero library taken by an import, a back-off, a pause, a
 * locked project, a read-only library) is not a run: nothing is started, nothing is recorded, and it is looked at again
 * at the next tick (R274 a). A pass with nothing due makes no request and no write.
 *
 * When a link is due (R274 b; the plan's Z10 Accept 1):
 *   - automatic sync is on (settings read at this pass);
 *   - at least 2 minutes since the scheduler was started (the library activated);
 *   - at least `everyMinutes` since the link's last FINISHED record of any kind (manual or automatic, any outcome); a
 *     record dated in the future is taken as finished when first seen, for as long as it is the link's last (R276 b);
 *   - at least `everyMinutes` since the scheduler itself last started a run of the link in this process (whatever the
 *     history says: a record that never reached the history does not make the link due again at the next tick), and at
 *     least 5 minutes of STEADY time since then (R276 c);
 *   - at least `everyMinutes` since the researcher last stopped an automatic run, for every link (R276 a);
 *   - no back-off in force.
 * Each "since" is measured on two clocks, the wall clock and the steady one, and the LONGER counts: a clock set back
 * holds a link for one interval at most (the steady clock goes on; its records count as finished when first seen) and
 * never starts a burst; a computer that slept is due on waking (the wall clock went on while the steady one, on a Mac,
 * stood), after the 5-minute steady floor at most; a wall clock that keeps leaping forward gets one run per 5 minutes.
 */
import type { ZoteroSyncLink, ZoteroSyncRun, ZoteroSyncSettings } from "@ao/library";

/** The default tick (Global Constraints: no tick is ever shorter outside tests). */
export const ZOTERO_SYNC_TICK_MS = 60_000;
/** The first automatic run of a link after the library was activated comes no sooner than this. */
export const ZOTERO_SYNC_FIRST_RUN_MS = 2 * 60_000;
/** R276 c: at least this much STEADY time between two automatic runs of one link, whatever the wall clock does. */
export const ZOTERO_SYNC_STEADY_FLOOR_MS = 5 * 60_000;

/**
 * Why a link cannot start NOW (asked in the same synchronous step as `run`, so nothing can come between):
 *   "busy": a run is going, or its Zotero library is taken by an import — it may be due at any tick;
 *   "held": its project is locked, the library is read-only (or gone): it cannot become due until that changes.
 */
export type ZoteroSyncObstacle = "busy" | "held";

export interface ZoteroSyncSchedulerOptions {
  /** The wall clock. */
  now: () => Date;
  /** The tick (default ZOTERO_SYNC_TICK_MS; shorter only in tests). */
  tickMs?: number;
  /** Starts the link's run through the service's door and settles when it has ended (with its record). */
  run(link: ZoteroSyncLink, trigger: "automatic"): Promise<ZoteroSyncRun>;
  /** This library's settings, read at each pass; undefined when none can be used (damaged, unreadable, newer). */
  settings(): Promise<ZoteroSyncSettings | undefined>;
  /**
   * This library's records, newest first (read at each pass that has automatic sync on); undefined when they cannot be
   * used (a history file written by a newer version, R276 d): then nothing is scheduled.
   */
  history?(): Promise<ZoteroSyncRun[] | undefined>;
  /** Synchronous: why the link cannot start now, or undefined. */
  obstacle?(link: ZoteroSyncLink): ZoteroSyncObstacle | undefined;
  /** The back-off in force (ms since the epoch), given the records just read. */
  backoffUntil?(history: readonly ZoteroSyncRun[]): number | undefined;
  /** Test seam: the monotonic clock (ms; default performance.now). */
  monotonic?: () => number;
  /** A fixed note (no title, no name, no key). */
  debug?(note: string): void;
}

/** A moment on both clocks. */
interface Mark {
  wall: number;
  mono: number;
}

const keyOf = (l: Pick<ZoteroSyncLink, "ref" | "projectId">) => `${l.ref}\u0000${l.projectId}`;

export class ZoteroSyncScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private activated: Mark | undefined;
  /** The pass in flight (stop waits for it), and the way to stop it waiting for a run. */
  private passing: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  /** When this scheduler last started a run of each link, in this process (R274 b). */
  private readonly started = new Map<string, Mark>();
  /**
   * A record dated in the future, by link: its time and when it was first seen. It is taken as finished then, for as
   * long as it is that link's last record (R274 b, R276 b), even once the wall clock has passed its own time.
   */
  private readonly future = new Map<string, { at: number; seen: Mark }>();
  /** R276 a: when the researcher last stopped an automatic run: no automatic run of any link for an interval from then. */
  private stoppedByYou: Mark | undefined;
  /** R276 e: a pass could not read the files and said so; said again only after a pass that succeeded. */
  private failing = false;
  /** What the last pass read (for nextRunAt without fresh data). */
  private last: { settings: ZoteroSyncSettings | undefined; history: readonly ZoteroSyncRun[] } | undefined;
  private readonly tickMs: number;

  constructor(private readonly o: ZoteroSyncSchedulerOptions) {
    this.tickMs = o.tickMs ?? ZOTERO_SYNC_TICK_MS;
  }

  private mark(): Mark {
    return { wall: this.o.now().getTime(), mono: (this.o.monotonic ?? (() => performance.now()))() };
  }

  /** Started at activation: the first run comes no sooner than 2 minutes from now. Starting a started one does nothing. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.activated = this.mark();
    this.last = undefined;
    this.arm();
  }

  /**
   * Stopped (close, switch, before a move, shutdown — before the holder's own stop): no timer is left, a pass in
   * flight starts nothing more and is waited for; a run already started is NOT waited for (the holder stops it next).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.wake?.();
    await this.passing;
  }

  /** Settles when no pass is in flight (tests). */
  async idle(): Promise<void> {
    while (this.passing) await this.passing;
  }

  private arm(): void {
    if (this.stopped || this.timer !== undefined) return;
    const t = setTimeout(() => {
      this.timer = undefined;
      const p = this.pass().finally(() => {
        if (this.passing === p) this.passing = undefined;
        this.arm();
      });
      this.passing = p;
    }, this.tickMs);
    t.unref?.();
    this.timer = t;
  }

  /**
   * One pass: the due links, one after another, each looked at again after the one before has ended. A run that ended
   * `stopped` ends the pass (R276 a); stopped by the researcher, it also holds every link for an interval.
   */
  private async pass(): Promise<void> {
    try {
      await this.passOnce();
      this.failing = false;
    } catch {
      // The settings or the records could not be read: nothing is scheduled at this pass; said once (R276 e).
      if (!this.failing) this.o.debug?.("zotero sync scheduler: the settings or the records could not be read; nothing was started");
      this.failing = true;
    }
  }

  private async passOnce(): Promise<void> {
    for (;;) {
      const settings = await this.o.settings();
      if (this.stopped) return;
      if (!settings?.automatic || !settings.links.length) {
        this.last = { settings, history: [] };
        return;
      }
      const history = this.o.history ? await this.o.history() : [];
      if (this.stopped) return;
      if (!history) {
        // Records this build cannot use (written by a newer version): nothing is scheduled (R276 d).
        this.last = { settings: undefined, history: [] };
        return;
      }
      this.last = { settings, history };
      const now = this.mark();
      // The first link that is due and can start now; the obstacle is asked in the same step as the start.
      const link = settings.links.find((l) => this.dueAt(l, settings, history, now) <= now.wall && this.o.obstacle?.(l) === undefined);
      if (!link || this.stopped) return;
      this.started.set(keyOf(link), now);
      const ran = this.o.run(link, "automatic").then(
        (r) => r,
        () => void this.o.debug?.("zotero sync scheduler: an automatic run ended on an error"),
      );
      // Waits for the run to end, unless the scheduler is stopped meanwhile (the holder then stops the run).
      const ended = await Promise.race([ran, new Promise<undefined>((r) => (this.wake = () => r(undefined)))]);
      this.wake = undefined;
      if (this.stopped) return;
      if (ended?.outcome === "stopped") {
        // R276 a: the researcher's Stop holds every link for an interval from now; any other stop ends this pass only.
        if (ended.reason === "stopped-by-you") this.stoppedByYou = this.mark();
        return;
      }
    }
  }

  /** The wall time (ms) from which the link is due, by the rules above (back-off included); Infinity when it cannot be. */
  private dueAt(link: ZoteroSyncLink, settings: ZoteroSyncSettings, history: readonly ZoteroSyncRun[], now: Mark): number {
    if (link.paused || !this.activated) return Infinity;
    const every = settings.everyMinutes * 60_000;
    /** The wall time at which `need` ms will have passed since `m`, the longer of the two clocks counting. */
    const after = (m: Mark, need: number) => now.wall + Math.max(0, need - Math.max(now.wall - m.wall, now.mono - m.mono));
    const key = keyOf(link);
    let due = after(this.activated, ZOTERO_SYNC_FIRST_RUN_MS);
    const own = this.started.get(key);
    // R276 c: and never sooner than the steady floor after the link's last automatic run, whatever the wall clock says.
    if (own) due = Math.max(due, after(own, every), now.wall + Math.max(0, ZOTERO_SYNC_STEADY_FLOOR_MS - (now.mono - own.mono)));
    if (this.stoppedByYou) due = Math.max(due, after(this.stoppedByYou, every));
    let finished = -Infinity;
    for (const r of history) {
      if (r.ref !== link.ref || r.projectId !== link.projectId || r.finishedAt === undefined) continue;
      const t = Date.parse(r.finishedAt);
      if (Number.isFinite(t)) finished = Math.max(finished, t);
    }
    const pinned = this.future.get(key);
    if (pinned && pinned.at === finished) {
      // Still the link's last record: finished when first seen (R276 b), also once the wall clock has passed its time.
      due = Math.max(due, after(pinned.seen, every));
    } else if (finished > now.wall) {
      // Dated in the future (the clock was set back): taken as finished now, when first seen.
      this.future.set(key, { at: finished, seen: now });
      due = Math.max(due, after(now, every));
    } else {
      this.future.delete(key);
      if (finished > -Infinity) due = Math.max(due, finished + every);
    }
    const backoff = this.o.backoffUntil?.(history);
    if (backoff !== undefined) due = Math.max(due, backoff);
    return due;
  }

  /**
   * The earliest time at which this scheduler would start a run for any link ("not before": a due link may still wait
   * for a run going or an import), from `fresh` settings and records when given, else from what the last pass read.
   * Undefined when the scheduler is stopped, automatic sync is off, or no link can become due (every link paused or
   * held: its project locked, the library read-only; no settings that can be used).
   */
  nextRunAt(fresh?: { settings: ZoteroSyncSettings | undefined; history: readonly ZoteroSyncRun[] }): Date | undefined {
    if (this.stopped) return undefined;
    const seen = fresh ?? this.last;
    const settings = seen?.settings;
    if (!seen || !settings?.automatic) return undefined;
    const now = this.mark();
    let best = Infinity;
    for (const l of settings.links) {
      if (this.o.obstacle?.(l) === "held") continue;
      best = Math.min(best, this.dueAt(l, settings, seen.history, now));
    }
    return Number.isFinite(best) ? new Date(Math.max(best, now.wall)) : undefined;
  }
}
