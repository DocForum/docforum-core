// prescriptions services — the only surface other modules may use to read
// or lifecycle-update a Prescription (AGENTS.md hard rule 4).
import { HttpError } from '../../../http-error';
import { prisma } from '../../../db/prisma-client';
import { publish } from '../../../events';
import * as prescriptionsRepo from '../repositories';
import { recordAccess } from '../../audit/services';
import type { OrderStatus } from '@prisma/client';

export async function getPrescription(id: string) {
  const prescription = await prescriptionsRepo.findPrescriptionById(id);
  if (!prescription) throw new HttpError(404, 'Prescription not found.');
  return prescription;
}

export interface PrescriptionFulfillmentItem {
  id: string;
  label: string;
  quantityOrdered: number | null;
}

/** The item universe of a prescription — what "all items fulfilled" in
 * issue #73's order-status derivation is measured against. */
export async function getItemsForFulfillment(prescriptionId: string): Promise<PrescriptionFulfillmentItem[]> {
  await getPrescription(prescriptionId);
  const items = await prescriptionsRepo.listItems(prescriptionId);
  if (items.length === 0) {
    throw new HttpError(400, 'This prescription has no items to fulfill.');
  }
  // Issue #312: quantity is now on the PrescriptionItem row (nullable for
  // legacy rows pre-migration). null means the item pre-dates Phase 4 — the
  // over-dispensing guard skips the check for those items rather than
  // blocking fulfilment of historical prescriptions.
  return items.map((item) => ({ id: item.id, label: item.drugName, quantityOrdered: item.quantity ?? null }));
}

/**
 * Applies the fulfillment-derived order status (issue #73: "all items
 * fulfilled → fulfilled; some → partially_fulfilled"). Called by
 * pharmacy-orders AFTER its own item rows have been written — a facility
 * never writes a Prescription row directly (hard rule 5), and this module
 * never reaches into pharmacy-orders (hard rule 4).
 *
 * Forward-only: `partially_fulfilled` may only be applied from `issued`,
 * `fulfilled` only from `issued`/`partially_fulfilled`, so an `expired` or
 * `superseded` order can't be walked backwards into a live state.
 *
 * Issue #83: the `fulfilled` transition and its `order.fulfilled` outbox
 * event commit together, so automatic escrow release happens if and only if
 * the whole order really reached `fulfilled`. Calling this again after the
 * row already moved is a no-op and publishes nothing.
 */
export async function applyFulfillmentStatus(
  prescriptionId: string,
  status: Extract<OrderStatus, 'partially_fulfilled' | 'fulfilled'>,
): Promise<boolean> {
  const allowedFrom: OrderStatus[] =
    status === 'fulfilled' ? ['issued', 'partially_fulfilled'] : ['issued'];
  return prisma.$transaction(async (tx) => {
    const changed = await prescriptionsRepo.applyOrderStatusIf(
      prescriptionId,
      allowedFrom,
      status,
      tx,
    );
    if (changed && status === 'fulfilled') {
      await publish(tx, 'order.fulfilled', { orderType: 'prescription', orderId: prescriptionId });
    }
    return changed;
  });
}

/** Resolves the patient who owns this prescription — for ownership checks
 * in cross-module fulfillment reads (issue #323). */
export async function getPatientProfileIdForOrder(prescriptionId: string): Promise<string | null> {
  return prescriptionsRepo.findPatientProfileIdForPrescription(prescriptionId);
}

/**
 * Issue #314: fetch a prescription for a viewer with RBAC.
 *
 * Allowed viewers:
 *   - admin: always
 *   - doctor: must be the prescriber (prescribingDoctorId's userId)
 *   - patient: must own the patientProfileId
 *   - facility: must have a FulfillmentRecord on this prescription
 *
 * Returns 404 for any unauthorised viewer — 403 would leak existence.
 * Writes an AccessLog row fire-and-forget.
 */
export async function getPrescriptionForViewer(
  prescriptionId: string,
  viewer: { userId: string; role: string },
  route: string,
): Promise<{ prescription: NonNullable<Awaited<ReturnType<typeof prescriptionsRepo.findPrescriptionWithItems>>>; }> {
  const prescription = await prescriptionsRepo.findPrescriptionWithItems(prescriptionId);
  if (!prescription) throw new HttpError(404, 'Prescription not found.');

  let allowed = false;

  if (viewer.role === 'admin') {
    allowed = true;
  } else if (viewer.role === 'doctor') {
    const doctorProfile = await prisma.doctorProfile.findUnique({
      where: { userId: viewer.userId },
      select: { id: true },
    });
    allowed = doctorProfile !== null && prescription.prescribingDoctorId === doctorProfile.id;
  } else if (viewer.role === 'patient') {
    // Find the prescription's patient profile only when the viewer owns it or
    // is an active guardian for it (Guardianship.guardianUserId = viewer.userId,
    // revokedAt null). `guardians` is the PatientProfile side of that relation.
    const patientProfile = await prisma.patientProfile.findFirst({
      where: {
        id: prescription.patientProfileId,
        OR: [
          { userId: viewer.userId },
          { guardians: { some: { guardianUserId: viewer.userId, revokedAt: null } } },
        ],
      },
      select: { id: true },
    });
    allowed = patientProfile !== null;
  } else if (viewer.role === 'facility') {
    const facilityProfile = await prisma.facilityProfile.findUnique({
      where: { userId: viewer.userId },
      select: { id: true },
    });
    if (facilityProfile) {
      const record = await prisma.fulfillmentRecord.findFirst({
        where: { prescriptionId, facilityId: facilityProfile.id },
        select: { id: true },
      });
      allowed = record !== null;
    }
  }

  if (!allowed) throw new HttpError(404, 'Prescription not found.');

  recordAccess({
    accessedBy: viewer.userId,
    patientProfileId: prescription.patientProfileId,
    entityType: 'Prescription',
    entityId: prescriptionId,
    route,
  });

  return { prescription };
}
