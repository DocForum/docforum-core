import { z } from 'zod';

export const flagKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, 'key must be lowercase dotted segments, e.g. payments.wallet_funding')
  .max(64);

// Strict and partial: only the fields being changed are sent; an unknown field
// is a client bug worth surfacing.
export const updateFlagSchema = z
  .object({
    description: z.string().max(200).optional(),
    enabled: z.boolean().optional(),
    rolloutPercent: z.number().int().min(0).max(100).optional(),
    allowRoles: z.array(z.enum(['patient', 'doctor', 'facility', 'admin'])).max(4).optional(),
    allowUserIds: z.array(z.string().min(1).max(128)).max(500).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Send at least one field to change.' });
