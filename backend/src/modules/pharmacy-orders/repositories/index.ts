// pharmacy-orders repositories — FulfillmentRecord / FulfillmentItem data
// access only. Facilities write ONLY through these paths (hard rule 5):
// never to Prescription.status / LabOrder.status directly.
import { prisma } from '../../../db/prisma-client';
import type { FulfillmentStatus, FulfillmentUnfulfilledReason, OrderType, Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

// findFacilityProfileByUserId and findFacilityProfileById removed in
// issue #318 — pharmacy-orders now calls facilitiesService directly.

export function findFulfillmentRecordById(id: string) {
  return prisma.fulfillmentRecord.findUnique({
    where: { id },
    include: { items: { orderBy: { createdAt: 'asc' } }, facility: { select: { id: true, name: true } } },
  });
}

/** All fulfillment records for an order — used by the patient-facing summary
 * to surface rejection/unfulfilled reasons (issue #322). */
export function findFulfillmentRecordsForOrder(
  orderType: 'prescription' | 'lab_order',
  orderId: string,
) {
  return prisma.fulfillmentRecord.findMany({
    where: orderType === 'prescription' ? { prescriptionId: orderId } : { labOrderId: orderId },
    include: { items: { orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
}

/** Item ids of this order (across ALL facilities' records) that were
 * already dispensed — used to reject routing an item a second time. */
export function listDispensedOrderItemIds(orderType: string, orderItemIds: string[]) {
  if (orderItemIds.length === 0) return Promise.resolve([]);
  return prisma.fulfillmentItem
    .findMany({
      where: { orderType, orderItemId: { in: orderItemIds }, status: 'dispensed' },
      select: { orderItemId: true },
    })
    .then((rows) => rows.map((row) => row.orderItemId));
}

export function countDispensedOrderItems(
  orderType: string,
  orderItemIds: string[],
  db: DbClient = prisma,
) {
  if (orderItemIds.length === 0) return Promise.resolve(0);
  return db.fulfillmentItem.count({
    where: { orderType, orderItemId: { in: orderItemIds }, status: 'dispensed' },
  });
}

/** Fulfillment records for this order that can still change (issue #84).
 * A rejection refunds only when this is 0 — otherwise another facility may
 * still dispense, and the money must stay in escrow. */
export function countOpenRecordsForOrder(
  db: DbClient,
  orderType: 'prescription' | 'lab_order',
  orderId: string,
) {
  return db.fulfillmentRecord.count({
    where: {
      ...(orderType === 'prescription' ? { prescriptionId: orderId } : { labOrderId: orderId }),
      status: { in: ['pending', 'in_progress'] },
    },
  });
}

export function createFulfillmentRecord(
  db: DbClient,
  data: {
    orderType: 'prescription' | 'lab_order';
    orderId: string;
    facilityId: string;
    items: { orderType: string; orderItemId: string; quantityOrdered: number | null }[];
  },
) {
  return db.fulfillmentRecord.create({
    data: {
      // Typed order FKs (docs/adr/0012): exactly one of the two is set —
      // the record still addresses one order, it just does so through the
      // real relation instead of an (orderType, orderId) string pair.
      prescriptionId: data.orderType === 'prescription' ? data.orderId : null,
      labOrderId: data.orderType === 'lab_order' ? data.orderId : null,
      facilityId: data.facilityId,
      items: { create: data.items },
    },
    include: { items: { orderBy: { createdAt: 'asc' } } },
  });
}

/**
 * One-shot conditional transition of a routed item to a terminal state —
 * `UPDATE ... WHERE status = 'pending'`, atomic at the DB level, exactly
 * like booking's claimOpenSlot. Two concurrent updates of the SAME row
 * can never both win.
 *
 * For dispenses, `dispensedKey` (= orderItemId) additionally trips the
 * (orderType, dispensedKey) unique index if another facility's record
 * holds a dispense of the same order item — that race is caught by the
 * constraint itself, not by application timing. Callers should map the
 * resulting P2002 to a 409.
 */
export function claimPendingItem(
  db: DbClient,
  itemId: string,
  fulfillmentRecordId: string,
  data:
    | { status: 'dispensed'; dispensedKey: string; quantityDispensed: number; dispensedAt: Date }
    | { status: 'unfulfilled'; unfulfilledReason: FulfillmentUnfulfilledReason | null; unfulfilledNote: string | null },
) {
  return db.fulfillmentItem
    .updateMany({
      where: { id: itemId, fulfillmentRecordId, status: 'pending' },
      data,
    })
    .then((result) => result.count === 1);
}

export function updateRecordStatus(db: DbClient, id: string, status: FulfillmentStatus) {
  return db.fulfillmentRecord.update({ where: { id }, data: { status } });
}

export function listRecordItems(db: DbClient, fulfillmentRecordId: string) {
  return db.fulfillmentItem.findMany({
    where: { fulfillmentRecordId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function findOrderById(tx: Prisma.TransactionClient, orderId: string, orderType?: OrderType) {
  return tx.order.findFirst({
    where: {
      id: orderId,
      ...(orderType ? { orderType } : {}),
    },
    include: {
      fulfillmentProofs: true,
      disputes: {
        include: {
          resolutions: true,
        },
      },
    },
  });
}

export async function createOrder(
  tx: Prisma.TransactionClient,
  data: {
    orderType: OrderType;
    patientProfileId: string;
    prescribingDoctorId?: string;
    details?: string;
  },
) {
  return tx.order.create({
    data: {
      orderType: data.orderType,
      patientProfileId: data.patientProfileId,
      prescribingDoctorId: data.prescribingDoctorId,
      details: data.details,
      status: 'issued',
    },
    include: {
      fulfillmentProofs: true,
      disputes: true,
    },
  });
}

export async function createFulfillmentProof(
  tx: Prisma.TransactionClient,
  data: {
    orderId: string;
    facilityProfileId: string;
    referenceNumber: string;
    attachmentUrl?: string;
    notes?: string;
  },
) {
  return tx.fulfillmentProof.create({
    data: {
      orderId: data.orderId,
      facilityProfileId: data.facilityProfileId,
      referenceNumber: data.referenceNumber,
      attachmentUrl: data.attachmentUrl,
      notes: data.notes,
    },
  });
}

/** All fulfillment records assigned to a facility — the facility's own queue
 * (issue #15). `status` filter is optional; omitting it returns all records. */
export function listFulfillmentRecordsForFacility(
  facilityId: string,
  filters: { status?: FulfillmentStatus } = {},
) {
  return prisma.fulfillmentRecord.findMany({
    where: {
      facilityId,
      ...(filters.status ? { status: filters.status } : {}),
    },
    include: {
      items: { orderBy: { createdAt: 'asc' } },
      facility: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/** All fulfillment records for one order — patient list endpoint (issue #323). */
export function listFulfillmentRecordsForOrder(orderType: 'prescription' | 'lab_order', orderId: string) {
  const where =
    orderType === 'prescription' ? { prescriptionId: orderId } : { labOrderId: orderId };
  return prisma.fulfillmentRecord.findMany({
    where,
    include: { items: { orderBy: { createdAt: 'asc' } }, facility: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
}

export async function markOrderFulfilled(
  tx: Prisma.TransactionClient,
  orderId: string,
  facilityProfileId: string,
) {
  const updated = await tx.order.updateMany({
    where: {
      id: orderId,
      status: 'issued',
    },
    data: {
      status: 'fulfilled',
      fulfilledAt: new Date(),
      facilityProfileId,
    },
  });
  return updated.count > 0;
}
