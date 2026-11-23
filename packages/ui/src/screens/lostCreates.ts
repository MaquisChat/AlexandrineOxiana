/**
 * FR-194 (R461 b): projects whose creation the app could not tell made or not when their library closed. The library
 * chooser shows one notice for each until the researcher presses "Got it". They are kept in this module's memory only:
 * they outlive the library screen (and a visit to another screen) but not a reload or the app's closing, and nothing is
 * written to disk or sent to the service.
 */
import { useSyncExternalStore } from "react";

export interface LostCreate {
  key: string;
  /** The project's name as the researcher typed it. */
  project: string;
  /** The library's name. */
  library: string;
}

let list: readonly LostCreate[] = [];
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of listeners) l();
};

/** Notes a project to look for; the same project in the same library is noted once. */
export function noteLostCreate(libraryId: string, library: string, project: string): void {
  const key = JSON.stringify([libraryId, project]);
  if (list.some((x) => x.key === key)) return;
  list = [...list, { key, project, library }];
  changed();
}

export function dismissLostCreate(key: string): void {
  list = list.filter((x) => x.key !== key);
  changed();
}

/** Forgets them all (tests). */
export function clearLostCreates(): void {
  list = [];
  changed();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useLostCreates = (): readonly LostCreate[] => useSyncExternalStore(subscribe, () => list);
