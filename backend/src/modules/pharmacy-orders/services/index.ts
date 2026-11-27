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
import type { FulfillmentItem, FulfillmentRejectionReason, FulfillmentStatus, FulfillmentUnfulfilledReason, Role } from '@prisma/client';
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { publish } from '../../../events';
import { computeConfirmedSignal, formatOrderResponse } from '../../../utils/order-utils';
import { record as recordAudit, type AuditActor } from '../../audit/services';
import * as repo from '../repositories';
import * as facilitiesService from '../../facilities/services';
import * as prescriptionsService from '../../prescriptions/services';
import * as labOrdersService from '../../lab-orders/services';
import * as patientsService from '../../patients/services';

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
  const profile = await facilitiesService.findFacilityProfileByUserId(requester.userId);
  return profile?.id ?? null;
}

/** Hard rule 5: a facility can only ever touch records it owns. */
async function requireOwnedRecord(recordId: string, requester: Requester) {
  const record = await repo.findFulfillmentRecordById(recordId);
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
    const dispensed = await repo.countDispensedOrderItems(
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
  const dispensed = await repo.countDispensedOrderItems('lab_order', [orderId]);
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
  await facilitiesService.assertFacilityActive(input.facilityId);

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

  const alreadyDispensed = await repo.listDispensedOrderItemIds(input.orderType, requestedIds);
  if (alreadyDispensed.length > 0) {
    throw new HttpError(
      409,
      `These items have already been dispensed and can't be routed again: ${alreadyDispensed.join(', ')}.`,
    );
  }

  const quantityById = new Map(orderItems.map((item) => [item.id, item.quantityOrdered]));
  return repo.createFulfillmentRecord(prisma, {
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
  input: {
    status: 'dispensed' | 'unfulfilled';
    quantityDispensed?: number;
    unfulfilledReason?: string;
    unfulfilledNote?: string;
  },
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

  // Typed order FKs (docs/adr/0012): exactly one of prescriptionId /
  // labOrderId is set, which is the record's order reference.
  const orderType: OrderType = record.prescriptionId ? 'prescription' : 'lab_order';
  const orderId = record.prescriptionId ?? record.labOrderId;
  if (!orderId) throw new HttpError(500, 'Fulfillment record has no order reference.');
  // Only a terminal "nothing dispensed here" outcome can trigger the
  // automatic refund (issue #84); read the item universe before the write.
  const orderItems = input.status === 'unfulfilled' ? await getOrderItems(orderType, orderId) : [];

  const claimed = await prisma
    .$transaction(async (tx) => {
      try {
        const ok = await repo.claimPendingItem(tx, itemId, recordId,
          input.status === 'dispensed'
            ? {
                status: 'dispensed',
                dispensedKey: item.orderItemId,
                quantityDispensed,
                dispensedAt: new Date(),
              }
            : {
                status: 'unfulfilled',
                unfulfilledReason: (input.unfulfilledReason ?? null) as FulfillmentUnfulfilledReason | null,
                unfulfilledNote: input.unfulfilledNote ?? null,
              },
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
      const items = await repo.listRecordItems(tx, recordId);
      const nextStatus = deriveRecordStatus(items);
      await repo.updateRecordStatus(tx, recordId, nextStatus);
      // Last item of every record ended unfulfilled, and nothing was
      // dispensed for the order anywhere: the order can never be fulfilled,
      // so publish the refund trigger in this same transaction. Another
      // facility's still-open record keeps the escrow alive (split routing).
      if (input.status === 'unfulfilled' && nextStatus === 'rejected') {
        const openRecords = await repo.countOpenRecordsForOrder(tx, orderType, orderId);
        const dispensed =
          openRecords === 0
            ? await repo.countDispensedOrderItems(
                orderType,
                orderItems.map((candidate) => candidate.id),
                tx,
              )
            : 1;
        if (openRecords === 0 && dispensed === 0) {
          await publish(tx, 'order.rejected', { orderType, orderId });
        }
      }
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

  const orderStatus = await applyOrderStatus(orderType, orderId);
  return {
    record: await repo.findFulfillmentRecordById(recordId),
    orderStatus,
  };
}

/** Facility moves its own record pending → in_progress, or rejects it
 * wholesale (no items dispensed). `fulfilled` is deliberately not
 * settable — it's derived from dispensed items. */
export async function updateFulfillmentRecord(
  recordId: string,
  input: { status: 'in_progress' | 'rejected'; rejectionReason?: string; rejectionNote?: string },
  requester: Requester,
) {
  const record = await requireOwnedRecord(recordId, requester);
  if (requester.role !== 'facility') {
    throw new HttpError(403, 'Only the owning facility can update fulfillment records.');
  }
  if (input.status === 'rejected' && record.items.some((item) => item.status === 'dispensed')) {
    throw new HttpError(409, 'Items were already dispensed under this record — it can only be marked partially fulfilled.');
  }
  // Typed order FKs (docs/adr/0012): exactly one of the two is set.
  const orderType: OrderType = record.prescriptionId ? 'prescription' : 'lab_order';
  const orderId = record.prescriptionId ?? record.labOrderId;
  if (!orderId) throw new HttpError(500, 'Fulfillment record has no order reference.');
  // Read before the transaction: the item universe is used only to ask "was
  // anything dispensed for this order?", which decides whether a rejection
  // may trigger an automatic refund (issue #84).
  const orderItems = input.status === 'rejected' ? await getOrderItems(orderType, orderId) : [];

  const updated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.fulfillmentRecord
      .updateMany({
        where: { id: recordId, status: { in: ['pending', 'in_progress'] } },
        data: {
          status: input.status,
          ...(input.status === 'rejected'
            ? {
                rejectionReason: (input.rejectionReason ?? 'unspecified') as FulfillmentRejectionReason,
                rejectionNote: input.rejectionNote ?? null,
              }
            : {}),
        },
      })
      .then((result) => result.count === 1);
    if (!claimed) return null;
    if (input.status === 'rejected') {
      // Only publish when this rejection means the order cannot be fulfilled
      // by any remaining record and nothing was dispensed anywhere: another
      // facility's still-open record (split routing) keeps the escrow alive.
      const openRecords = await repo.countOpenRecordsForOrder(tx, orderType, orderId);
      const dispensed =
        openRecords === 0
          ? await repo.countDispensedOrderItems(
              orderType,
              orderItems.map((item) => item.id),
              tx,
            )
          : 1;
      if (openRecords === 0 && dispensed === 0) {
        await publish(tx, 'order.rejected', { orderType, orderId });
      }
    }
    return repo.findFulfillmentRecordById(recordId);
  });
  if (!updated) throw new HttpError(409, 'This fulfillment record has already reached a terminal state.');
  return updated;
}

/**
 * Resolve the patientProfileId that owns a fulfillment record's underlying
 * order — through the prescriptions or lab-orders service (hard rule 4).
 */
async function getOrderPatientProfileId(
  orderType: OrderType,
  orderId: string,
): Promise<string | null> {
  if (orderType === 'prescription') {
    const prescription = await prescriptionsService.getPrescription(orderId).catch(() => null);
    return prescription?.patientProfileId ?? null;
  }
  const labOrder = await labOrdersService.getLabOrder(orderId).catch(() => null);
  return labOrder?.patientProfileId ?? null;
}

/**
 * Read a record with its item rows. Owner facility, admin, or the order's
 * patient (and their active guardian) may read (issue #323).
 */
export async function getFulfillment(recordId: string, requester: Requester) {
  if (requester.role === 'facility' || requester.role === 'admin') {
    return requireOwnedRecord(recordId, requester);
  }
  if (requester.role !== 'patient') {
    throw new HttpError(403, 'You do not have permission to view this fulfillment record.');
  }
  const record = await repo.findFulfillmentRecordById(recordId);
  if (!record) throw new HttpError(404, 'Fulfillment record not found.');
  const orderType: OrderType = record.prescriptionId ? 'prescription' : 'lab_order';
  const orderId = record.prescriptionId ?? record.labOrderId;
  if (!orderId) throw new HttpError(500, 'Fulfillment record has no order reference.');
  const orderPatientProfileId = await getOrderPatientProfileId(orderType, orderId);
  if (!orderPatientProfileId) throw new HttpError(404, 'Fulfillment record not found.');
  // resolveActingProfile returns the profile the caller may act for (own or
  // an active dependent), or throws 403/404 — same ownership check used by
  // booking, appointments, etc.
  const actingProfile = await patientsService.resolveActingProfile(requester.userId, orderPatientProfileId).catch(() => null);
  if (!actingProfile || actingProfile.id !== orderPatientProfileId) {
    throw new HttpError(404, 'Fulfillment record not found.');
  }
  return record;
}

/**
 * List all fulfillment records for one order. The caller must be the order's
 * patient (or their active guardian), or admin (issue #323).
 */
export async function listFulfillmentRecordsForOrder(
  orderType: OrderType,
  orderId: string,
  requester: Requester,
) {
  if (requester.role !== 'patient' && requester.role !== 'admin') {
    throw new HttpError(403, 'You do not have permission to view fulfillment records.');
  }
  if (requester.role === 'patient') {
    const orderPatientProfileId = await getOrderPatientProfileId(orderType, orderId);
    if (!orderPatientProfileId) throw new HttpError(404, 'Order not found.');
    const actingProfile = await patientsService.resolveActingProfile(requester.userId, orderPatientProfileId).catch(() => null);
    if (!actingProfile || actingProfile.id !== orderPatientProfileId) {
      throw new HttpError(404, 'Order not found.');
    }
  }
  return repo.listFulfillmentRecordsForOrder(orderType, orderId);
}

/** Derived order-level fulfillment state WITHOUT writing it back (read
 * path for the patient/doctor UI). Includes rejection/unfulfilled reasons
 * from all records so the patient can see why items were not dispensed
 * (issue #322). */
export async function getOrderFulfillmentSummary(
  orderType: OrderType,
  orderId: string,
): Promise<{
  orderType: OrderType;
  orderId: string;
  totalItems: number;
  dispensedItems: number;
  status: DerivedOrderStatus;
  rejections: { facilityId: string; reason: string; note: string | null }[];
  unfulfilledItems: { orderItemId: string; reason: string; note: string | null }[];
}> {
  const [items, records] = await Promise.all([
    getOrderItems(orderType, orderId),
    repo.findFulfillmentRecordsForOrder(orderType, orderId),
  ]);
  const dispensedItems =
    orderType === 'prescription'
      ? await repo.countDispensedOrderItems(
          'prescription',
          items.map((item) => item.id),
        )
      : await repo.countDispensedOrderItems('lab_order', [orderId]);
  const status: DerivedOrderStatus =
    dispensedItems === items.length ? 'fulfilled' : dispensedItems > 0 ? 'partially_fulfilled' : 'issued';

  // Surface rejection and unfulfilled reasons for the patient view (#322).
  const rejections = records
    .filter((r) => r.status === 'rejected' && r.rejectionReason)
    .map((r) => ({
      facilityId: r.facilityId,
      reason: r.rejectionReason ?? 'unspecified',
      note: r.rejectionNote ?? null,
    }));
  const unfulfilledItems = records
    .flatMap((r) => r.items)
    .filter((item) => item.status === 'unfulfilled' && item.unfulfilledReason)
    .map((item) => ({
      orderItemId: item.orderItemId,
      reason: item.unfulfilledReason ?? 'unspecified',
      note: item.unfulfilledNote ?? null,
    }));

  return { orderType, orderId, totalItems: items.length, dispensedItems, status, rejections, unfulfilledItems };
}

/**
 * The facility's own fulfillment queue — all FulfillmentRecords assigned to
 * the caller's facility (issue #15). Only facilities may call this; a 403
 * is returned for any other role.
 *
 * Hard rule 5 applies: a facility sees ONLY its own records, never another
 * facility's. `fulfilled` status is NEVER directly settable via the PATCH
 * endpoint — it is derived from dispensed items (§5.3 step 5), and the
 * test for this issue proves that invariant by attempting the forbidden path.
 */
export async function listFacilityQueue(
  requester: Requester,
  filters: { status?: FulfillmentStatus } = {},
): Promise<Awaited<ReturnType<typeof repo.listFulfillmentRecordsForFacility>>> {
  if (requester.role !== 'facility') {
    throw new HttpError(403, 'Only facilities can view the fulfillment queue.');
  }
  const facilityId = await getOwnFacilityId(requester);
  if (!facilityId) {
    throw new HttpError(403, 'No facility profile is linked to this account.');
  }
  return repo.listFulfillmentRecordsForFacility(facilityId, filters);
}

export { computeConfirmedSignal, formatOrderResponse };

export interface FulfillOrderInput {
  referenceNumber: string;
  /** The proof file is not part of this call: it is uploaded afterwards to
   * PUT /fulfillment-proofs/:proofId/attachment (issue #316). */
  notes?: string;
}

export async function createPharmacyOrder(data: {
  patientProfileId: string;
  prescribingDoctorId?: string;
  details?: string;
}) {
  await patientsService.getPatientProfileById(data.patientProfileId);

  const order = await prisma.$transaction(async (tx) => {
    return repo.createOrder(tx, {
      orderType: 'pharmacy',
      patientProfileId: data.patientProfileId,
      prescribingDoctorId: data.prescribingDoctorId,
      details: data.details,
    });
  });

  return formatOrderResponse(order);
}

export async function fulfillPharmacyOrder(
  orderId: string,
  facilityUserId: string,
  input: FulfillOrderInput,
  actor: AuditActor,
) {
  // Input shape (ids, a non-empty referenceNumber) is guaranteed by the
  // controller's Zod schema (issue #317).
  const facilityProfile = await facilitiesService.findFacilityProfileByUserId(facilityUserId);
  if (!facilityProfile) {
    throw new HttpError(403, 'Facility profile required.');
  }

  const result = await prisma.$transaction(async (tx) => {
    const existing = await repo.findOrderById(tx, orderId, 'pharmacy');
    // An order already routed to a facility can only be fulfilled by that
    // facility; for any other facility it does not exist.
    if (!existing || (existing.facilityProfileId !== null && existing.facilityProfileId !== facilityProfile.id)) {
      throw new HttpError(404, 'Pharmacy order not found.');
    }
    if (existing.status === 'fulfilled') {
      throw new HttpError(409, 'Pharmacy order has already been fulfilled.');
    }
    if (existing.status !== 'issued') {
      throw new HttpError(400, `Pharmacy order cannot be fulfilled from status: ${existing.status}`);
    }

    const marked = await repo.markOrderFulfilled(tx, orderId, facilityProfile.id);
    if (!marked) {
      throw new HttpError(409, 'Failed to transition order status to fulfilled.');
    }

    await repo.createFulfillmentProof(tx, {
      orderId,
      facilityProfileId: facilityProfile.id,
      referenceNumber: input.referenceNumber,
      notes: input.notes,
    });

    await recordAudit(tx, actor, {
      entityType: 'Order',
      entityId: orderId,
      action: 'order.fulfilled',
      fromState: 'issued',
      toState: 'fulfilled',
      metadata: {
        orderType: 'pharmacy',
        referenceNumber: input.referenceNumber,
        facilityProfileId: facilityProfile.id,
      },
    });

    const updated = await repo.findOrderById(tx, orderId, 'pharmacy');
    if (!updated) {
      throw new HttpError(500, 'Failed to fetch updated order.');
    }
    return updated;
  });

  return formatOrderResponse(result);
}

export async function getPharmacyOrderById(orderId: string) {
  const order = await repo.findOrderById(prisma, orderId, 'pharmacy');
  if (!order) {
    throw new HttpError(404, 'Pharmacy order not found.');
  }
  return formatOrderResponse(order);
}
