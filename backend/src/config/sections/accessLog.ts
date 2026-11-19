// PHI read-access log (Phase 8, issue #45). How long AccessLog rows are
// kept before the prune job (src/server.ts) deletes them. Reads are far
// higher volume than AuditEvent writes, so this gets its own, shorter
// retention instead of AuditEvent's append-forever lifetime.
export const accessLog = {
  retentionDays: Number(process.env.ACCESS_LOG_RETENTION_DAYS ?? 365),
} as const;
