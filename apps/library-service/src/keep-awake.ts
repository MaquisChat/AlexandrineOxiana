/**
 * Keeping the Mac awake while downloads or transcriptions run (whole channels, Task 7): macOS's own
 * `/usr/bin/caffeinate -i -w <service pid>`, started from the service. `-i` keeps the system from idle sleep
 * (the screen may still switch off; closing the lid still sleeps the Mac); `-w` ends it when the service's
 * process ends, so it is never left behind even if the service dies. At most one process at a time; on any
 * other platform nothing is done. `spawn`, the platform and the pid are injectable for tests.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export const CAFFEINATE = "/usr/bin/caffeinate";

export class KeepAwake {
  private readonly platform: NodeJS.Platform;
  private readonly spawn: typeof nodeSpawn;
  private readonly pid: number;
  private child: ChildProcess | undefined;

  constructor(opts: { platform?: NodeJS.Platform; spawn?: typeof nodeSpawn; pid?: number } = {}) {
    this.platform = opts.platform ?? process.platform;
    this.spawn = opts.spawn ?? nodeSpawn;
    this.pid = opts.pid ?? process.pid;
  }

  /** Whether a caffeinate process of this service is running now. */
  get running(): boolean {
    return this.child !== undefined;
  }

  /** Starts the one process when wanted (macOS only), ends it when not. */
  update(wanted: boolean): void {
    if (this.platform !== "darwin") return;
    if (wanted && !this.child) {
      let child: ChildProcess;
      try {
        child = this.spawn(CAFFEINATE, ["-i", "-w", String(this.pid)], { stdio: "ignore" });
      } catch {
        return; // not there: the Mac sleeps as it would
      }
      this.child = child;
      const gone = () => {
        if (this.child === child) this.child = undefined;
      };
      child.on("exit", gone);
      child.on("error", gone);
      child.unref?.();
    } else if (!wanted && this.child) {
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
}
