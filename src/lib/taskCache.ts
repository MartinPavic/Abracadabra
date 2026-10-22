import type { Task } from "./api";

/** How long a fetched task list is shown without refetching. */
const FRESH_MS = 5 * 60 * 1000;

interface CachedTasks {
  tasks: Task[];
  fetchedAt: number;
}

// Module-level so it survives the task list unmounting when switching tabs/pages.
const cache = new Map<string, CachedTasks>();

export function getCachedTasks(sourceId: string): CachedTasks | undefined {
  return cache.get(sourceId);
}

export function setCachedTasks(sourceId: string, tasks: Task[]): CachedTasks {
  const entry = { tasks, fetchedAt: Date.now() };
  cache.set(sourceId, entry);
  return entry;
}

/** Forget a source's list, e.g. when the source is removed. */
export function clearCachedTasks(sourceId: string): void {
  cache.delete(sourceId);
}

export function isFresh(entry: CachedTasks): boolean {
  return Date.now() - entry.fetchedAt < FRESH_MS;
}
