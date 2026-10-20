// payments repositories — PaymentIntent, WalletLink and PatientWalletLink
// data access only. Never store PHI here. Never call docforum-escrow
// directly from here — go through services/.
import { prisma } from '../../../db/prisma-client';
import type { PaymentIntent, PaymentIntentStatus, Prisma } from '@prisma/client';

/** Reads FacilityProfile directly — a Phase 1 core identity model, not
 * something the (still-placeholder) facilities module exclusively owns. */
export function findFacilityProfileByUserId(userId: string) {
  return prisma.facilityProfile.findUnique({ where: { userId } });
}

/** Same reasoning as findFacilityProfileByUserId — PatientProfile is a
 * Phase 1 identity model, and the payments module needs the caller's
 * patient-scoped id to own-check an intent (issue #80). */
export function findPatientProfileByUserId(userId: string) {
  return prisma.patientProfile.findUnique({ where: { userId } });
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

/** Same FacilityProfile read this module already does for its own
 * payee lookups (see findFacilityProfileByUserId). */
export function findFacilityNamesByIds(ids: string[]) {
  return prisma.facilityProfile.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
}

/**
 * Status writes are conditional on the state the caller observed (issue
 * #43): `created -> escrowed`, `created -> awaiting_signature`,
 * `awaiting_signature -> created` (expiry), `escrowed -> released|refunded`.
 * They run in the caller's transaction alongside the AuditEvent, and return
 * null if the row was no longer in the expected state (a concurrent action
 * won), so an audit event can never claim a transition that didn't happen.
 * The check-then-act gap before the on-chain call is issue #24's to close.
 */
export async function markEscrowed(
  tx: Prisma.TransactionClient,
  id: string,
  input: { escrowId: bigint; stellarTxHash: string; sorobanContractId: string; tokenContractId?: string },
) {
  const result = await tx.paymentIntent.updateMany({
    where: { id, status: 'created' },
    data: { status: 'escrowed', ...input },
  });
  return result.count === 1 ? tx.paymentIntent.findUniqueOrThrow({ where: { id } }) : null;
}

/** `created -> awaiting_signature` (issue #80). Conditional, so two
 * concurrent prepare requests can never both produce a live transaction. */
export async function markAwaitingSignature(
  tx: Prisma.TransactionClient,
  id: string,
  input: {
    preparedTxHash: string;
    preparedXdr: string;
    preparedExpiryLedger: number;
    preparedExpiresAt: Date;
    refundAfter: Date;
  },
): Promise<PaymentIntent | null> {
  const result = await tx.paymentIntent.updateMany({
    where: { id, status: 'created' },
    data: { status: 'awaiting_signature', ...input },
  });
  return result.count === 1 ? tx.paymentIntent.findUniqueOrThrow({ where: { id } }) : null;
}

/** `awaiting_signature -> created`, only if the prepared transaction is
 * actually past its window (issue #80). A prepare that raced this update
 * sees zero rows and re-reads instead of clobbering it. */
export async function expirePrepared(
  tx: Prisma.TransactionClient,
  id: string,
  now: Date,
): Promise<PaymentIntent | null> {
  const result = await tx.paymentIntent.updateMany({
    where: { id, status: 'awaiting_signature', preparedExpiresAt: { lte: now } },
    data: {
      status: 'created',
      preparedTxHash: null,
      preparedXdr: null,
      preparedExpiryLedger: null,
      preparedExpiresAt: null,
      refundAfter: null,
    },
  });
  return result.count === 1 ? tx.paymentIntent.findUniqueOrThrow({ where: { id } }) : null;
}

/** Ids for one expiry-sweep page, oldest deadline first. */
export function findExpiredPreparedIntentIds(now: Date, take: number): Promise<string[]> {
  return prisma.paymentIntent
    .findMany({
      where: { status: 'awaiting_signature', preparedExpiresAt: { lte: now } },
      orderBy: [{ preparedExpiresAt: 'asc' }, { id: 'asc' }],
      take,
      select: { id: true },
    })
    .then((rows) => rows.map((row) => row.id));
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
