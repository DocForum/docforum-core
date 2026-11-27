import { z } from 'zod';
import { timeZoneSchema } from '../../utils/time-zones';
import {
  isCommonPassword,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
} from './services/password';

// Issue #268: Normalise (trim + lowercase) emails once in the auth validation layer.
export const emailSchema = z.string().trim().email().toLowerCase();

// Issue #269: Shared password schema enforcing min 8 chars, max 72 UTF-8 bytes, and denylist check.
export const passwordSchema = z
  .string()
  .superRefine((val, ctx) => {
    if (val.length < MIN_PASSWORD_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
        params: { code: 'PASSWORD_TOO_SHORT' },
      });
      return;
    }
    if (Buffer.byteLength(val, 'utf8') > MAX_PASSWORD_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Password must not exceed ${MAX_PASSWORD_BYTES} bytes.`,
        params: { code: 'PASSWORD_TOO_LONG' },
      });
      return;
    }
    if (isCommonPassword(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'This password is too common and easily guessed. Choose a stronger password.',
        params: { code: 'PASSWORD_COMMONLY_BREACHED' },
      });
    }
  });

export const signupSchema = z
  .object({
    role: z.enum(['patient', 'doctor']),
    email: emailSchema,
    password: passwordSchema,
    fullName: z.string().trim().min(1),
    timeZone: timeZoneSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role === 'patient' && data.timeZone !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'timeZone is only valid for doctor accounts.',
        path: ['timeZone'],
      });
    }
  });

// Existing users with longer passwords can still log in: login does not restrict max bytes or denylist.
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

// Phase 8, issue #39 — admin invite redemption.
export const signupWithInviteSchema = z.object({
  token: z.string().min(1),
  email: emailSchema,
  password: passwordSchema,
});

// Phase 8, issue #34.
export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

// Phase 8, issue #35 — admin escape hatch.
export const clearLoginAttemptsSchema = z
  .object({
    email: emailSchema.optional(),
    ip: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.email || value.ip), {
    message: 'Provide an email or an ip to clear.',
  });

// Phase 8, issue #33 — password reset.
export const passwordResetRequestSchema = z.object({
  email: emailSchema,
});

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  newPassword: passwordSchema,
});

// Phase 8, issue #270 — authenticated password change.
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: passwordSchema,
});

// Phase 8, issue #36 — TOTP two-factor authentication.
export const totpCodeSchema = z.object({
  code: z.string().trim().min(6).max(20),
});

export const verifyTwoFactorSchema = z.object({
  mfaToken: z.string().min(1),
  code: z.string().trim().min(6).max(20),
});

// Phase 8, issue #271 — change account email.
export const requestEmailChangeSchema = z.object({
  newEmail: emailSchema,
  password: z.string().min(1, 'password is required to request an email change.'),
});

export const confirmEmailChangeSchema = z.object({
  token: z.string().min(1, 'token is required to confirm an email change.'),
});
