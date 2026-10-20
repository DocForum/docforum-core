import { z } from 'zod';

export const signupSchema = z.object({
  role: z.enum(['patient', 'doctor']),
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().trim().min(1),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Phase 8, issue #39 — admin invite redemption. No `fullName`: an admin
// account has no Patient/Doctor profile row.
export const signupWithInviteSchema = z.object({
  token: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

// Phase 8, issue #34. No `email` field on the resend body on purpose — the
// resend endpoint is authenticated and targets the caller's own account,
// so it can't be used to probe which addresses exist.
export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});
// Phase 8, issue #35 — admin escape hatch for a lock a legitimate user is
// stuck behind.
export const clearLoginAttemptsSchema = z
  .object({
    email: z.string().email().optional(),
    ip: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.email || value.ip), {
    message: 'Provide an email or an ip to clear.',
  });

// Two-factor auth (Phase 8 #36). `code` is either a 6-digit TOTP code or a
// 10-character recovery code (with or without its dash) — the service
// normalizes it, so the schema only bounds the size loosely rather than
// rejecting a valid recovery code shape.
export const twoFactorCodeSchema = z.object({
  code: z.string().trim().min(6).max(16),
});

export const twoFactorVerifySchema = twoFactorCodeSchema.extend({
  mfaPendingToken: z.string().min(1),
});
