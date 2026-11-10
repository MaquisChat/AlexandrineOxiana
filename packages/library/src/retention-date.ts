/** Retention dates (R92): read in the project's time zone setting, else UTC. */
import type { Repo } from "./repo/repo.js";

/** The calendar date (YYYY-MM-DD) of `now` in `tz`. */
function localDate(now: Date, tz?: string): string {
  return new Intl.DateTimeFormat("en-CA", { ...(tz ? { timeZone: tz } : {}), year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Whether the retention date has come at `now` (R92): a date counts from its start in the project's
 * time zone (`project.timeZone`, else UTC); a time from that instant, read as UTC when it has no offset.
 */
export function isDue(date: string, now: Date, tz: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) return localDate(now, tz) >= date;
  const t = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/u.test(date) ? date : `${date}Z`);
  return !Number.isNaN(t) && now.getTime() >= t;
}

/** The project's time zone setting if it names a real zone, else UTC. */
export function projectTimeZone(repo: Repo, projectId: string): string {
  const tz = repo.getProject(projectId).timeZone;
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

