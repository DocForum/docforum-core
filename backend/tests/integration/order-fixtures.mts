import type { PrismaClient } from '@prisma/client';

export async function createOrderFixture(
  prisma: PrismaClient,
  input: { patientProfileId: string; facilityProfileId: string; kind: 'prescription' | 'lab_order'; amountStroops: bigint; tag: string },
) {
  const doctorUser = await prisma.user.create({ data: { email: `order-doctor-${input.tag}@example.com`, passwordHash: 'unused', role: 'doctor' } });
  const doctor = await prisma.doctorProfile.create({ data: { userId: doctorUser.id, fullName: 'Order Test Doctor', verificationStatus: 'verified' } });
  const startTime = new Date(Date.now() + 60 * 60 * 1000);
  const slot = await prisma.availabilitySlot.create({ data: {
    doctorProfileId: doctor.id, startTime, endTime: new Date(startTime.getTime() + 30 * 60 * 1000),
  } });
  const appointment = await prisma.appointment.create({ data: {
    patientProfileId: input.patientProfileId, doctorProfileId: doctor.id, availabilitySlotId: slot.id,
  } });
  const consultation = await prisma.consultation.create({ data: { appointmentId: appointment.id } });
  if (input.kind === 'prescription') {
    const order = await prisma.prescription.create({ data: {
      consultationId: consultation.id, patientProfileId: input.patientProfileId, prescribingDoctorId: doctor.id,
      facilityProfileId: input.facilityProfileId, amountStroops: input.amountStroops,
      items: { create: [{ drugName: 'Test medicine', dosage: '1 tablet', frequency: 'daily', duration: '5 days' }] },
    } });
    return { id: order.id, consultationId: consultation.id, doctorProfileId: doctor.id, patientProfileId: input.patientProfileId, facilityProfileId: input.facilityProfileId, kind: input.kind, amountStroops: input.amountStroops };
  }
  const order = await prisma.labOrder.create({ data: {
    consultationId: consultation.id, patientProfileId: input.patientProfileId, orderingDoctorId: doctor.id,
    facilityProfileId: input.facilityProfileId, amountStroops: input.amountStroops, testType: 'Test panel',
  } });
  return { id: order.id, consultationId: consultation.id, doctorProfileId: doctor.id, patientProfileId: input.patientProfileId, facilityProfileId: input.facilityProfileId, kind: input.kind, amountStroops: input.amountStroops };
}

export function createPaymentIntentForFixture(prisma: PrismaClient, order: Awaited<ReturnType<typeof createOrderFixture>>, status: 'created' | 'escrowed' = 'created') {
  return prisma.paymentIntent.create({ data: {
    prescriptionId: order.kind === 'prescription' ? order.id : null,
    labOrderId: order.kind === 'lab_order' ? order.id : null,
    patientProfileId: order.patientProfileId, facilityId: order.facilityProfileId,
    amount: order.amountStroops, assetCode: 'XLM', status,
  } });
}