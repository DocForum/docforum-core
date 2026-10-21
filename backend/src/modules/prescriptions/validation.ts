import { z } from 'zod';

const item = z.object({
  drugName: z.string().trim().min(1).max(200),
  dosage: z.string().trim().min(1).max(200),
  frequency: z.string().trim().min(1).max(200),
  duration: z.string().trim().min(1).max(200),
  medicationId: z.string().uuid().optional(),
});

export const prescriptionIssueSchema = z.object({
  facilityProfileId: z.string().uuid(),
  amountStroops: z.string().regex(/^[1-9][0-9]*$/, 'amountStroops must be a positive integer string.').transform(BigInt).optional(),
  catalogItemCode: z.string().trim().min(1).max(100).optional(),
  supersedesPrescriptionId: z.string().uuid().optional(),
  items: z.array(item).min(1).max(100),
}).refine(
  (v) => (v.amountStroops === undefined) !== (v.catalogItemCode === undefined),
  { message: 'Provide exactly one of amountStroops or catalogItemCode.' }
);

export const prescriptionListSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});