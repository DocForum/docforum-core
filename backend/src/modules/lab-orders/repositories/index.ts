// lab-orders repositories — data access only. Not to be imported
// by other modules directly — go through services/ instead.
import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export async function findLabOrderForCorrection(id: string, db: DbClient = prisma) {
  return db.labOrder.findUnique({ where: { id }, include: { correctedBy: true } });
}

export async function createLabOrder(db: DbClient, input: {
  consultationId: string; patientProfileId: string; orderingDoctorId: string;
  facilityProfileId: string; amountStroops: bigint; testType: string; urgency: 'routine' | 'urgent';
  notes: string | null; supersedesLabOrderId: string | null;
  testCodes?: Array<{ labTestId: string; testCode: string; testName: string }>;
}) {
  const { testCodes, ...data } = input;
  return db.labOrder.create({
    data: {
      ...data,
      testCodes: testCodes ? { create: testCodes } : undefined,
    },
    include: { testCodes: true, result: true },
  });
}

export async function findLabOrderById(id: string, db: DbClient = prisma) {
  return db.labOrder.findUnique({
    where: { id },
    include: { testCodes: { include: { labTest: true } }, result: { include: { acknowledgement: true } } },
  });
}

export async function findLabOrdersByPatient(patientProfileId: string, db: DbClient = prisma) {
  return db.labOrder.findMany({
    where: { patientProfileId },
    orderBy: { createdAt: 'desc' },
    include: { testCodes: { include: { labTest: true } }, result: { include: { acknowledgement: true } } },
  }) as Promise<Array<{
    id: string;
    consultationId: string;
    patientProfileId: string;
    orderingDoctorId: string;
    facilityProfileId: string;
    amountStroops: bigint;
    testType: string;
    urgency: 'routine' | 'urgent';
    notes: string | null;
    status: 'issued' | 'fulfilled' | 'expired' | 'superseded';
    supersedesLabOrderId: string | null;
    createdAt: Date;
    testCodes: Array<{
      id: string;
      labOrderId: string;
      labTestId: string;
      testCode: string;
      testName: string;
      createdAt: Date;
      labTest: {
        id: string;
        code: string;
        name: string;
        specimenType: string | null;
        category: string | null;
      } | null;
    }>;
    result: {
      id: string;
      labOrderId: string;
      fulfillingFacilityId: string;
      resultFileUrl: string | null;
      summary: string | null;
      abnormalityFlag: 'normal' | 'abnormal' | 'critical';
      createdAt: Date;
      acknowledgement: {
        id: string;
        labResultId: string;
        doctorId: string;
        status: 'pending' | 'acknowledged' | 'escalated';
        acknowledgedAt: Date | null;
        escalatedAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
      } | null;
    } | null;
  }>>;
}

export async function findLabOrderByIdWithResult(id: string, db: DbClient = prisma) {
  return db.labOrder.findUnique({
    where: { id },
    include: { result: { include: { acknowledgement: true } }, testCodes: { include: { labTest: true } } },
  });
}

export async function updateLabOrderStatus(id: string, status: 'issued' | 'fulfilled' | 'expired' | 'superseded', db: DbClient = prisma) {
  return db.labOrder.update({ where: { id }, data: { status } });
}