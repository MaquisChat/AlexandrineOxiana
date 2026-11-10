/**
 * One in-process queue per project for everything that stores imported items (R81 I4): drag-and-
 * drop attach, watched folders and Bulk Import take turns, so two of them cannot both decide that
 * the same file is new and both store it. Other processes are kept out by the library lock.
 *
 * Re-entrant: work already running in a project's queue (e.g. a batch storing a group, then its
 * items one by one) runs directly instead of waiting for itself.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const held = new AsyncLocalStorage<ReadonlySet<string>>();
const tails = new WeakMap<object, Map<string, Promise<unknown>>>();
const turns = new WeakMap<object, Map<string, number>>();

/** How many turns the project's queue has started (a caller can tell whether anyone else stored since its own last turn). */
export function storeTurn(owner: object, projectId: string): number {
  return turns.get(owner)?.get(projectId) ?? 0;
}

function nextTurn(owner: object, projectId: string): void {
  let m = turns.get(owner);
  if (!m) {
    m = new Map();
    turns.set(owner, m);
  }
  m.set(projectId, (m.get(projectId) ?? 0) + 1);
}

export function serialStore<T>(owner: object, projectId: string, fn: () => Promise<T>): Promise<T> {
  const mine = held.getStore();
  if (mine?.has(projectId)) return fn();
  let m = tails.get(owner);
  if (!m) {
    m = new Map();
    tails.set(owner, m);
  }
  const prev = m.get(projectId) ?? Promise.resolve();
  const run = prev.then(() => {
    nextTurn(owner, projectId);
    return held.run(new Set([...(mine ?? []), projectId]), fn);
  });
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  m.set(projectId, tail);
  void tail.then(() => {
    if (m.get(projectId) === tail) m.delete(projectId);
  });
  return run;
}
