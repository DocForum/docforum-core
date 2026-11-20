import { prisma } from '../../../db/prisma-client';
import type { LabResultAbnormality, Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

// Consultation rows are owned by the consultations module; this module goes
// through its services (see orders/services) rather than writing them here.

export function findPrescriptionForCorrection(id: string, db: DbClient = prisma) {
  return db.prescription.findUnique({ where: { id }, include: { correctedBy: true } });
}

export function createPrescription(db: DbClient, input: {
  consultationId: string; patientProfileId: string; prescribingDoctorId: string;
  facilityProfileId: string; amountStroops: bigint; supersedesPrescriptionId: string | null;
  items: Array<{ drugName: string; dosage: string; frequency: string; duration: string }>;
}) {
  const { items, ...data } = input;
  return db.prescription.create({ data: { ...data, items: { create: items } }, include: { items: true } });
}

export function findLabOrderForCorrection(id: string, db: DbClient = prisma) {
  return db.labOrder.findUnique({ where: { id }, include: { correctedBy: true } });
}

export function createLabOrder(db: DbClient, input: {
  consultationId: string; patientProfileId: string; orderingDoctorId: string;
  facilityProfileId: string; amountStroops: bigint; testType: string; urgency: 'routine' | 'urgent';
  notes: string | null; supersedesLabOrderId: string | null;
}) {
  return db.labOrder.create({ data: input });
}

/** A lab order with what result attachment needs: the result row (if any)
 * and whether a correction superseded it. */
export function findLabOrderWithResult(id: string, db: DbClient = prisma) {
  return db.labOrder.findUnique({
    where: { id },
    select: {
      id: true, patientProfileId: true, orderingDoctorId: true, facilityProfileId: true,
      correctedBy: { select: { id: true } },
      result: true,
    },
  });
}

export function createLabResult(db: DbClient, input: {
  labOrderId: string; fulfillingFacilityId: string;
  resultObjectKey: string; resultContentType: string; resultByteSize: number;
  abnormality: LabResultAbnormality;
}) {
  return db.labResult.create({ data: input });
}

// --- Abnormal-result acknowledgement (Phase 4, issue #72) ----------------

export function createLabResultAcknowledgement(
  db: DbClient,
  input: {
    labResultId: string;
    orderingDoctorId: string;
    severity: LabResultAbnormality;
    escalationDueAt: Date;
  },
) {
  return db.labResultAcknowledgement.create({ data: input });
}

export function findLabResultAcknowledgement(labResultId: string, db: DbClient = prisma) {
  return db.labResultAcknowledgement.findUnique({ where: { labResultId } });
}

/** One-shot acknowledgement: the WHERE clause makes a second acknowledge a
 * 409 rather than overwriting the first (append-only in spirit). */
export function acknowledgeLabResultConditional(
  tx: Prisma.TransactionClient,
  input: {
    labResultId: string;
    orderingDoctorId: string;
    acknowledgedByDoctorId: string;
    now: Date;
  },
) {
  return tx.labResultAcknowledgement
    .updateMany({
      where: {
        labResultId: input.labResultId,
        orderingDoctorId: input.orderingDoctorId,
        acknowledgedAt: null,
      },
      data: {
        acknowledgedAt: input.now,
        acknowledgedByDoctorId: input.acknowledgedByDoctorId,
      },
    })
    .then((result) => result.count === 1);
}

/** Overdue, unacknowledged tasks for the escalation job. `escalatedAt: null`
 * is deliberately part of the filter so an already-escalated row is not
 * stamped twice; a missed tick is caught up on the next run. */
export function listOverdueAcknowledgementIds(now: Date, take: number) {
  return prisma.labResultAcknowledgement
    .findMany({
      where: { acknowledgedAt: null, escalatedAt: null, escalationDueAt: { lte: now } },
      orderBy: [{ escalationDueAt: 'asc' }, { id: 'asc' }],
      take,
      select: { id: true },
    })
    .then((rows) => rows.map((row) => row.id));
}

export function markAcknowledgementEscalated(
  tx: Prisma.TransactionClient,
  id: string,
  now: Date,
) {
  return tx.labResultAcknowledgement
    .updateMany({ where: { id, acknowledgedAt: null, escalatedAt: null }, data: { escalatedAt: now } })
    .then((result) => result.count === 1);
}

export function findAcknowledgementForReply(labResultId: string, db: DbClient = prisma) {
  return db.labResultAcknowledgement.findUnique({
    where: { labResultId },
    include: { labResult: { select: { labOrderId: true, abnormality: true } } },
  });
}

/**
 * The unacknowledged-results list. A doctor sees their own outstanding tasks;
 * an admin sees everything escalated OR past its deadline. `overdue` is
 * computed from `escalationDueAt`, not from `escalatedAt`, so a missed job
 * tick cannot hide a task. */
export function listUnacknowledgedResults(input: {
  now: Date;
  take: number;
  orderingDoctorId?: string;
  adminEscalationQueue?: boolean;
}) {
  return prisma.labResultAcknowledgement.findMany({
    where: {
      acknowledgedAt: null,
      ...(input.orderingDoctorId ? { orderingDoctorId: input.orderingDoctorId } : {}),
      ...(input.adminEscalationQueue
        ? { OR: [{ escalatedAt: { not: null } }, { escalationDueAt: { lte: input.now } }] }
        : {}),
    },
    orderBy: [{ escalatedAt: 'desc' }, { escalationDueAt: 'asc' }, { id: 'asc' }],
    take: input.take,
    select: {
      id: true,
      labResultId: true,
      orderingDoctorId: true,
      severity: true,
      escalationDueAt: true,
      acknowledgedAt: true,
      escalatedAt: true,
      createdAt: true,
      labResult: { select: { labOrderId: true } },
    },
  });
}

/** Login user id for a doctor profile — the address of the abnormal-result
 * notification. Id only, never clinical data. */
export function findDoctorUserId(doctorProfileId: string) {
  return prisma.doctorProfile
    .findUnique({ where: { id: doctorProfileId }, select: { userId: true } })
    .then((row) => row?.userId ?? null);
}

export function findPrescriptionExportPage(patientProfileId: string, cursor: string | undefined, take: number) {
  return prisma.prescription.findMany({
    where: { patientProfileId }, orderBy: [{ id: 'asc' }], take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { items: true },
  });
}

export function findLabOrderExportPage(patientProfileId: string, cursor: string | undefined, take: number) {
  return prisma.labOrder.findMany({
    where: { patientProfileId }, orderBy: [{ id: 'asc' }], take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { result: true },
  });
}

export async function patientHasOrders(patientProfileId: string): Promise<boolean> {
  const [prescription, labOrder] = await Promise.all([
    prisma.prescription.findFirst({ where: { patientProfileId }, select: { id: true } }),
    prisma.labOrder.findFirst({ where: { patientProfileId }, select: { id: true } }),
  ]);
  return prescription !== null || labOrder !== null;
}

export async function findOrderForPatient(
  tx: Prisma.TransactionClient,
  orderId: string,
  patientProfileId: string,
) {
  return tx.order.findFirst({
    where: {
      id: orderId,
      patientProfileId,
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

export async function confirmOrderReceiptConditional(
  tx: Prisma.TransactionClient,
  orderId: string,
  patientProfileId: string,
  windowStart: Date,
) {
  const result = await tx.order.updateMany({
    where: {
      id: orderId,
      patientProfileId,
      status: 'fulfilled',
      confirmed: false,
      disputed: false,
      fulfilledAt: {
        gte: windowStart,
      },
    },
    data: {
      confirmed: true,
      confirmedAt: new Date(),
      confirmationSource: 'patient',
    },
  });
  return result.count > 0;
}

export async function disputeOrderConditional(
  tx: Prisma.TransactionClient,
  orderId: string,
  patientProfileId: string,
  windowStart: Date,
) {
  const result = await tx.order.updateMany({
    where: {
      id: orderId,
      patientProfileId,
      status: 'fulfilled',
      confirmed: false,
      disputed: false,
      fulfilledAt: {
        gte: windowStart,
      },
    },
    data: {
      disputed: true,
      disputedAt: new Date(),
    },
  });
  return result.count > 0;
}

export async function createOrderDispute(
  tx: Prisma.TransactionClient,
  data: {
    orderId: string;
    patientProfileId: string;
    reason: string;
  },
) {
  return tx.orderDispute.create({
    data: {
      orderId: data.orderId,
      patientProfileId: data.patientProfileId,
      reason: data.reason,
      status: 'pending',
    },
  });
}
