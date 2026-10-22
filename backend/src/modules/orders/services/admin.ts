import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { record, type AuditActor } from '../../audit/services';
import type { DisputeStatus } from '@prisma/client';

export async function listDisputes(status?: DisputeStatus) {
  const disputes = await prisma.orderDispute.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    include: {
      patientProfile: {
        select: {
          id: true,
          fullName: true,
          user: {
            select: {
              email: true,
            },
          },
        },
      },
      order: {
        include: {
          facilityProfile: {
            select: {
              id: true,
              name: true,
              type: true,
            },
          },
          fulfillmentProofs: true,
        },
      },
      resolutions: {
        orderBy: { createdAt: 'asc' },
        include: {
          adminUser: {
            select: {
              id: true,
              email: true,
            },
          },
        },
      },
    },
  });

  return disputes;
}

export async function resolveDispute(
  disputeId: string,
  adminUserId: string,
  data: {
    resolutionNotes?: string;
    outcome?: string;
  },
  actor: AuditActor,
) {
  if (!disputeId || typeof disputeId !== 'string') {
    throw new HttpError(400, 'Dispute ID is required.');
  }

  const dispute = await prisma.orderDispute.findUnique({
    where: { id: disputeId },
  });
  if (!dispute) {
    throw new HttpError(404, 'Dispute not found.');
  }

  if (!data || !data.resolutionNotes || typeof data.resolutionNotes !== 'string' || data.resolutionNotes.trim().length === 0) {
    throw new HttpError(400, 'Resolution notes are required.');
  }
  if (!data.outcome || typeof data.outcome !== 'string' || data.outcome.trim().length === 0) {
    throw new HttpError(400, 'Resolution outcome is required.');
  }

  const resolutionNotes = data.resolutionNotes.trim();
  const outcome = data.outcome.trim();

  const result = await prisma.$transaction(async (tx) => {

    const resolution = await tx.orderDisputeResolution.create({
      data: {
        disputeId,
        adminUserId,
        resolutionNotes,
        outcome,
      },
    });

    const updatedDispute = await tx.orderDispute.update({
      where: { id: disputeId },
      data: {
        status: 'resolved',
      },
      include: {
        resolutions: true,
      },
    });

    await record(tx, actor, {
      entityType: 'OrderDispute',
      entityId: disputeId,
      action: 'dispute.resolved',
      fromState: dispute.status,
      toState: 'resolved',
      metadata: {
        outcome,
        adminUserId,
      },
    });

    return { dispute: updatedDispute, resolution };
  });

  return result;
}
