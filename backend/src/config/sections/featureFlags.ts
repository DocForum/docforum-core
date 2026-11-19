// Feature flags (Phase 8, issue #132). Flags are cached in memory this
// long; an admin change takes effect immediately in the process that
// handled it and within this many seconds in the others.
export const featureFlags = {
  cacheTtlSeconds: (() => {
    const raw = Number(process.env.FEATURE_FLAG_CACHE_TTL_SECONDS);
    return Number.isFinite(raw) && raw >= 0 && process.env.FEATURE_FLAG_CACHE_TTL_SECONDS ? raw : 15;
  })(),
} as const;
