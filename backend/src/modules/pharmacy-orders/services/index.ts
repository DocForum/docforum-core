// pharmacy-orders services — item-level (partial) fulfillment, issue #73.
//
// A prescription with three items often gets partially dispensed: one drug
// is out of stock. Item-level fulfillment rows (FulfillmentItem) under a
// FulfillmentRecord let the patient get what's available now and route the
// rest elsewhere, and the order-level status is DERIVED from those items
// (all dispensed → fulfilled; some → partially_fulfilled) instead of a
// pharmacy having to lie or refuse the whole order.
//
// Hard rules in play:
//  - Rule 4: Prescription/LabOrder rows are only lifecycle-updated via the
//    prescriptions/lab-orders module services, never written here.
//  - Rule 5: a facility writes only its OWN FulfillmentRecord/FulfillmentItem
//    rows — enforced in `requireOwnedRecord` before any write.
//  - "A single item can't be dispensed by two facilities" is a DB-level
//    constraint (unique index on (orderType, dispensedKey)), not app timing.
import { Prisma } from '@prisma/client';
import type { FulfillmentItem, FulfillmentStatus, Role } from '@prisma/client';
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import * as pharmacyOrdersRepo from '../repositories';
import * as prescriptionsService from '../../prescriptions/services';
import * as labOrdersService from '../../lab-orders/services';

export type OrderType = 'prescription' | 'lab_order';
export type DerivedOrderStatus = 'issued' | 'partially_fulfilled' | 'fulfilled';

export interface Requester {
  userId: string;
  role: Role;
}

interface OrderItemInfo {
  id: string;
  label: string;
  quantityOrdered: number | null;
}

/** Item universe of the order (issue #73's derivation denominator). */
async function getOrderItems(orderType: OrderType, orderId: string): Promise<OrderItemInfo[]> {
  if (orderType === 'prescription') {
    return prescriptionsService.getItemsForFulfillment(orderId);
  }
  const labOrder = await labOrdersService.getLabOrder(orderId);
  return [{ id: labOrder.id, label: labOrder.testType, quantityOrdered: null }];
}

/** The caller's own FacilityProfile id, or null for non-facility roles. */
async function getOwnFacilityId(requester: Requester): Promise<string | null> {
  if (requester.role !== 'facility') return null;
  const profile = await pharmacyOrdersRepo.findFacilityProfileByUserId(requester.userId);
  return profile?.id ?? null;
}

/** Hard rule 5: a facility can only ever touch records it owns. */
async function requireOwnedRecord(recordId: string, requester: Requester) {
  const record = await pharmacyOrdersRepo.findFulfillmentRecordById(recordId);
  if (!record) throw new HttpError(404, 'Fulfillment record not found.');
  if (requester.role === 'admin') return record;
  const facilityId = await getOwnFacilityId(requester);
  if (!facilityId || record.facilityId !== facilityId) {
    throw new HttpError(403, 'This fulfillment record belongs to a different facility.');
  }
  return record;
}

/** deriveRecordStatus — see ARCHITECTURE.md §5.3. */
function deriveRecordStatus(items: Pick<FulfillmentItem, 'status'>[]): FulfillmentStatus {
  const dispensed = items.filter((item) => item.status === 'dispensed').length;
  const terminal = items.every((item) => item.status !== 'pending');
  if (items.length > 0 && dispensed === items.length) return 'fulfilled';
  if (terminal && dispensed > 0) return 'partially_fulfilled';
  if (terminal) return 'rejected';
  return dispensed > 0 || items.some((item) => item.status !== 'pending') ? 'in_progress' : 'pending';
}

/**
 * Recomputes the ORDER-level status from every dispensed item across all
 * facilities' records for this order, and applies it through the owning
 * order module (hard rule 4/5). Runs after the fulfillment transaction has
 * committed, so it reads committed state only.
 */
async function applyOrderStatus(orderType: OrderType, orderId: string): Promise<DerivedOrderStatus> {
  if (orderType === 'prescription') {
    const items = await prescriptionsService.getItemsForFulfillment(orderId);
    const dispensed = await pharmacyOrdersRepo.countDispensedOrderItems(
      'prescription',
      items.map((item) => item.id),
    );
    if (dispensed === items.length) {
      await prescriptionsService.applyFulfillmentStatus(orderId, 'fulfilled');
      return 'fulfilled';
    }
    if (dispensed > 0) {
      await prescriptionsService.applyFulfillmentStatus(orderId, 'partially_fulfilled');
      return 'partially_fulfilled';
    }
    return 'issued';
  }
  // A lab order is a single-item order — its fulfillment item IS the order.
  const dispensed = await pharmacyOrdersRepo.countDispensedOrderItems('lab_order', [orderId]);
  if (dispensed > 0) {
    await labOrdersService.applyFulfillmentStatus(orderId, 'fulfilled');
    return 'fulfilled';
  }
  return 'issued';
}

/**
 * Patient (or admin) routes order items to a facility: one new
 * FulfillmentRecord + one FulfillmentItem per routed item. The split flow
 * of issue #73 is this same call with `orderItemIds` limited to the
 * items that could not be dispensed elsewhere.
 */
export async function createFulfillment(
  input: { orderType: OrderType; orderId: string; facilityId: string; orderItemIds?: string[] },
  requester: Requester,
) {
  if (requester.role !== 'patient' && requester.role !== 'admin') {
    throw new HttpError(403, 'You do not have permission to perform this action.');
  }
  const facility = await pharmacyOrdersRepo.findFacilityProfileById(input.facilityId);
  if (!facility) throw new HttpError(404, 'Facility not found.');

  const orderItems = await getOrderItems(input.orderType, input.orderId);
  const requestedIds = input.orderItemIds ?? orderItems.map((item) => item.id);

  const duplicates = requestedIds.filter((id, index) => requestedIds.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new HttpError(400, `Duplicate items in request: ${[...new Set(duplicates)].join(', ')}.`);
  }
  const knownIds = new Set(orderItems.map((item) => item.id));
  const unknownIds = requestedIds.filter((id) => !knownIds.has(id));
  if (unknownIds.length > 0) {
    throw new HttpError(400, `These items do not belong to this ${input.orderType}: ${unknownIds.join(', ')}.`);
  }

  const alreadyDispensed = await pharmacyOrdersRepo.listDispensedOrderItemIds(input.orderType, requestedIds);
  if (alreadyDispensed.length > 0) {
    throw new HttpError(
      409,
      `These items have already been dispensed and can't be routed again: ${alreadyDispensed.join(', ')}.`,
    );
  }

  const quantityById = new Map(orderItems.map((item) => [item.id, item.quantityOrdered]));
  return pharmacyOrdersRepo.createFulfillmentRecord(prisma, {
    orderType: input.orderType,
    orderId: input.orderId,
    facilityId: input.facilityId,
    items: requestedIds.map((orderItemId) => ({
      orderType: input.orderType,
      orderItemId,
      quantityOrdered: quantityById.get(orderItemId) ?? null,
    })),
  });
}

/**
 * Facility marks one of ITS routed items dispensed or unfulfilled — the
 * only path to `dispensed` that exists (issue #73). One-shot: a terminal
 * item can never change again.
 */
export async function updateFulfillmentItem(
  recordId: string,
  itemId: string,
  input: { status: 'dispensed' | 'unfulfilled'; quantityDispensed?: number },
  requester: Requester,
) {
  const record = await requireOwnedRecord(recordId, requester);
  if (requester.role !== 'facility') {
    // Dispensing is the facility's own confirmation (§5.3 step 5) — an
    // admin may inspect records but must not dispense on a facility's
    // behalf.
    throw new HttpError(403, 'Only the owning facility can update fulfillment items.');
  }
  if (record.status === 'rejected') {
    throw new HttpError(409, 'This fulfillment record was rejected and can no longer be updated.');
  }
  const item = record.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new HttpError(404, 'This item is not routed under this fulfillment record.');
  if (item.status !== 'pending') {
    throw new HttpError(409, `This item was already marked ${item.status}.`);
  }
  const quantityDispensed =
    input.status === 'dispensed' ? (input.quantityDispensed ?? item.quantityOrdered ?? 1) : 0;
  if (item.quantityOrdered !== null && quantityDispensed > item.quantityOrdered) {
    throw new HttpError(400, 'quantityDispensed exceeds the quantity the order asked for.');
  }

  const claimed = await prisma
    .$transaction(async (tx) => {
      try {
        const ok = await pharmacyOrdersRepo.claimPendingItem(tx, itemId, recordId,
          input.status === 'dispensed'
            ? {
                status: 'dispensed',
                dispensedKey: item.orderItemId,
                quantityDispensed,
                dispensedAt: new Date(),
              }
            : { status: 'unfulfilled' },
        );
        if (!ok) return false;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          // The (orderType, dispensedKey) unique index fired: another
          // facility's record already dispensed this order item. The DB
          // constraint is what makes this race-safe — not app timing.
          throw new HttpError(409, 'This item has already been dispensed by another facility.');
        }
        throw error;
      }
      const items = await pharmacyOrdersRepo.listRecordItems(tx, recordId);
      await pharmacyOrdersRepo.updateRecordStatus(tx, recordId, deriveRecordStatus(items));
      return true;
    })
    .catch((error) => {
      if (error instanceof HttpError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new HttpError(409, 'This item has already been dispensed by another facility.');
      }
      throw error;
    });

  if (!claimed) throw new HttpError(409, 'This item was already updated by the facility.');

  if (record.orderType !== 'prescription' && record.orderType !== 'lab_order') {
    // Can't happen — createFulfillment only ever writes the validated
    // enum members — but keeps TypeScript honest instead of casting.
    throw new HttpError(500, 'Fulfillment record has an unknown orderType.');
  }
  const orderStatus = await applyOrderStatus(record.orderType, record.orderId);
  return {
    record: await pharmacyOrdersRepo.findFulfillmentRecordById(recordId),
    orderStatus,
  };
}

/** Facility moves its own record pending → in_progress, or rejects it
 * wholesale (no items dispensed). `fulfilled` is deliberately not
 * settable — it's derived from dispensed items. */
export async function updateFulfillmentRecord(
  recordId: string,
  input: { status: 'in_progress' | 'rejected' },
  requester: Requester,
) {
  const record = await requireOwnedRecord(recordId, requester);
  if (requester.role !== 'facility') {
    throw new HttpError(403, 'Only the owning facility can update fulfillment records.');
  }
  if (input.status === 'rejected' && record.items.some((item) => item.status === 'dispensed')) {
    throw new HttpError(409, 'Items were already dispensed under this record — it can only be marked partially fulfilled.');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.fulfillmentRecord
      .updateMany({
        where: { id: recordId, status: { in: ['pending', 'in_progress'] } },
        data: { status: input.status },
      })
      .then((result) => result.count === 1);
    if (!claimed) return null;
    return pharmacyOrdersRepo.findFulfillmentRecordById(recordId);
  });
  if (!updated) throw new HttpError(409, 'This fulfillment record has already reached a terminal state.');
  return updated;
}

/** Read a record with its item rows. Owner facility or admin only — a
 * patient's access to their own order's fulfillment is blocked on Phase 4
 * linking PatientProfile to orders (documented gap, ARCHITECTURE.md §6.2). */
export async function getFulfillment(recordId: string, requester: Requester) {
  return requireOwnedRecord(recordId, requester);
}

/** Derived order-level fulfillment state WITHOUT writing it back (read
 * path for the patient/doctor UI). */
export async function getOrderFulfillmentSummary(
  orderType: OrderType,
  orderId: string,
): Promise<{ orderType: OrderType; orderId: string; totalItems: number; dispensedItems: number; status: DerivedOrderStatus }> {
  const items = await getOrderItems(orderType, orderId);
  const dispensedItems =
    orderType === 'prescription'
      ? await pharmacyOrdersRepo.countDispensedOrderItems(
          'prescription',
          items.map((item) => item.id),
        )
      : await pharmacyOrdersRepo.countDispensedOrderItems('lab_order', [orderId]);
  const status: DerivedOrderStatus =
    dispensedItems === items.length ? 'fulfilled' : dispensedItems > 0 ? 'partially_fulfilled' : 'issued';
  return { orderType, orderId, totalItems: items.length, dispensedItems, status };
}
