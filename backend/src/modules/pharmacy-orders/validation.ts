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

export const updateFulfillmentItemSchema = z
  .object({
    // `pending` → `dispensed` | `unfulfilled`. A terminal item can never
    // change again (one-shot, enforced in the service via a conditional
    // update, same shape as booking's claimOpenSlot).
    status: z.enum(['dispensed', 'unfulfilled']),
    // Required when dispensing an item whose quantity isn't tracked by
    // the order (always, until Phase 4 items grow a quantity field).
    quantityDispensed: z.number().int().min(1).optional(),
  })
  .refine((value) => value.status === 'unfulfilled' || (value.quantityDispensed ?? 0) > 0, {
    message: 'quantityDispensed (a positive integer) is required when status is "dispensed".',
    path: ['quantityDispensed'],
  });

export const updateFulfillmentRecordSchema = z.object({
  // `fulfilled` is deliberately NOT settable: it is derived from the
  // record's dispensed items (issue #73), never asserted by the facility.
  status: z.enum(['in_progress', 'rejected']),
});

export const orderFulfillmentStatusQuerySchema = z.object({
  orderType: z.enum(['prescription', 'lab_order']),
});
