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

// Phase 8, issue #34. No `email` field on the resend body on purpose — the
// resend endpoint is authenticated and targets the caller's own account,
// so it can't be used to probe which addresses exist.
export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});
