import { z } from 'zod';

/** `?near=lat,lng` — a patient-supplied point. Used in-memory as query
 * parameters only: never persisted, never logged (issue #74 hard
 * constraint). */
const nearSchema = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/, 'near must be "lat,lng", e.g. "6.5244,3.3792".')
  .transform((value) => {
    const [lat, lng] = value.split(',').map(Number);
    return { lat, lng };
  })
  .refine((point) => point.lat >= -90 && point.lat <= 90, 'near latitude must be between -90 and 90.')
  .refine((point) => point.lng >= -180 && point.lng <= 180, 'near longitude must be between -180 and 180.');

export const eligibleFacilitiesQuerySchema = z
  .object({
    // Capability matching is deliberately shallow here — the full
    // order-specific matching matrix is issue #14's scope. This filters
    // by capability type (and optionally an exact detail, case
    // insensitive).
    capabilityType: z.enum(['lab_test', 'medication_dispense']).optional(),
    detail: z.string().min(1).max(200).optional(),
    near: nearSchema.optional(),
    radiusKm: z.coerce.number().positive().max(20000).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .refine((query) => query.radiusKm === undefined || query.near !== undefined, {
    message: 'radiusKm requires near=lat,lng.',
    path: ['radiusKm'],
  });

export type EligibleFacilitiesQuery = z.infer<typeof eligibleFacilitiesQuerySchema>;
