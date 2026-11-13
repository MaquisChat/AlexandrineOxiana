// stub (tests first)
import type { HttpClient } from "../lookup/http.js";
import type { IndexDb } from "../index/db.js";
import type { Repo } from "../repo/repo.js";
import type { FindEntry, FindState, SearchSettings } from "./types.js";

export const FIND_CONCURRENCY = 2;
export const FIND_RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 900_000];
export const FIND_TOOL = "find-and-acquire";
export const FIND_ENTRY_KEY = "find-entry";
export const runnerSeams: { beforeCreate?: () => void; afterCreate?: () => void } = {};
export class FindEntryStateError extends Error {}
export class FindRunnerClosedError extends Error {}

export interface FindTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FindRunnerDeps {
  repo: Repo;
  index: IndexDb;
  http: HttpClient;
  settings: () => Promise<SearchSettings>;
  checkEverything: () => boolean;
  now?: () => Date;
  onChange(e: { projectId: string; entryId: string; state: FindState }): void;
  timers?: FindTimers;
  debug?: (note: string) => void;
}

export interface FindRunner {
  add(projectId: string, lines: string[], collectionId?: string): Promise<{ added: FindEntry[]; mergedLines: number }>;
  choose(projectId: string, entryId: string, candidateId: string | null): Promise<FindEntry>;
  confirmDuplicate(projectId: string, entryId: string, same: boolean): Promise<FindEntry>;
  addHereAsWell(projectId: string, entryId: string): Promise<FindEntry>;
  retry(projectId: string, entryId: string): Promise<FindEntry>;
  remove(projectId: string, entryId: string): Promise<void>;
  resume(projectId: string): void;
  stop(projectId: string): void;
  stopAll(): Promise<void>;
  elsewhere(projectId: string, entryId: string): Promise<{ projectId: string; sourceId: string } | null>;
  lockedNotChecked(): number;
}

export function createFindRunner(_deps: FindRunnerDeps): FindRunner {
  throw new Error("not built");
}
