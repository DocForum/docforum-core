export const passwordReset = {
  // Raw tokens are single-use and short-lived; only their SHA-256 hash
  // is stored (see PasswordResetToken in schema.prisma).
  tokenTtlMinutes: Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES ?? 30),
  // Rate limits on POST /auth/password-reset/request, so the endpoint
  // can't be used to spam an inbox. Applied per email AND per IP —
  // either limit being hit returns 429. See auth/services/rate-limit.ts
  // for the (in-memory, single-process) caveat.
  requestsPerEmailPerHour: Number(process.env.PASSWORD_RESET_REQUESTS_PER_EMAIL_PER_HOUR ?? 3),
  requestsPerIpPerHour: Number(process.env.PASSWORD_RESET_REQUESTS_PER_IP_PER_HOUR ?? 10),
} as const;
