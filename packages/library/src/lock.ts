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

export async function acquireLock(
  root: string,
  deps: Deps,
): Promise<{ acquired: true } | { acquired: false; holder: LockInfo }> {
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
  await writeFileAtomic(lockPath(root), JSON.stringify(mine));
  // Two devices may take over at once; the last writer wins. Wait, re-read,
  // and only proceed if the lock is still ours.
  const settle = deps.settleMs ?? DEFAULT_SETTLE_MS;
  if (settle > 0) await new Promise((r) => setTimeout(r, settle));
  const after = await readLock(root);
  if (after === null || after === "corrupt") {
    return { acquired: false, holder: mine };
  }
  if (!isOurs(after, deps)) return { acquired: false, holder: after };
  return { acquired: true };
}

/** Starts the 30 s heartbeat; returns a function that stops it. */
export function startHeartbeat(root: string, deps: Deps): () => void {
  const set =
    deps.setInterval ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    });
  const clear = deps.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));
  let busy = false;
  const handle = set(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const l = await readLock(root);
        if (l === null || l === "corrupt" || !isOurs(l, deps)) return;
        await writeFileAtomic(
          lockPath(root),
          JSON.stringify({ ...l, heartbeatAt: deps.clock().toISOString() }),
        );
      } catch {
        // transient failure (offline drive); the next tick retries
      } finally {
        busy = false;
      }
    })();
  }, HEARTBEAT_MS);
  return () => clear(handle);
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
