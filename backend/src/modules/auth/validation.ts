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
