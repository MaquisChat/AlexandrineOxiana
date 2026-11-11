/**
 * Profile links the service did not take, kept in storage.session (cleared when the browser closes)
 * per project: a later list for the same project is merged in, never written over (R112).
 */

export interface PendingEntry {
  urls: string[];
  reason: string;
}

export type PendingByProject = Record<string, PendingEntry>;

const isLink = (u: unknown): u is string => typeof u === "string" && u.length <= 2048 && /^https?:\/\//i.test(u);

export function parsePending(v: unknown): PendingByProject {
  const out: PendingByProject = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [projectId, e] of Object.entries(v as Record<string, unknown>)) {
    const entry = e as { urls?: unknown; reason?: unknown } | null;
    if (typeof entry !== "object" || entry === null || !Array.isArray(entry.urls)) continue;
    const urls = entry.urls.filter(isLink);
    if (urls.length) out[projectId] = { urls, reason: typeof entry.reason === "string" ? entry.reason : "" };
  }
  return out;
}

export function addPending(p: PendingByProject, projectId: string, urls: string[], reason: string): PendingByProject {
  const merged = [...new Set([...(p[projectId]?.urls ?? []), ...urls.filter(isLink)])];
  return { ...p, [projectId]: { urls: merged, reason } };
}

export function removePending(p: PendingByProject, projectId: string): PendingByProject {
  const { [projectId]: _gone, ...rest } = p;
  return rest;
}

export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Sends `urls` in pieces of `size`, stopping at the first refusal: what was taken, what was not, and why. */
export async function sendInChunks(urls: string[], size: number, send: (part: string[]) => Promise<void>): Promise<{ sent: string[]; rest: string[]; error?: unknown }> {
  const sent: string[] = [];
  for (const part of chunks(urls, size)) {
    try {
      await send(part);
    } catch (error) {
      return { sent, rest: urls.slice(sent.length), error };
    }
    sent.push(...part);
  }
  return { sent, rest: [] };
}

/**
 * The project's pending list after a send (R116): the links the service took leave it, so a retry never
 * sends them again; those it did not take are merged in with `reason`.
 */
export function afterSend(p: PendingByProject, projectId: string, sent: string[], rest: string[], reason: string): PendingByProject {
  const taken = new Set(sent);
  const left = (p[projectId]?.urls ?? []).filter((u) => !taken.has(u));
  const base = left.length ? { ...p, [projectId]: { urls: left, reason: p[projectId]!.reason } } : removePending(p, projectId);
  return rest.length ? addPending(base, projectId, rest, reason) : base;
}
