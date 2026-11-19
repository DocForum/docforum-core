export const loginThrottle = {
  // Sliding window: failures older than this don't count toward a lock.
  windowSeconds: Number(process.env.LOGIN_THROTTLE_WINDOW_SECONDS ?? 15 * 60),
  // After this many failures (still inside the window) start refusing with
  // Retry-After, growing exponentially. Deliberately below the lock
  // threshold: slow them down before locking them out.
  backoffAfterFailures: Number(process.env.LOGIN_THROTTLE_BACKOFF_AFTER ?? 3),
  backoffBaseSeconds: Number(process.env.LOGIN_THROTTLE_BACKOFF_BASE_SECONDS ?? 2),
  backoffMaxSeconds: Number(process.env.LOGIN_THROTTLE_BACKOFF_MAX_SECONDS ?? 300),
  // The actual lock, applied per normalised email (and per IP).
  lockAfterFailures: Number(process.env.LOGIN_THROTTLE_LOCK_AFTER ?? 10),
  lockSeconds: Number(process.env.LOGIN_THROTTLE_LOCK_SECONDS ?? 15 * 60),
  // Cleanup job (src/server.ts): how often to run, and how old a bucket's
  // last failure has to be before its row is dropped.
  pruneIntervalSeconds: Number(process.env.LOGIN_THROTTLE_PRUNE_INTERVAL_SECONDS ?? 60 * 60),
  pruneAfterSeconds: Number(process.env.LOGIN_THROTTLE_PRUNE_AFTER_SECONDS ?? 24 * 60 * 60),
} as const;
