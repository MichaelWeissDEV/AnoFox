/**
 * Persistent cleanup intentions. A browser-shutdown event is not guaranteed to finish asynchronous deletion,
 * so every cleanup is recorded first and executed later (grace period, next alarm, next browser start).
 * Pure functions over plain data; the caller persists the array.
 */
export interface CleanupIntent {
  id: string;
  site: string;
  /** undefined = all stores */
  storeId?: string;
  reason: 'tab-closed' | 'startup' | 'manual' | 'navigated-away';
  dueAt: number;
  attempts: number;
  createdAt: number;
  lastError?: string;
}

export const MAX_INTENTS = 500;
export const MAX_ATTEMPTS = 5;

const keyOf = (i: { site: string; storeId?: string }) => `${i.site}|${i.storeId ?? '*'}`;

export function enqueue(queue: CleanupIntent[], intent: Omit<CleanupIntent, 'attempts' | 'id'> & { id?: string }): CleanupIntent[] {
  const k = keyOf(intent);
  const existing = queue.find((q) => keyOf(q) === k);
  if (existing) {
    // keep the earliest due time (never postpone a pending cleanup), upgrade reason for manual requests
    const merged: CleanupIntent = { ...existing, dueAt: Math.min(existing.dueAt, intent.dueAt), reason: intent.reason === 'manual' ? 'manual' : existing.reason };
    return queue.map((q) => (q === existing ? merged : q));
  }
  const next = [...queue, { ...intent, id: intent.id ?? `${k}@${intent.createdAt}`, attempts: 0 }];
  return next.length > MAX_INTENTS ? next.slice(next.length - MAX_INTENTS) : next;
}

/** Removes the pending intent when a site becomes active again (a new tab opened within the grace period). */
export function cancelFor(queue: CleanupIntent[], site: string, storeId?: string): CleanupIntent[] {
  return queue.filter((q) => !(q.site === site && (q.storeId === undefined || q.storeId === storeId) && q.reason !== 'manual'));
}

export function due(queue: CleanupIntent[], now: number): CleanupIntent[] {
  return queue.filter((q) => q.dueAt <= now && q.attempts < MAX_ATTEMPTS);
}

export function complete(queue: CleanupIntent[], id: string): CleanupIntent[] {
  return queue.filter((q) => q.id !== id);
}

/** Records a failure with exponential backoff (1, 2, 4, ... minutes); gives up after MAX_ATTEMPTS. */
export function fail(queue: CleanupIntent[], id: string, now: number, error: string): CleanupIntent[] {
  return queue.map((q) => (q.id !== id ? q : {
    ...q, attempts: q.attempts + 1, lastError: error.slice(0, 200), dueAt: now + 60_000 * 2 ** q.attempts
  }));
}

export function pruneStale(queue: CleanupIntent[], now: number, maxAgeMs = 14 * 24 * 3600_000): CleanupIntent[] {
  return queue.filter((q) => now - q.createdAt < maxAgeMs);
}
