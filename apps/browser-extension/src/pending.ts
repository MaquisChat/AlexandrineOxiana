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
