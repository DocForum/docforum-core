// Refresh-session limits (Phase 8, issue #278). A cap on concurrent active
// sessions per user bounds what a leaked password or a login-hammering
// script can mint. The oldest (least recently used) sessions are evicted as
// new ones are issued, so the caller always keeps the device they just
// signed in on.
const configuredCap = Number(process.env.MAX_ACTIVE_SESSIONS_PER_USER ?? 10);

export const sessions = {
  // Deliberately >= 1: a cap of 0 would make login impossible, which is a
  // configuration trap rather than a security control.
  maxActivePerUser: Number.isInteger(configuredCap) && configuredCap > 0 ? configuredCap : 10,
} as const;
