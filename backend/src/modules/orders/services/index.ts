import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import * as appointmentsService from '../../appointments/services';
import * as paymentsService from '../../payments/services';
import * as facilitiesService from '../../facilities/services';
import * as auditService from '../../audit/services';
import { encryptField, decryptField } from '../../../utils/field-encryption';
import * as ordersRepo from '../repositories';
import type { Prisma } from '@prisma/client';
import { paginate, type PatientExportSection } from '../../patients/services';

export async function createConsultation(actor: auditService.AuditActor, input: {
  appointmentId: string; outcome: 'resolved' | 'referred' | 'follow_up_needed' | null; notes: string | null;
}) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const appointment = await appointmentsService.getDoctorAppointmentContext(actor.userId, input.appointmentId);
  try {
    return await prisma.$transaction(async (tx) => {
      const consultation = await ordersRepo.createConsultation(tx, {
        ...input,
        notes: encryptField(input.notes) ?? null,
      });
      await auditService.record(tx, actor, {
        entityType: 'Consultation', entityId: consultation.id, action: 'consultation.created',
        fromState: null, toState: consultation.outcome,
        metadata: { appointmentId: appointment.id },
      });
      return { ...consultation, notes: input.notes };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'A consultation already exists for this appointment.');
    throw error;
  }
}

async function consultationContext(actor: auditService.AuditActor, id: string) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const consultation = await ordersRepo.findConsultation(id);
  if (!consultation) throw new HttpError(404, 'Consultation not found.');
  const appointment = await appointmentsService.getDoctorAppointmentContext(actor.userId, consultation.appointmentId);
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