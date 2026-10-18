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

export function createPaymentIntent(input: {
  orderType: 'prescription' | 'lab_order';
  orderId: string;
  patientProfileId: string;
  facilityId: string;
  amountStroops: bigint;
}) {
  return prisma.paymentIntent.create({ data: input });
}

export function findPaymentIntentById(id: string) {
  return prisma.paymentIntent.findUnique({ where: { id } });
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

// --- SEP-10 (Stellar Web Authentication) — issue #77 ----------------------
// One row per issued challenge. The nonce comes from the challenge
// transaction's first Manage Data op; its uniqueness makes a challenge
// single-use at the DB level.

export function createSep10Challenge(input: { userId: string; account: string; nonce: string; expiresAt: Date }) {
  return prisma.sep10Challenge.create({ data: input });
}

export function findSep10ChallengeByNonce(nonce: string) {
  return prisma.sep10Challenge.findUnique({ where: { nonce } });
}

/** Atomically consumes a challenge — ONE conditional UPDATE, no
 * read-then-write. Only a row that is still unconsumed AND unexpired
 * moves to `consumedAt`; the returned `count` tells the caller whether
 * THIS request won the race. Two concurrent replays of the same signed
 * challenge can never both see `count === 1`. Same DB-level pattern as
 * booking's conditional slot update (ARCHITECTURE.md §5.1). */
export function consumeSep10Challenge(nonce: string, consumedAt: Date) {
  return prisma.sep10Challenge.updateMany({
    where: { nonce, consumedAt: null, expiresAt: { gt: consumedAt } },
    data: { consumedAt },
  });
}
