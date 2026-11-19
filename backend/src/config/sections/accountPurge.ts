// Account deletion purge (Phase 8, issue #41, docs/adr/0010). Only
// tombstones with no retained records are ever purged; the grace period is
// operational (lets requests in flight under a still-valid access token
// finish), not a legal retention period — that one is an open decision.
export const accountPurge = {
  graceHours: Number(process.env.ACCOUNT_PURGE_GRACE_HOURS ?? 24),
  intervalSeconds: Number(process.env.ACCOUNT_PURGE_INTERVAL_SECONDS ?? 6 * 60 * 60),
} as const;
