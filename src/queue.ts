import pLimit from "p-limit";

/**
 * Max 2 concurrent extractions. Extra requests are rejected immediately
 * with 429 busy_retry (we do NOT queue them).
 *
 * p-limit tracks activeCount/pendingCount for us. Admission MUST go through
 * `tryRun()` below: the busy-check + `limit()` dispatch happen in one
 * synchronous block (no await between), so concurrent requests cannot both
 * slip past the gate. Never call `isBusy()` and `limit()` as two separate
 * steps across an await (e.g. mkdir) — that reopens the race.
 */
export const MAX_CONCURRENT = 2;
export const limit = pLimit(MAX_CONCURRENT);

export function activeCount(): number {
  return limit.activeCount;
}

export function pendingCount(): number {
  return limit.pendingCount;
}

export function isBusy(): boolean {
  return limit.activeCount + limit.pendingCount >= MAX_CONCURRENT;
}

/**
 * Atomic admission: returns null when 2 jobs are already admitted
 * (caller maps to 429 busy_retry), otherwise the promise of `fn`
 * dispatched through the limiter.
 */
export function tryRun<T>(fn: () => Promise<T>): Promise<T> | null {
  if (limit.activeCount + limit.pendingCount >= MAX_CONCURRENT) return null;
  return limit(fn);
}
