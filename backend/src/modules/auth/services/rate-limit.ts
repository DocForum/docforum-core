// Fixed-window in-memory rate limiter (auth module — used by the password
// reset request endpoint today).
//
// Caveat, stated rather than hidden: this is per-process state, so it does
// not survive a restart and does not hold across multiple backend
// instances. That's adequate for the current single-instance preview
// deploy (docs/adr/0003) and for making the endpoint un-spammable in a way
// that's testable; a horizontally-scaled deployment needs a shared store
// (Redis) — flagged in ARCHITECTURE_ESSENTIALS.md known gaps, not silently
// assumed away.
export interface RateLimiter {
  /** Records an attempt for `key`. Returns true if it's allowed,
   * false if the caller is over the limit for the current window. */
  consume(key: string, now?: number): boolean;
  reset(): void;
}

const DEFAULT_MAX_TRACKED_KEYS = 10_000;

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    consume(key: string, now = Date.now()): boolean {
      // Opportunistic prune so a long-running process can't grow the map
      // without bound from one-off IPs/emails.
      if (buckets.size > DEFAULT_MAX_TRACKED_KEYS) {
        for (const [k, bucket] of buckets) {
          if (bucket.resetAt <= now) buckets.delete(k);
        }
      }

      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }

      if (bucket.count >= limit) return false;
      bucket.count += 1;
      return true;
    },

    reset() {
      buckets.clear();
    },
  };
}
