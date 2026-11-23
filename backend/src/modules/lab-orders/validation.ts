import { z } from 'zod';

/** POST /lab-orders — create a new lab order (issue #317). */
export const createLabOrderSchema = z.object({
  patientProfileId: z.string().uuid(),
  orderingDoctorId: z.string().uuid().optional(),
  details: z.string().trim().max(5000).optional(),
});

/** Attachment data for a fulfillment proof — base64-encoded file content
 * stored via object storage (issue #316). Never a client-supplied URL. */
const fulfillmentAttachmentSchema = z.object({
  data: z.string().min(1),
  contentType: z.string().min(1).max(100).optional(),
});

/** POST /lab-orders/:id/fulfill (issue #317). */
export const fulfillLabOrderSchema = z.object({
  referenceNumber: z.string().trim().min(1).max(200),
  attachment: fulfillmentAttachmentSchema.optional(),
  notes: z.string().trim().max(5000).optional(),
});

export type CreateLabOrderBody = z.infer<typeof createLabOrderSchema>;
export type FulfillLabOrderBody = z.infer<typeof fulfillLabOrderSchema>;
