import { z } from 'zod';

/** Coordinate bounds shared by the `near` parser and the facility profile
 * update (issue #319), so a facility can't store a point search rejects. */
export const LATITUDE_BOUNDS = { min: -90, max: 90 } as const;
export const LONGITUDE_BOUNDS = { min: -180, max: 180 } as const;

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
  .refine((point) => point.lat >= LATITUDE_BOUNDS.min && point.lat <= LATITUDE_BOUNDS.max, 'near latitude must be between -90 and 90.')
  .refine((point) => point.lng >= LONGITUDE_BOUNDS.min && point.lng <= LONGITUDE_BOUNDS.max, 'near longitude must be between -180 and 180.');

/** `effectiveFrom` accepts any ISO-8601 string the Date constructor parses;
 * the service rejects garbage so the error is a 400, not a 500. */
export const createPriceVersionSchema = z.object({
  catalogItemCode: z.string().min(1).max(100),
  // JSON has no bigint: stroops arrive as a plain digit string. The service
  // re-validates with the shared parser so this module and payments agree.
  amount: z.union([z.string(), z.number()]),
  asset: z.string().min(1).max(120).optional(),
  effectiveFrom: z.string().min(1).optional(),
});

export const priceFiltersSchema = z.object({
  catalogItemCode: z.string().min(1).max(100).optional(),
  asset: z.string().min(1).max(120).optional(),
});

/**
 * GET /facilities/eligible — the one patient-facing discovery query.
 *
 * Two families of filter, both qualification (issue #14 fails closed: at
 * least one of `type` / `capabilityType` is required, so an unqualified
 * directory can never be listed) plus the optional distance sort of issue
 * #74. `type` is the facility kind; `capabilityType` is narrower and
 * carries an optional exact `detail`.
 */
export const eligibleFacilitiesQuerySchema = z
  .object({
    type: z.enum(['lab', 'pharmacy']).optional(),
    catalogItemCode: z.string().min(1).max(100).optional(),
    asset: z.string().min(1).max(120).optional(),
    at: z.string().min(1).optional(),
    capabilityType: z.enum(['lab_test', 'medication_dispense']).optional(),
    detail: z.string().min(1).max(200).optional(),
    near: nearSchema.optional(),
    radiusKm: z.coerce.number().positive().max(20000).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .refine((query) => query.type !== undefined || query.capabilityType !== undefined, {
    message: 'type or capabilityType is required.',
    path: ['type'],
  })
  .refine((query) => query.radiusKm === undefined || query.near !== undefined, {
    message: 'radiusKm requires near=lat,lng.',
    path: ['radiusKm'],
  });

export type EligibleFacilitiesQuery = z.infer<typeof eligibleFacilitiesQuerySchema>;

export type CreatePriceVersionBody = z.infer<typeof createPriceVersionSchema>;

/**
 * PATCH /facilities/me — the facility owner updates their own profile fields.
 * At least one field must be provided; `type` and `userId` are immutable.
 */
export const facilityUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    address: z.string().trim().min(1).max(500).optional(),
    latitude: z
      .number()
      .finite()
      .min(LATITUDE_BOUNDS.min, 'latitude must be between -90 and 90.')
      .max(LATITUDE_BOUNDS.max, 'latitude must be between -90 and 90.')
      .optional(),
    longitude: z
      .number()
      .finite()
      .min(LONGITUDE_BOUNDS.min, 'longitude must be between -180 and 180.')
      .max(LONGITUDE_BOUNDS.max, 'longitude must be between -180 and 180.')
      .optional(),
  })
  .strict()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided.',
  })
  // A half-updated point would move the facility somewhere it isn't: the
  // coordinates change together or not at all.
  .refine((data) => (data.latitude === undefined) === (data.longitude === undefined), {
    message: 'latitude and longitude must be provided together.',
    path: ['latitude'],
  });

export type FacilityUpdateBody = z.infer<typeof facilityUpdateSchema>;

/** Admin-only facility creation (issue #14, PRD OQ-2). The shape is checked
 * here; the type↔capability consistency rule lives in the service so a
 * direct service call cannot bypass it. */
export const facilityCapabilitySchema = z.object({
  capabilityType: z.enum(['lab_test', 'medication_dispense']),
  // Free text on purpose (schema note on FacilityCapability) — no
  // controlled vocabulary exists yet.
  detail: z.string().trim().min(1).max(100).nullish(),
}).strict();

export const createFacilitySchema = z.object({
  email: z.string().email(),
  // Same floor as auth signup — an admin-set initial password may not be
  // weaker than a self-chosen one.
  password: z.string().min(8),
  name: z.string().trim().min(1).max(200),
  type: z.enum(['lab', 'pharmacy']),
  capabilities: z.array(facilityCapabilitySchema).min(1).max(20),
}).strict();

export const addCapabilitySchema = facilityCapabilitySchema;

export const retirePriceItemSchema = z.object({
  catalogItemCode: z.string().min(1).max(100),
  asset: z.string().min(1).max(120).optional(),
  effectiveFrom: z.string().min(1).optional(),
});
