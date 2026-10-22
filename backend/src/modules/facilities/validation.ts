import { z } from 'zod';

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

export const eligibleFacilitiesQuerySchema = z.object({
  type: z.enum(['lab', 'pharmacy']),
  catalogItemCode: z.string().min(1).max(100).optional(),
  asset: z.string().min(1).max(120).optional(),
  at: z.string().min(1).optional(),
});

export type CreatePriceVersionBody = z.infer<typeof createPriceVersionSchema>;

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
