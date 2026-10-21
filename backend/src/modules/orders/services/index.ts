import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import * as appointmentsService from '../../appointments/services';
import * as consultationsService from '../../consultations/services';
import * as paymentsService from '../../payments/services';
import * as auditService from '../../audit/services';
import { encryptField, decryptField } from '../../../utils/field-encryption';
import * as ordersRepo from '../repositories';
import type { Prisma } from '@prisma/client';
import { paginate, type PatientExportSection } from '../../patients/services';

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
  const appointment = await appointmentsService.getDoctorAppointmentContext(actor.userId, consultation.appointmentId);
  return { consultation, appointment };
}

  const windowStart = new Date(
    Date.now() - config.orders.confirmationWindowHours * 60 * 60 * 1000,
  );

  const result = await prisma.$transaction(async (tx) => {
    const success = await repo.confirmOrderReceiptConditional(
      tx,
      orderId,
      patientProfile.id,
      windowStart,
    );

    if (success) {
      await record(tx, actor, {
        entityType: 'Order',
        entityId: orderId,
        action: 'order.receipt_confirmed',
        fromState: 'fulfilled',
        toState: 'confirmed',
        metadata: { confirmationSource: 'patient' },
      });

      const updated = await repo.findOrderForPatient(tx, orderId, patientProfile.id);
      if (!updated) throw new HttpError(500, 'Failed to fetch updated order.');
      return updated;
    }

    // Conditional update failed — diagnose reason
    const existing = await repo.findOrderForPatient(tx, orderId, patientProfile.id);
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
  actor: AuditActor,
) {
  if (!orderId || typeof orderId !== 'string') {
    throw new HttpError(400, 'Order ID is required.');
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
    const existingBefore = await repo.findOrderForPatient(tx, orderId, patientProfile.id);
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

    const success = await repo.disputeOrderConditional(
      tx,
      orderId,
      patientProfile.id,
      windowStart,
    );

    if (!success) {
      throw new HttpError(409, 'Unable to dispute order.');
    }

    await repo.createOrderDispute(tx, {
      orderId,
      patientProfileId: patientProfile.id,
      reason: reason.trim(),
    });

    await record(tx, actor, {
      entityType: 'Order',
      entityId: orderId,
      action: 'order.disputed',
      fromState: 'fulfilled',
      toState: 'disputed',
      metadata: { reason: reason.trim() },
    });

    const updated = await repo.findOrderForPatient(tx, orderId, patientProfile.id);
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
