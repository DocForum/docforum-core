import { z } from 'zod';

export const createFulfillmentSchema = z.object({
  orderType: z.enum(['prescription', 'lab_order']),
  orderId: z.string().min(1),
  facilityId: z.string().min(1),
  // Which items of the order to route under this record. Omit to route
  // every not-yet-dispensed item (the common case). Issue #73's split
  // flow passes only the remaining items here, creating a second record
  // for the same order at a different facility.
  orderItemIds: z.array(z.string().min(1)).min(1).optional(),
});

const fulfillmentUnfulfilledReasonEnum = z.enum([
  'out_of_stock',
  'expired_stock',
  'item_not_stocked',
  'item_discontinued',
  'partial_stock',
  'other',
]);

const fulfillmentRejectionReasonEnum = z.enum([
  'out_of_stock',
  'expired_stock',
  'facility_capacity',
  'no_staff_available',
  'facility_closure',
  'other',
]);

export const updateFulfillmentItemSchema = z
  .object({
    // `pending` → `dispensed` | `unfulfilled`. A terminal item can never
    // change again (one-shot, enforced in the service via a conditional
    // update, same shape as booking's claimOpenSlot).
    status: z.enum(['dispensed', 'unfulfilled']),
    // Required when dispensing an item whose quantity isn't tracked by
    // the order (always, until Phase 4 items grow a quantity field).
    quantityDispensed: z.number().int().min(1).optional(),
    // Issue #322: required when marking an item unfulfilled.
    unfulfilledReason: fulfillmentUnfulfilledReasonEnum.optional(),
    unfulfilledNote: z.string().max(500).optional(),
  })
  .refine((value) => value.status === 'unfulfilled' || (value.quantityDispensed ?? 0) > 0, {
    message: 'quantityDispensed (a positive integer) is required when status is "dispensed".',
    path: ['quantityDispensed'],
  })
  .refine((value) => value.status !== 'unfulfilled' || value.unfulfilledReason !== undefined, {
    message: 'unfulfilledReason is required when status is "unfulfilled".',
    path: ['unfulfilledReason'],
  });

export const updateFulfillmentRecordSchema = z
  .object({
    // `fulfilled` is deliberately NOT settable: it is derived from the
    // record's dispensed items (issue #73), never asserted by the facility.
    status: z.enum(['in_progress', 'rejected']),
    // Issue #322: required when rejecting the whole record.
    rejectionReason: fulfillmentRejectionReasonEnum.optional(),
    rejectionNote: z.string().max(500).optional(),
  })
  .refine((value) => value.status !== 'rejected' || value.rejectionReason !== undefined, {
    message: 'rejectionReason is required when status is "rejected".',
    path: ['rejectionReason'],
  });

export const orderFulfillmentStatusQuerySchema = z.object({
  orderType: z.enum(['prescription', 'lab_order']),
});

/** POST /pharmacy-orders — create a new pharmacy order (issue #317). */
export const createPharmacyOrderSchema = z.object({
  patientProfileId: z.string().uuid(),
  prescribingDoctorId: z.string().uuid().optional(),
  details: z.string().trim().max(5000).optional(),
});

/** POST /pharmacy-orders/:id/fulfill (issue #317). Strict: the proof file is no
 * longer sent here (no client URL, no base64) — it is uploaded afterwards to
 * PUT /fulfillment-proofs/:proofId/attachment (issue #316), so a request that
 * still carries `attachment` is rejected rather than silently dropped. */
export const fulfillPharmacyOrderSchema = z
  .object({
    referenceNumber: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(5000).optional(),
  })
  .strict();

export type CreatePharmacyOrderBody = z.infer<typeof createPharmacyOrderSchema>;
export type FulfillPharmacyOrderBody = z.infer<typeof fulfillPharmacyOrderSchema>;

export const listOrderFulfillmentsQuerySchema = z.object({
  orderType: z.enum(['prescription', 'lab_order']),
});

/** GET /fulfillment-proofs/:proofId/attachment (issue #316): a guardian names
 * the dependent whose proof they are reading. */
export const proofDownloadQuerySchema = z.object({
  patientProfileId: z.string().uuid().optional(),
});
