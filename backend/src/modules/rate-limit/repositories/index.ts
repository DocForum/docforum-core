const state = new Map<string, { key: string; scope: 'user' | 'ip'; total: number; windowStart: Date }>();

function bucketKey(key: string, scope: 'user' | 'ip'): string {
  return `${scope}:${key}`;
}

/** Record a rate limit consumption and return the updated bucket state. */
export async function recordRateLimitConsumption(
  key: string,
  scope: 'user' | 'ip',
  cost = 1,
): Promise<{ remaining: number; resetAt: Date }> {
  const windowMs = 60 * 1000;
  const now = new Date();
  const keyName = bucketKey(key, scope);
  const existing = state.get(keyName);

  if (!existing || existing.windowStart.getTime() < now.getTime() - windowMs) {
    state.set(keyName, { key, scope, total: cost, windowStart: now });
  } else {
    existing.total += cost;
    state.set(keyName, existing);
  }

  const total = state.get(keyName)?.total ?? cost;
  const remaining = Math.max(0, 100 - total);
  const resetAt = new Date(now.getTime() + windowMs);

  return { remaining, resetAt };
}

export async function countRateLimitRecords(params: {
  key: string;
  scope: 'user' | 'ip';
  since: Date;
}): Promise<number> {
  const entry = state.get(bucketKey(params.key, params.scope));
  if (!entry) return 0;

  if (entry.windowStart.getTime() < params.since.getTime()) {
    state.delete(bucketKey(params.key, params.scope));
    return 0;
  }

  return entry.total;
}

/** Get rate limit state for a key. */
export async function getRateLimitState(
  key: string,
  scope: 'user' | 'ip',
): Promise<{ remaining: number; resetAt: Date }> {
  const windowMs = 60 * 1000;
  const entry = state.get(bucketKey(key, scope));

  if (!entry) {
    return { remaining: 100, resetAt: new Date(Date.now() + windowMs) };
  }

  const remaining = Math.max(0, 100 - entry.total);
  const resetAt = new Date(entry.windowStart.getTime() + windowMs);
  return { remaining, resetAt };
}

/** Prune old rate limit records to prevent unbounded growth. */
export async function pruneOldRateLimitRecords(before: Date): Promise<number> {
  let removed = 0;

  for (const [bucket, entry] of state.entries()) {
    if (entry.windowStart.getTime() < before.getTime()) {
      state.delete(bucket);
      removed += 1;
    }
  }

  return removed;
}
