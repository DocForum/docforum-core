// Cross-instance real-time notification fan-out (issue #330).
//   - `pg` (default): publish with pg_notify on one channel; every instance
//     LISTENs on its own dedicated connection and delivers to its local SSE
//     streams. No new infrastructure (ARCHITECTURE.md §2).
//   - `local`: in-process only, for a single instance with no Postgres
//     listener (unit tests, scripts).
const driver = process.env.NOTIFICATION_FANOUT_DRIVER ?? 'pg';
if (driver !== 'pg' && driver !== 'local') {
  throw new Error('NOTIFICATION_FANOUT_DRIVER must be either "pg" or "local".');
}

export const notificationFanout = {
  driver: driver as 'pg' | 'local',
  // Listener reconnect backoff after a lost connection: doubles from min to max.
  reconnectMinMs: Number(process.env.NOTIFICATION_FANOUT_RECONNECT_MIN_MS ?? 500),
  reconnectMaxMs: Number(process.env.NOTIFICATION_FANOUT_RECONNECT_MAX_MS ?? 30_000),
} as const;
