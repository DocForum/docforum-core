import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { record, type AuditActor } from '../../audit/services';
import type { DisputeStatus, DisputeOutcome } from '@prisma/client';

// --- listDisputes (issue #311): keyset-paginated, status validated by Zod ---

export interface ListDisputesInput {
  status?: DisputeStatus;
  cursor?: string;
  limit?: number;
}

export async function listDisputes(input: ListDisputesInput = {}) {
  const take = Math.min(input.limit ?? 25, 100);
  const disputes = await prisma.orderDispute.findMany({
    where: input.status ? { status: input.status } : undefined,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: take + 1,
    ...(input.cursor
      ? { cursor: { id: input.cursor }, skip: 1 }
      : {}),
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
          fulfillmentProofs: { omit: { attachmentObjectKey: true } },
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

  const items = disputes.slice(0, take);
  const nextCursor = disputes.length > take ? items[items.length - 1]?.id ?? null : null;
  return { items, nextCursor };
}

// --- resolveDispute (issue #311): conditional transition, 409 on re-resolve --

export async function resolveDispute(
  disputeId: string,
  adminUserId: string,
  data: {
    resolutionNotes: string;
    outcome: DisputeOutcome;
  },
  actor: AuditActor,
) {
  const result = await prisma.$transaction(async (tx) => {
    // Conditional update: only transitions from pending → resolved.
    // Returns count=0 if already resolved — 409 for the caller.
    const updated = await tx.orderDispute.updateMany({
      where: { id: disputeId, status: 'pending' },
      data: { status: 'resolved' },
    });

    if (updated.count === 0) {
      // Distinguish "not found" from "already resolved".
      const existing = await tx.orderDispute.findUnique({ where: { id: disputeId } });
      if (!existing) throw new HttpError(404, 'Dispute not found.');
      throw new HttpError(409, 'Dispute has already been resolved.');
    }

    const resolution = await tx.orderDisputeResolution.create({
      data: {
        disputeId,
        adminUserId,
        resolutionNotes: data.resolutionNotes,
        outcome: data.outcome,
      },
    });

    await record(tx, actor, {
      entityType: 'OrderDispute',
      entityId: disputeId,
      action: 'dispute.resolved',
      fromState: 'pending',
      toState: 'resolved',
      metadata: {
        outcome: data.outcome,
        adminUserId,
      },
    });

    const dispute = await tx.orderDispute.findUnique({
      where: { id: disputeId },
      include: { resolutions: true },
    });

    return { dispute, resolution };
  });

  return result;
}
