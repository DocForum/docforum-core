// pharmacy-orders repositories — FulfillmentRecord / FulfillmentItem data
// access only. Facilities write ONLY through these paths (hard rule 5):
// never to Prescription.status / LabOrder.status directly.
import { prisma } from '../../../db/prisma-client';
import type { FulfillmentStatus, OrderType, Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

/** Reads FacilityProfile directly — a Phase 1 core identity model, not
 * something the (still-placeholder) facilities module exclusively owns.
 * (Same precedent as payments/repositories.) */
export function findFacilityProfileByUserId(userId: string) {
  return prisma.facilityProfile.findUnique({ where: { userId } });
}

export function findFacilityProfileById(id: string) {
  return prisma.facilityProfile.findUnique({ where: { id } });
}

export function findFulfillmentRecordById(id: string) {
  return prisma.fulfillmentRecord.findUnique({
    where: { id },
    include: { items: { orderBy: { createdAt: 'asc' } }, facility: { select: { id: true, name: true } } },
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

export function countDispensedOrderItems(orderType: string, orderItemIds: string[]) {
  if (orderItemIds.length === 0) return Promise.resolve(0);
  return prisma.fulfillmentItem.count({
    where: { orderType, orderItemId: { in: orderItemIds }, status: 'dispensed' },
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
    | { status: 'unfulfilled' },
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
