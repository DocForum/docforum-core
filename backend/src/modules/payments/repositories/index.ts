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

/** Same reasoning as above, for the (placeholder) patients module. */
export function findPatientProfileByUserId(userId: string) {
  return prisma.patientProfile.findUnique({ where: { userId } });
}

// --- Wallet links (issue #78) --------------------------------------------
// NOTE ON WRITES: `createWalletLink` is the only WalletLink insert in
// the repo, and its sole caller is the SEP-10 verification flow in
// services/wallet-link.ts (inside the transaction that consumes the
// nonce). There is deliberately no upsert/raw-address write path and no
// legacy-creation function — `unverified_legacy` rows can only come from
// the migration backfill.

export function createWalletLink(
  data: {
    ownerType: WalletLinkOwnerType;
    ownerId: string;
    stellarPublicKey: string;
    verificationMethod: 'sep10';
    verifiedAt: Date;
    activeOwnerKey: string;
  },
  db: Db = prisma,
) {
  return db.walletLink.create({ data });
}

export function findActiveWalletLink(ownerType: WalletLinkOwnerType, ownerId: string, db: Db = prisma) {
  return db.walletLink.findFirst({
    where: { ownerType, ownerId, replacedAt: null },
    orderBy: { createdAt: 'desc' },
  });
}

/** Deactivates the owner's current link (if any) — conditional
 * `updateMany`, so only an unreplaced row moves. Returns the number of
 * rows deactivated (0 = owner had no active link; 1 = normal re-link).
 * Paired with the unique `activeOwnerKey`, this is what makes "one
 * active link per owner" hold under concurrency: the insert that follows
 * can only succeed once the sentinel key is free. */
export function deactivateActiveWalletLink(
  ownerType: WalletLinkOwnerType,
  ownerId: string,
  now: Date,
  db: Db = prisma,
) {
  return db.walletLink.updateMany({
    where: { ownerType, ownerId, replacedAt: null },
    data: { replacedAt: now, activeOwnerKey: null },
  });
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

/** Existence check for the account-deletion retention hold (issue #41). */
export async function patientHasPaymentIntents(patientProfileId: string): Promise<boolean> {
  return (await prisma.paymentIntent.findFirst({ where: { patientProfileId }, select: { id: true } })) !== null;
}
