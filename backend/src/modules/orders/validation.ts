import { z } from 'zod';

const amountStroops = z.string().regex(/^[1-9][0-9]*$/, 'amountStroops must be a positive integer string.').transform(BigInt);
const catalogItemCode = z.string().trim().min(1).max(100);
const item = z.object({
  drugName: z.string().trim().min(1).max(200),
  dosage: z.string().trim().min(1).max(200),
  frequency: z.string().trim().min(1).max(200),
  duration: z.string().trim().min(1).max(200),
  medicationId: z.string().uuid().optional(),
});

const labTestCodeInput = z.object({
  labTestId: z.string().uuid(),
});

/** Either an explicit amount (legacy: the doctor types the price) or a
 * catalog item code priced from the facility's published list (issue #127).
 * Supplying both is rejected — silently preferring one would let a client ask
 * to be charged something other than the published price. */
const pricing = {
  amountStroops: amountStroops.optional(),
  catalogItemCode: catalogItemCode.optional(),
};

const requireExactlyOnePrice = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .refine((value: { amountStroops?: bigint; catalogItemCode?: string }) =>
      (value.amountStroops === undefined) !== (value.catalogItemCode === undefined), {
      message: 'Provide exactly one of amountStroops (manual price) or catalogItemCode (facility price list).',
    });

export const consultationSchema = z.object({ appointmentId: z.string().uuid(), outcome: z.enum(['resolved', 'referred', 'follow_up_needed']).nullable().optional(), notes: z.string().max(20000).nullable().optional() });
export const prescriptionSchema = requireExactlyOnePrice({
  ...pricing,
  facilityProfileId: z.string().uuid(),
  supersedesPrescriptionId: z.string().uuid().optional(),
  items: z.array(item).min(1).max(100),
});
export const labOrderSchema = requireExactlyOnePrice({
  ...pricing,
  facilityProfileId: z.string().uuid(),
  testType: z.string().trim().min(1).max(200),
  urgency: z.enum(['routine', 'urgent']).default('routine'),
  notes: z.string().max(20000).optional(),
  supersedesLabOrderId: z.string().uuid().optional(),
  testCodes: z.array(labTestCodeInput).optional(),
});
