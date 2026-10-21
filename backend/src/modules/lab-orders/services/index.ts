// lab-orders services — other modules must only import from here,
// never from repositories/ directly. See AGENTS.md "Non-negotiable rules".
import { prisma } from '../../../db/prisma-client';
import * as labOrdersRepo from '../repositories';
import { HttpError } from '../../../http-error';
import { decryptField } from '../../../utils/field-encryption';

export interface LabOrderView {
  id: string;
  consultationId: string;
  patientProfileId: string;
  orderingDoctorId: string;
  facilityProfileId: string;
  amountStroops: bigint;
  testType: string; // Legacy field - kept for backward compatibility
  urgency: string;
  notes: string | null;
  status: string;
  supersedesLabOrderId: string | null;
  createdAt: Date;
  testCodes: Array<{
    id: string;
    labTestId: string;
    testCode: string;
    testName: string;
    labTest?: {
      id: string;
      code: string;
      name: string;
      specimenType: string | null;
      category: string | null;
    } | null;
  }>;
  result?: {
    id: string;
    resultFileUrl: string | null;
    summary: string | null;
    abnormalityFlag: string;
    createdAt: Date;
    acknowledgement?: {
      id: string;
      status: string;
      acknowledgedAt: Date | null;
      escalatedAt: Date | null;
    } | null;
  } | null;
  paymentIntent?: {
    id: string;
    status: string;
    amountStroops: bigint;
  } | null;
}

export async function issueLabOrder(_actor: { userId: string | null; role: string | null }, _input: {
  consultationId: string; facilityProfileId: string; amountStroops?: bigint; catalogItemCode?: string;
  testType: string; // Legacy - required for backward compatibility
  urgency: 'routine' | 'urgent'; notes?: string; supersedesLabOrderId?: string;
  testCodes?: Array<{ labTestId: string }>;
}) {
  // This is a placeholder - the actual implementation is in orders/services
  // This module's service is for lab-order-specific operations
  throw new Error('Use orders/services for lab order issuance');
}

export async function getLabOrderById(id: string): Promise<LabOrderView | null> {
  const labOrder = await labOrdersRepo.findLabOrderById(id);
  if (!labOrder) return null;

  return {
    id: labOrder.id,
    consultationId: labOrder.consultationId,
    patientProfileId: labOrder.patientProfileId,
    orderingDoctorId: labOrder.orderingDoctorId,
    facilityProfileId: labOrder.facilityProfileId,
    amountStroops: labOrder.amountStroops,
    testType: labOrder.testType,
    urgency: labOrder.urgency,
    notes: decryptField(labOrder.notes) ?? null,
    status: labOrder.status,
    supersedesLabOrderId: labOrder.supersedesLabOrderId,
    createdAt: labOrder.createdAt,
    testCodes: labOrder.testCodes.map((tc) => ({
      id: tc.id,
      labTestId: tc.labTestId,
      testCode: tc.testCode,
      testName: tc.testName,
      labTest: tc.labTest ? {
        id: tc.labTest.id,
        code: tc.labTest.code,
        name: tc.labTest.name,
        specimenType: tc.labTest.specimenType,
        category: tc.labTest.category,
      } : null,
    })),
    result: labOrder.result ? {
      id: labOrder.result.id,
      resultFileUrl: labOrder.result.resultFileUrl,
      summary: labOrder.result.summary,
      abnormalityFlag: labOrder.result.abnormalityFlag,
      createdAt: labOrder.result.createdAt,
      acknowledgement: labOrder.result.acknowledgement ? {
        id: labOrder.result.acknowledgement.id,
        status: labOrder.result.acknowledgement.status,
        acknowledgedAt: labOrder.result.acknowledgement.acknowledgedAt ?? null,
        escalatedAt: labOrder.result.acknowledgement.escalatedAt ?? null,
      } : null,
    } : null,
    paymentIntent: null,
  };
}

export async function getLabOrdersByPatient(patientProfileId: string): Promise<LabOrderView[]> {
  const labOrders = await labOrdersRepo.findLabOrdersByPatient(patientProfileId);
  return labOrders.map((labOrder) => {
    const result = labOrder.result;
    return {
      id: labOrder.id,
      consultationId: labOrder.consultationId,
      patientProfileId: labOrder.patientProfileId,
      orderingDoctorId: labOrder.orderingDoctorId,
      facilityProfileId: labOrder.facilityProfileId,
      amountStroops: labOrder.amountStroops,
      testType: labOrder.testType,
      urgency: labOrder.urgency,
      notes: decryptField(labOrder.notes) ?? null,
      status: labOrder.status,
      supersedesLabOrderId: labOrder.supersedesLabOrderId,
      createdAt: labOrder.createdAt,
      testCodes: labOrder.testCodes.map((tc) => ({
        id: tc.id,
        labTestId: tc.labTestId,
        testCode: tc.testCode,
        testName: tc.testName,
        labTest: tc.labTest ? {
          id: tc.labTest.id,
          code: tc.labTest.code,
          name: tc.labTest.name,
          specimenType: tc.labTest.specimenType,
          category: tc.labTest.category,
        } : null,
      })),
      result: result ? {
        id: result.id,
        resultFileUrl: result.resultFileUrl,
        summary: result.summary,
        abnormalityFlag: result.abnormalityFlag,
        createdAt: result.createdAt,
        acknowledgement: result.acknowledgement ? {
          id: result.acknowledgement.id,
          status: result.acknowledgement.status,
          acknowledgedAt: result.acknowledgement.acknowledgedAt ?? null,
          escalatedAt: result.acknowledgement.escalatedAt ?? null,
        } : null,
      } : null,
      paymentIntent: null,
    };
  });
}

export async function attachLabResult(input: {
  labOrderId: string;
  fulfillingFacilityId: string;
  resultFileUrl?: string | null;
  summary?: string | null;
  abnormalityFlag: 'normal' | 'abnormal' | 'critical';
}) {
  return prisma.$transaction(async (tx) => {
    const labOrder = await tx.labOrder.findUnique({
      where: { id: input.labOrderId },
      include: { result: true },
    });
    if (!labOrder) {
      throw new HttpError(404, 'Lab order not found');
    }
    if (labOrder.facilityProfileId !== input.fulfillingFacilityId) {
      throw new HttpError(403, 'This facility is not assigned to this lab order');
    }
    if (labOrder.result) {
      throw new HttpError(409, 'Lab result already attached');
    }

    const result = await tx.labResult.create({
      data: {
        labOrderId: input.labOrderId,
        fulfillingFacilityId: input.fulfillingFacilityId,
        resultFileUrl: input.resultFileUrl ?? null,
        summary: input.summary ?? null,
        abnormalityFlag: input.abnormalityFlag,
      },
    });

    // If abnormal or critical, create an acknowledgement task for the ordering doctor
    if (input.abnormalityFlag !== 'normal') {
      await tx.labResultAcknowledgement.create({
        data: {
          labResultId: result.id,
          doctorId: labOrder.orderingDoctorId,
          status: 'pending',
        },
      });
    }

    // Update lab order status to fulfilled
    await tx.labOrder.update({
      where: { id: input.labOrderId },
      data: { status: 'fulfilled' },
    });

    return result;
  });
}

export async function acknowledgeLabResult(actor: { userId: string | null; role: string | null }, labResultId: string) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');

  return prisma.$transaction(async (tx) => {
    const acknowledgement = await tx.labResultAcknowledgement.findUnique({
      where: { labResultId },
      include: { labResult: { include: { labOrder: true } } },
    });

    if (!acknowledgement) {
      throw new HttpError(404, 'Acknowledgement not found');
    }

    // Verify the actor is the ordering doctor
    if (acknowledgement.doctorId !== actor.userId) {
      throw new HttpError(403, 'Only the ordering doctor can acknowledge this result');
    }

    if (acknowledgement.status === 'acknowledged') {
      throw new HttpError(409, 'Result already acknowledged');
    }

    return tx.labResultAcknowledgement.update({
      where: { labResultId },
      data: {
        status: 'acknowledged',
        acknowledgedAt: new Date(),
      },
    });
  });
}

export async function getUnacknowledgedLabResults(doctorId: string) {
  return prisma.labResultAcknowledgement.findMany({
    where: { doctorId, status: 'pending' },
    include: {
      labResult: {
        include: {
          labOrder: {
            include: { patientProfile: true, orderingDoctor: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function escalateUnacknowledgedResults() {
  // This would be called by a cron job
  const thresholdHours = 24; // Configurable via env
  const threshold = new Date(Date.now() - thresholdHours * 60 * 60 * 1000);

  const pendingAcknowledgements = await prisma.labResultAcknowledgement.findMany({
    where: {
      status: 'pending',
      createdAt: { lte: threshold },
      labResult: { abnormalityFlag: 'critical' },
    },
    include: {
      labResult: {
        include: {
          labOrder: { include: { orderingDoctor: true } },
        },
      },
    },
  });

  for (const ack of pendingAcknowledgements) {
    await prisma.$transaction(async (tx) => {
      await tx.labResultAcknowledgement.update({
        where: { labResultId: ack.labResultId },
        data: { status: 'escalated', escalatedAt: new Date() },
      });
      // TODO: Send notification to admin queue (Phase 6)
    });
  }

  return { escalatedCount: pendingAcknowledgements.length };
}