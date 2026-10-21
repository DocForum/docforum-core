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

// Phase 8, issue #33 — password reset. The confirm schema repeats signup's
// minimum password length so a reset can't weaken the account.
export const passwordResetRequestSchema = z.object({
  email: z.string().email(),
});

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});
