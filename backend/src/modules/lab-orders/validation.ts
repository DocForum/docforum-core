import { z } from 'zod';

const testCodeInput = z.object({
  labTestId: z.string().uuid(),
});

export const labOrderIssueSchema = z.object({
  facilityProfileId: z.string().uuid(),
  amountStroops: z.string().regex(/^[1-9][0-9]*$/, 'amountStroops must be a positive integer string.').transform(BigInt).optional(),
  catalogItemCode: z.string().trim().min(1).max(100).optional(),
  testType: z.string().trim().min(1).max(200), // Legacy field for backward compatibility
  urgency: z.enum(['routine', 'urgent']).default('routine'),
  notes: z.string().max(20000).optional(),
  supersedesLabOrderId: z.string().uuid().optional(),
  testCodes: z.array(testCodeInput).optional(),
}).refine(
  (v) => (v.amountStroops === undefined) !== (v.catalogItemCode === undefined),
  { message: 'Provide exactly one of amountStroops or catalogItemCode.' }
);

export const labOrderResultSchema = z.object({
  resultFileUrl: z.string().url().optional().nullable(),
  summary: z.string().max(20000).optional().nullable(),
  abnormalityFlag: z.enum(['normal', 'abnormal', 'critical']).default('normal'),
});

export const labOrderListSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const labOrderAcknowledgeSchema = z.object({});