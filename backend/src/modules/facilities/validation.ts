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
