import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./fs/atomic.js";
import type { Deps } from "./deps.js";

export interface LockInfo {
  deviceId: string;
  hostname: string;
  pid: number;
  openedAt: string;
  heartbeatAt: string;
}

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 120_000;
const DEFAULT_SETTLE_MS = 1500;

const lockPath = (root: string) => join(root, ".lock");

function isLockInfo(v: unknown): v is LockInfo {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.deviceId === "string" &&
    typeof o.hostname === "string" &&
    typeof o.pid === "number" &&
    typeof o.openedAt === "string" &&
    typeof o.heartbeatAt === "string"
  );
}

/** Returns the lock, null if absent, or "corrupt" if it cannot be parsed. */
export async function readLock(root: string): Promise<LockInfo | null | "corrupt"> {
  let raw: string;
  try {
    raw = await readFile(lockPath(root), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "corrupt";
  }
  try {
    const v: unknown = JSON.parse(raw);
    return isLockInfo(v) ? v : "corrupt";
  } catch {
    return "corrupt";
  }
}

const isOurs = (l: LockInfo, deps: Deps) => l.deviceId === deps.deviceId && l.pid === deps.pid;

function isStale(l: LockInfo, deps: Deps): boolean {
  const hb = Date.parse(l.heartbeatAt);
  if (Number.isNaN(hb) || deps.clock().getTime() - hb > STALE_MS) return true;
  return l.hostname === deps.hostname && !deps.isPidAlive(l.pid);
}

/** Pure read: is the library currently held by someone else? Writes nothing. */
export async function peekLock(root: string, deps: Deps): Promise<LockInfo | null> {
  const l = await readLock(root);
  if (l === null || l === "corrupt" || isOurs(l, deps) || isStale(l, deps)) return null;
  return l;
}

export class LockNotWritableError extends Error {
  constructor(root: string, cause: unknown) {
    super(`Cannot write the lock in ${root}`, { cause });
    this.name = "LockNotWritableError";
  }
}

export const NOT_WRITABLE_CODES = new Set(["EACCES", "EROFS", "EPERM"]);

export async function acquireLock(
  root: string,
  deps: Deps,
): Promise<{ acquired: true } | { acquired: false; holder: LockInfo }> {
  // Attempt twice: if the lock vanishes during the settle window (its holder
  // released it), try once more instead of giving up.
  let last: LockInfo | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await readLock(root);
    if (existing !== null && existing !== "corrupt" && !isOurs(existing, deps) && !isStale(existing, deps)) {
      return { acquired: false, holder: existing };
    }
    const nowIso = deps.clock().toISOString();
    const mine: LockInfo = {
      deviceId: deps.deviceId,
      hostname: deps.hostname,
      pid: deps.pid,
      openedAt: nowIso,
      heartbeatAt: nowIso,
    };
    last = mine;
    try {
      await writeFileAtomic(lockPath(root), JSON.stringify(mine));
    } catch (err) {
      if (NOT_WRITABLE_CODES.has((err as NodeJS.ErrnoException).code ?? "")) {
        throw new LockNotWritableError(root, err);
      }
      throw err;
    }
    // Two devices may take over at once; the last writer wins. Wait, re-read,
    // and only proceed if the lock is still ours.
    const settle = deps.settleMs ?? DEFAULT_SETTLE_MS;
    if (settle > 0) await new Promise((r) => setTimeout(r, settle));
    const after = await readLock(root);
    if (after === null || after === "corrupt") continue;
    if (!isOurs(after, deps)) return { acquired: false, holder: after };
    return { acquired: true };
  }
  return { acquired: false, holder: last! };
}

export interface Heartbeat {
  /** Stops the timer now; resolves once any in-flight tick has finished. */
  stop(): Promise<void>;
}

/**
 * Starts the 30 s heartbeat. `onLost(holder)` fires once if the lock now
 * belongs to someone else (holder), or if we could not refresh it for longer
 * than the stale window (holder = null); the heartbeat then stops itself.
 * Across cloud-sync delay this detection is best-effort: another device's
 * lock may arrive late, so a brief window of two writers is possible.
 */
export function startHeartbeat(
  root: string,
  deps: Deps,
  onLost?: (holder: LockInfo | null) => void,
): Heartbeat {
  const set =
    deps.setInterval ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    });
  const clear = deps.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));
  let inflight: Promise<void> | undefined;
  let stopped = false;
  let lastOk = deps.clock().getTime();
  let handle: unknown;
  const stopTimer = () => {
    if (stopped) return;
    stopped = true;
    clear(handle);
  };
  const lose = (holder: LockInfo | null) => {
    stopTimer();
    onLost?.(holder);
  };
  const tick = async () => {
    try {
      const l = await readLock(root);
      if (stopped) return;
      if (l !== null && l !== "corrupt" && !isOurs(l, deps)) return lose(l);
      const base = l === null || l === "corrupt" ? undefined : l;
      const nowIso = deps.clock().toISOString();
      const next: LockInfo = base
        ? { ...base, heartbeatAt: nowIso }
        : { deviceId: deps.deviceId, hostname: deps.hostname, pid: deps.pid, openedAt: nowIso, heartbeatAt: nowIso };
      await writeFileAtomic(lockPath(root), JSON.stringify(next));
      lastOk = deps.clock().getTime();
    } catch {
      if (!stopped && deps.clock().getTime() - lastOk > STALE_MS) lose(null);
    }
  };
  // The callback returns the tick promise so tests can await it.
  handle = set((() => {
    if (stopped || inflight) return;
    inflight = tick().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }) as () => void, HEARTBEAT_MS);
  return {
    async stop() {
      stopTimer();
      await inflight;
    },
  };
}

/** Removes the lock only if it is still ours. */
export async function releaseLock(root: string, deps: Deps): Promise<void> {
  const l = await readLock(root);
  if (l === null || l === "corrupt" || !isOurs(l, deps)) return;
  try {
    await unlink(lockPath(root));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
