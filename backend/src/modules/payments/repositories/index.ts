// payments repositories — PaymentIntent, WalletLink data access only.
// Never store PHI here. Never call docforum-escrow directly from here —
// go through services/.
import { prisma } from '../../../db/prisma-client';
import type { PaymentIntentStatus, Prisma } from '@prisma/client';

/** Reads FacilityProfile directly — a Phase 1 core identity model, not
 * something the (still-placeholder) facilities module exclusively owns. */
export function findFacilityProfileByUserId(userId: string) {
  return prisma.facilityProfile.findUnique({ where: { userId } });
}

export function upsertWalletLink(facilityId: string, stellarPublicKey: string) {
  return prisma.walletLink.upsert({
    where: { facilityId },
    create: { facilityId, stellarPublicKey },
    update: { stellarPublicKey },
  });
}

export function findWalletLinkByFacilityId(facilityId: string) {
  return prisma.walletLink.findUnique({ where: { facilityId } });
}

export function findPaymentIntentById(id: string) {
  return prisma.paymentIntent.findUnique({ where: { id } });
}

/** One keyset page of a patient's payment intents, oldest first (patient
 * data export, issue #40). */
export function findPaymentIntentsPageForPatient(patientProfileId: string, cursor: string | undefined, take: number) {
  return prisma.paymentIntent.findMany({
    where: { patientProfileId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

type PaymentHistoryFilter = {
  status?: PaymentIntentStatus;
  from?: Date;
  to?: Date;
  before?: { createdAt: Date; id: string };
  take: number;
};

function paymentHistoryWhere(filter: PaymentHistoryFilter) {
  return {
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.from || filter.to
      ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
      : {}),
    ...(filter.before
      ? {
          OR: [
            { createdAt: { lt: filter.before.createdAt } },
            { createdAt: filter.before.createdAt, id: { lt: filter.before.id } },
          ],
        }
      : {}),
  };
}

export function findPaymentHistoryPage(
  owner: { patientProfileId: string } | { facilityId: string },
  filter: PaymentHistoryFilter,
) {
  return prisma.paymentIntent.findMany({
    where: { ...paymentHistoryWhere(filter), ...owner },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: filter.take,
  });
}

/** Aggregate each lifecycle bucket in PostgreSQL; amountStroops stays BigInt end to end. */
export function aggregateFacilityPayments(facilityId: string, from?: Date, to?: Date) {
  return prisma.paymentIntent.groupBy({
    by: ['status'],
    where: {
      facilityId,
      status: { in: ['escrowed', 'released', 'refunded'] },
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    _sum: { amountStroops: true },
  });
}

/** Same FacilityProfile read this module already does for its own
 * payee lookups (see findFacilityProfileByUserId). */
export function findFacilityNamesByIds(ids: string[]) {
  return prisma.facilityProfile.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
}

/**
 * Status writes are conditional on the state the caller observed (issue
 * #43): `created -> escrowed`, `escrowed -> released|refunded`. They run in
 * the caller's transaction alongside the AuditEvent, and return null if the
 * row was no longer in the expected state (a concurrent action won), so an
 * audit event can never claim a transition that didn't happen. The
 * check-then-act gap before the on-chain call is issue #24's to close.
 */
export async function markEscrowed(
  tx: Prisma.TransactionClient,
  id: string,
  input: { escrowId: bigint; stellarTxHash: string; sorobanContractId: string },
) {
  const result = await tx.paymentIntent.updateMany({
    where: { id, status: 'created' },
    data: { status: 'escrowed', ...input },
  });
  return result.count === 1 ? tx.paymentIntent.findUniqueOrThrow({ where: { id } }) : null;
}

export async function markStatus(
  tx: Prisma.TransactionClient,
  id: string,
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
) {
  const result = await tx.paymentIntent.updateMany({ where: { id, status: from }, data: { status: to } });
  return result.count === 1 ? tx.paymentIntent.findUniqueOrThrow({ where: { id } }) : null;
}
