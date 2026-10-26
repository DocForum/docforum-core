import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { config } from '../../../config';
import * as appointmentsService from '../../appointments/services';
import * as consultationsService from '../../consultations/services';
import * as paymentsService from '../../payments/services';
import * as facilitiesService from '../../facilities/services';
import * as auditService from '../../audit/services';
import { encryptField, decryptField } from '../../../utils/field-encryption';
import * as ordersRepo from '../repositories';
import type { Prisma } from '@prisma/client';
import { paginate, type PatientExportSection } from '../../patients/services';
import { formatOrderResponse } from '../../../utils/order-utils';

/** The consultation step of the ordering flow.
 *
 * The Consultation row is owned by the consultations module, which is also
 * where "one per appointment", the completed-appointment rule, note
 * encryption, the `consultation.closed` audit event and the P2002 → 409 race
 * handling live. This function adds only the stricter gate this module already
 * had (a **verified** doctor profile, via getDoctorAppointmentContext) and then
 * delegates — it must never write the table itself. */
export async function createConsultation(actor: auditService.AuditActor, input: {
  appointmentId: string; outcome: 'resolved' | 'referred' | 'follow_up_needed' | null; notes: string | null;
}) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  await appointmentsService.getDoctorAppointmentContext(actor.userId, input.appointmentId);
  const { consultation } = await consultationsService.createConsultation(actor, input);
  return consultation;
}

async function consultationContext(actor: auditService.AuditActor, id: string) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  // Read through the consultations service, never its table (AGENTS.md hard rule 4).
  const consultation = await consultationsService.getConsultationRecord(id);
  // Who first (treating doctor, verified profile — 403 otherwise), then the
  // consultation's state (409), so another doctor never learns the state.
  const appointment = await appointmentsService.getDoctorAppointmentContext(actor.userId, consultation.appointmentId);
  consultationsService.assertConsultationAcceptsOrders(consultation);
  return { consultation, appointment };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';
}

function requirePositiveAmount(amount: bigint) {
  if (amount <= 0n) throw new HttpError(400, 'amountStroops must be positive.');
}

/**
 * Resolves what to charge for an order, inside the issuance transaction.
 *
 * - `catalogItemCode` present → the facilities price in force *now* is the
 *   amount (and the price version is what the intent snapshots). No price
 *   published → 422 `PRICE_ON_REQUEST`, never a zero/guessed charge.
 * - otherwise the caller's explicit `amountStroops` is used (legacy flow).
 *
 * Validation guarantees exactly one of the two is present.
 */
async function resolveOrderAmount(tx: Prisma.TransactionClient, input: {
  facilityProfileId: string; amountStroops?: bigint; catalogItemCode?: string;
}): Promise<{ amountStroops: bigint; catalogItemCode: string | null }> {
  if (input.catalogItemCode) {
    const price = await facilitiesService.requireCurrentPrice(tx, {
      facilityProfileId: input.facilityProfileId,
      catalogItemCode: input.catalogItemCode,
    });
    return { amountStroops: price.amount, catalogItemCode: input.catalogItemCode };
  }
  if (input.amountStroops === undefined) {
    throw new HttpError(400, 'Either amountStroops or catalogItemCode is required.');
  }
  requirePositiveAmount(input.amountStroops);
  return { amountStroops: input.amountStroops, catalogItemCode: null };
}

async function createOrderPayment(tx: Prisma.TransactionClient, input: {
  kind: 'prescription' | 'lab_order'; orderId: string; patientProfileId: string; doctorProfileId: string;
  facilityProfileId: string; amountStroops: bigint; supersedesId: string | null; catalogItemCode: string | null;
}) {
  return paymentsService.createIntentForIssuedOrder(tx, input);
}

export async function issuePrescription(actor: auditService.AuditActor, input: {
  consultationId: string; facilityProfileId: string; amountStroops?: bigint; catalogItemCode?: string;
  supersedesPrescriptionId?: string;
  items: Array<{ drugName: string; dosage: string; frequency: string; duration: string }>;
}) {
  const { consultation, appointment } = await consultationContext(actor, input.consultationId);
  let predecessor = null;
  if (input.supersedesPrescriptionId) {
    predecessor = await ordersRepo.findPrescriptionForCorrection(input.supersedesPrescriptionId);
    if (!predecessor || predecessor.consultationId !== consultation.id || predecessor.correctedBy) {
      throw new HttpError(409, 'The prescription to correct does not exist, belongs to another consultation, or already has a correction.');
    }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await facilitiesService.requireFacilityForOrderKind(tx, input.facilityProfileId, 'prescription');
      const pricing = await resolveOrderAmount(tx, input);
      const order = await ordersRepo.createPrescription(tx, {
        consultationId: consultation.id, patientProfileId: appointment.patientProfileId,
        prescribingDoctorId: appointment.doctorProfileId, facilityProfileId: input.facilityProfileId,
        amountStroops: pricing.amountStroops, supersedesPrescriptionId: predecessor?.id ?? null, items: input.items,
      });
      const paymentIntent = await createOrderPayment(tx, {
        kind: 'prescription', orderId: order.id, patientProfileId: appointment.patientProfileId,
        doctorProfileId: appointment.doctorProfileId, facilityProfileId: input.facilityProfileId,
        amountStroops: pricing.amountStroops, supersedesId: predecessor?.id ?? null,
        catalogItemCode: pricing.catalogItemCode,
      });
      await auditService.record(tx, actor, {
        entityType: 'Prescription', entityId: order.id, action: 'prescription.issued',
        fromState: null, toState: order.status,
        metadata: {
          consultationId: consultation.id, paymentIntentId: paymentIntent.id,
          amountStroops: pricing.amountStroops.toString(),
          catalogItemCode: pricing.catalogItemCode,
        },
      });
      return { ...order, paymentIntent };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'This order already has a correction or payment intent.');
    throw error;
  }
}

export async function issueLabOrder(actor: auditService.AuditActor, input: {
  consultationId: string; facilityProfileId: string; amountStroops?: bigint; catalogItemCode?: string; testType: string;
  urgency: 'routine' | 'urgent'; notes?: string; supersedesLabOrderId?: string;
}) {
  const { consultation, appointment } = await consultationContext(actor, input.consultationId);
  let predecessor = null;
  if (input.supersedesLabOrderId) {
    predecessor = await ordersRepo.findLabOrderForCorrection(input.supersedesLabOrderId);
    if (!predecessor || predecessor.consultationId !== consultation.id || predecessor.correctedBy) {
      throw new HttpError(409, 'The lab order to correct does not exist, belongs to another consultation, or already has a correction.');
    }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await facilitiesService.requireFacilityForOrderKind(tx, input.facilityProfileId, 'lab_order');
      const pricing = await resolveOrderAmount(tx, input);
      const order = await ordersRepo.createLabOrder(tx, {
        consultationId: consultation.id, patientProfileId: appointment.patientProfileId,
        orderingDoctorId: appointment.doctorProfileId, facilityProfileId: input.facilityProfileId,
        amountStroops: pricing.amountStroops, testType: input.testType, urgency: input.urgency,
        notes: encryptField(input.notes) ?? null, supersedesLabOrderId: predecessor?.id ?? null,
      });
      const paymentIntent = await createOrderPayment(tx, {
        kind: 'lab_order', orderId: order.id, patientProfileId: appointment.patientProfileId,
        doctorProfileId: appointment.doctorProfileId, facilityProfileId: input.facilityProfileId,
        amountStroops: pricing.amountStroops, supersedesId: predecessor?.id ?? null,
        catalogItemCode: pricing.catalogItemCode,
      });
      await auditService.record(tx, actor, {
        entityType: 'LabOrder', entityId: order.id, action: 'lab_order.issued',
        fromState: null, toState: order.status,
        metadata: {
          consultationId: consultation.id, paymentIntentId: paymentIntent.id,
          amountStroops: pricing.amountStroops.toString(),
          catalogItemCode: pricing.catalogItemCode,
        },
      });
      return { ...order, notes: decryptField(order.notes), paymentIntent };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'This order already has a correction or payment intent.');
    throw error;
  }
}

export async function confirmOrderReceipt(
  orderId: string,
  patientUserId: string,
  actor: auditService.AuditActor,
) {
  if (!orderId || typeof orderId !== 'string') {
    throw new HttpError(400, 'Order ID is required.');
  }

  const patientProfile = await prisma.patientProfile.findUnique({
    where: { userId: patientUserId },
  });
  if (!patientProfile) {
    throw new HttpError(403, 'Patient profile required.');
  }

  const windowStart = new Date(
    Date.now() - config.orders.confirmationWindowHours * 60 * 60 * 1000,
  );

  const result = await prisma.$transaction(async (tx) => {
    const success = await ordersRepo.confirmOrderReceiptConditional(
      tx,
      orderId,
      patientProfile.id,
      windowStart,
    );

    if (success) {
      await auditService.record(tx, actor, {
        entityType: 'Order',
        entityId: orderId,
        action: 'order.receipt_confirmed',
        fromState: 'fulfilled',
        toState: 'confirmed',
        metadata: { confirmationSource: 'patient' },
      });

      const updated = await ordersRepo.findOrderForPatient(tx, orderId, patientProfile.id);
      if (!updated) throw new HttpError(500, 'Failed to fetch updated order.');
      return updated;
    }

    // Conditional update failed — diagnose reason
    const existing = await ordersRepo.findOrderForPatient(tx, orderId, patientProfile.id);
    if (!existing) {
      const orderExists = await tx.order.findUnique({ where: { id: orderId } });
      if (!orderExists) {
        throw new HttpError(404, 'Order not found.');
      }
      throw new HttpError(403, 'You do not have permission to confirm this order.');
    }

    if (existing.confirmed) {
      // Idempotent success
      return existing;
    }
    if (existing.disputed) {
      throw new HttpError(409, 'Cannot confirm receipt of a disputed order.');
    }
    if (existing.status !== 'fulfilled') {
      throw new HttpError(400, 'Order must be fulfilled before receipt can be confirmed.');
    }
    if (existing.fulfilledAt && existing.fulfilledAt < windowStart) {
      throw new HttpError(409, 'Confirmation window has elapsed.');
    }

    throw new HttpError(409, 'Unable to confirm order receipt.');
  });

  return formatOrderResponse(result);
}

export async function disputeOrder(
  orderId: string,
  patientUserId: string,
  reason: string,
  actor: auditService.AuditActor,
) {
  if (!orderId || typeof orderId !== 'string') {
    throw new HttpError(400, 'Order ID is required.');
  }

  const orderExists = await prisma.order.findUnique({ where: { id: orderId } });
  if (!orderExists) {
    throw new HttpError(404, 'Order not found.');
  }

  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new HttpError(400, 'Dispute reason is required.');
  }

  const patientProfile = await prisma.patientProfile.findUnique({
    where: { userId: patientUserId },
  });
  if (!patientProfile) {
    throw new HttpError(403, 'Patient profile required.');
  }

  const windowStart = new Date(
    Date.now() - config.orders.confirmationWindowHours * 60 * 60 * 1000,
  );

  const result = await prisma.$transaction(async (tx) => {
    const existingBefore = await ordersRepo.findOrderForPatient(tx, orderId, patientProfile.id);
    if (!existingBefore) {
      const orderExists = await tx.order.findUnique({ where: { id: orderId } });
      if (!orderExists) {
        throw new HttpError(404, 'Order not found.');
      }
      throw new HttpError(403, 'You do not have permission to dispute this order.');
    }

    if (existingBefore.confirmed) {
      throw new HttpError(409, 'Cannot dispute an order that has already been confirmed.');
    }
    if (existingBefore.disputed) {
      throw new HttpError(409, 'Order is already disputed.');
    }
    if (existingBefore.status !== 'fulfilled') {
      throw new HttpError(400, 'Order must be fulfilled before it can be disputed.');
    }
    if (existingBefore.fulfilledAt && existingBefore.fulfilledAt < windowStart) {
      throw new HttpError(409, 'Confirmation window has elapsed; order can no longer be disputed.');
    }

    const success = await ordersRepo.disputeOrderConditional(
      tx,
      orderId,
      patientProfile.id,
      windowStart,
    );

    if (!success) {
      throw new HttpError(409, 'Unable to dispute order.');
    }

    await ordersRepo.createOrderDispute(tx, {
      orderId,
      patientProfileId: patientProfile.id,
      reason: reason.trim(),
    });

    await auditService.record(tx, actor, {
      entityType: 'Order',
      entityId: orderId,
      action: 'order.disputed',
      fromState: 'fulfilled',
      toState: 'disputed',
      metadata: { reason: reason.trim() },
    });

    const updated = await ordersRepo.findOrderForPatient(tx, orderId, patientProfile.id);
    if (!updated) throw new HttpError(500, 'Failed to fetch updated order.');
    return updated;
  });

  return formatOrderResponse(result);
}

export async function getOrderById(orderId: string) {
  if (!orderId || typeof orderId !== 'string') {
    throw new HttpError(400, 'Order ID is required.');
  }
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      fulfillmentProofs: true,
      disputes: {
        include: {
          resolutions: true,
        },
      },
    },
  });
  if (!order) {
    throw new HttpError(404, 'Order not found.');
  }
  return formatOrderResponse(order);
}

export const prescriptionsExportSection: PatientExportSection = {
  name: 'prescriptions', version: 1,
  pages(subject, pageSize) {
    return paginate(pageSize,
      (cursor, take) => ordersRepo.findPrescriptionExportPage(subject.patientProfileId, cursor, take),
      (rows) => rows.map((row) => ({
        id: row.id, consultationId: row.consultationId, prescribingDoctorId: row.prescribingDoctorId,
        facilityProfileId: row.facilityProfileId, amountStroops: row.amountStroops.toString(),
        supersedesPrescriptionId: row.supersedesPrescriptionId, createdAt: row.createdAt,
        items: row.items.map(({ drugName, dosage, frequency, duration }) => ({ drugName, dosage, frequency, duration })),
      })),
    );
  },
};

export const labOrdersExportSection: PatientExportSection = {
  name: 'lab_orders', version: 1,
  pages(subject, pageSize) {
    return paginate(pageSize,
      (cursor, take) => ordersRepo.findLabOrderExportPage(subject.patientProfileId, cursor, take),
      (rows) => rows.map((row) => ({
        id: row.id, consultationId: row.consultationId, orderingDoctorId: row.orderingDoctorId,
        facilityProfileId: row.facilityProfileId, amountStroops: row.amountStroops.toString(),
        testType: row.testType, urgency: row.urgency, notes: decryptField(row.notes),
        supersedesLabOrderId: row.supersedesLabOrderId, createdAt: row.createdAt,
        result: row.result ? { resultFileUrl: row.result.resultFileUrl, summary: row.result.summary, createdAt: row.result.createdAt } : null,
      })),
    );
  },
};

/** Retention hold (issue #41, docs/adr/0010): prescriptions and lab orders
 * are append-only clinical orders, so a patient who has any is never purged
 * after deletion. */
export function hasOrdersForPatient(patientProfileId: string): Promise<boolean> {
  return ordersRepo.patientHasOrders(patientProfileId);
}
