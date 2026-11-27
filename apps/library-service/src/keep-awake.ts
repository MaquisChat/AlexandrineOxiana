/**
 * Keeping the Mac awake while downloads or transcriptions run (whole channels, Task 7): macOS's own
 * `/usr/bin/caffeinate -i -w <service pid>`, started from the service. `-i` keeps the system from idle sleep
 * (the screen may still switch off; closing the lid still sleeps the Mac); `-w` ends it when the service's
 * process ends, so it is never left behind even if the service dies. At most one process at a time; on any
 * other platform nothing is done. `spawn`, the platform, the pid, the log and the clock are injectable for tests.
 *
 * R692 (M5): a caffeinate that fails to start is logged once, and tried again only at the next change (no longer
 * wanted, then wanted again), never at every publish. One that exits while still wanted is started again at once,
 * unless it had run less than RESTART_AFTER_MS: then it is logged and waits for the next change (no restart storm).
 * R693: while still wanted, it is also tried again at the first update at least RETRY_AFTER_MS after the last
 * failure, so a run of days is not left without it.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export const CAFFEINATE = "/usr/bin/caffeinate";
/** A caffeinate that ran at least this long before it exited is started again at once. */
export const RESTART_AFTER_MS = 10_000;
/** After a failure, while still wanted, it is tried again at the first update at least this long after (R693). */
export const RETRY_AFTER_MS = 60_000;

export class KeepAwake {
  private readonly platform: NodeJS.Platform;
  private readonly spawn: typeof nodeSpawn;
  private readonly pid: number;
  private readonly log: { warn(o: object, msg?: string): void } | undefined;
  private readonly now: () => number;
  private child: ChildProcess | undefined;
  private wanted = false;
  /** Failed (to start, or died soon after): nothing is tried until wanted changes. */
  private held = false;
  private failedAt = 0;

  constructor(opts: { platform?: NodeJS.Platform; spawn?: typeof nodeSpawn; pid?: number; log?: { warn(o: object, msg?: string): void }; now?: () => number } = {}) {
    this.platform = opts.platform ?? process.platform;
    this.spawn = opts.spawn ?? nodeSpawn;
    this.pid = opts.pid ?? process.pid;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
  }

  /** Whether a caffeinate process of this service is running now. */
  get running(): boolean {
    return this.child !== undefined;
  }

  /** Starts the one process when wanted (macOS only), ends it when not. */
  update(wanted: boolean): void {
    if (this.platform !== "darwin") return;
    this.wanted = wanted;
    if (!wanted) this.held = false; // a change: what failed may be tried again next time
    else if (this.held && this.now() - this.failedAt >= RETRY_AFTER_MS) this.held = false;
    if (wanted && !this.child && !this.held) this.start();
    else if (!wanted && this.child) {
      const child = this.child;
      this.child = undefined;
      try {
        child.kill("SIGTERM");
      } catch {
        // already ended
      }
    }
  }

  stop(): void {
    this.update(false);
  }

  private start(): void {
    let child: ChildProcess;
    try {
      child = this.spawn(CAFFEINATE, ["-i", "-w", String(this.pid)], { stdio: "ignore" });
    } catch (err) {
      this.failed(err, "keeping the Mac awake could not start");
      return; // not there: the Mac sleeps as it would
    }
    this.child = child;
    const startedAt = this.now();
    child.on("error", (err) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.failed(err, "keeping the Mac awake could not start");
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return; // ended because it was no longer wanted, or already told
      this.child = undefined;
      if (!this.wanted) return;
      if (this.now() - startedAt >= RESTART_AFTER_MS) {
        this.log?.warn({ code, signal }, "keeping the Mac awake stopped");
        this.start();
      } else this.failed({ code, signal }, "keeping the Mac awake stopped");
    });
    child.unref?.();
  }

  private failed(err: unknown, msg: string): void {
    this.held = true;
    this.failedAt = this.now();
    this.log?.warn({ err: err instanceof Error ? err.message : err }, msg);
  }
}
