export interface Deps {
  clock: () => Date;
  deviceId: string;
  hostname: string;
  pid: number;
  isPidAlive: (pid: number) => boolean;
  appConfigDir: string;
  /** Heartbeat timer; defaults to the global setInterval (unref'd). */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Wait after writing a lock before re-reading it (default 1500 ms). */
  settleMs?: number;
}
