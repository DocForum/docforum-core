import { z } from 'zod';

/** POST /lab-orders — create a new lab order (issue #317). */
export const createLabOrderSchema = z.object({
  patientProfileId: z.string().uuid(),
  orderingDoctorId: z.string().uuid().optional(),
  details: z.string().trim().max(5000).optional(),
});

/** POST /lab-orders/:id/fulfill (issue #317). Strict: the proof file is no
 * longer sent here (no client URL, no base64) — it is uploaded afterwards to
 * PUT /fulfillment-proofs/:proofId/attachment (issue #316), so a request that
 * still carries `attachment` is rejected rather than silently dropped. */
export const fulfillLabOrderSchema = z
  .object({
    referenceNumber: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(5000).optional(),
  })
  .strict();

export type CreateLabOrderBody = z.infer<typeof createLabOrderSchema>;
export type FulfillLabOrderBody = z.infer<typeof fulfillLabOrderSchema>;
