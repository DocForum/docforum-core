// Admin invites (Phase 8, issue #39). `acceptUrl` is where the invite link
// points — docforum-web owns the page that consumes `?token=`.
export const adminInvites = {
  ttlHours: Number(process.env.ADMIN_INVITE_TTL_HOURS ?? 72),
  acceptUrl: process.env.ADMIN_INVITE_ACCEPT_URL ?? 'http://localhost:5173/accept-admin-invite',
} as const;
