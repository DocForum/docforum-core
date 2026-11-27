import { z } from 'zod';

const amountStroops = z.string().regex(/^[1-9][0-9]*$/, 'amountStroops must be a positive integer string.').transform(BigInt);
const catalogItemCode = z.string().trim().min(1).max(100);
/**
 * One prescribed item (issue #69).
 *
 * Either a `medicationId` from the controlled vocabulary (`GET
 * /medications`) or the explicit **unlisted medication** path — free-text
 * `drugName`, which the service flags for pharmacist review. `dosage`,
 * `frequency` and `duration` stay prescriber-entered either way: the catalog
 * describes the drug, not the regimen.
 *
 * When both are supplied the catalog wins and `drugName` is ignored: the
 * item's display snapshot is derived server-side from the catalog row, so a
 * client cannot smuggle a mismatched name onto a linked medication.
 */
const item = z
  .object({
    medicationId: z.string().uuid().optional(),
    drugName: z.string().trim().min(1).max(200).optional(),
    dosage: z.string().trim().min(1).max(200),
    frequency: z.string().trim().min(1).max(200),
    duration: z.string().trim().min(1).max(200),
    // Issue #312: quantity ordered and its dispense unit (e.g. 30, "tablets").
    quantity: z.number().int().positive(),
    unit: z.string().trim().min(1).max(50),
  })
  .refine((value) => value.medicationId !== undefined || value.drugName !== undefined, {
    message: 'Each item needs medicationId (from GET /medications) or drugName (unlisted medication).',
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
// Issue #72: the facility's judgement of a result. It travels as a query
// parameter because the request body IS the file (raw parser), and it
// defaults to `normal` so existing clients keep working.
export const attachLabResultQuerySchema = z.object({
  abnormality: z.enum(['normal', 'abnormal', 'critical']).default('normal'),
});

export const unacknowledgedResultsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();

// Issue #311: dispute resolution validation schemas.
export const resolveDisputeSchema = z.object({
  resolutionNotes: z.string().trim().min(1).max(2000),
  outcome: z.enum(['upheld', 'rejected', 'refunded']),
});

export const listDisputesQuerySchema = z.object({
  status: z.enum(['pending', 'resolved']).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** Issue #305: an active guardian downloads a dependent's result by naming
 * the dependent. Service-side authorisation through resolveActingProfile. */
export const labResultDownloadQuerySchema = z.object({
  patientProfileId: z.string().uuid().optional(),
});

export const labOrderSchema = requireExactlyOnePrice({
  ...pricing,
  facilityProfileId: z.string().uuid(),
  testType: z.string().trim().min(1).max(200),
  urgency: z.enum(['routine', 'urgent']).default('routine'),
  notes: z.string().max(20000).optional(),
  supersedesLabOrderId: z.string().uuid().optional(),
});
