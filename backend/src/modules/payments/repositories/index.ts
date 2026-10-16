// payments repositories — PaymentIntent, WalletLink data access only.
// Never store PHI here. Never call docforum-escrow directly from here —
// go through services/.
import { prisma } from '../../../db/prisma-client';
import type { PaymentIntentStatus } from '@prisma/client';

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

export function markEscrowed(id: string, input: { escrowId: bigint; stellarTxHash: string; sorobanContractId: string }) {
  return prisma.paymentIntent.update({
    where: { id },
    data: { status: 'escrowed', ...input },
  });
}

export function markStatus(id: string, status: PaymentIntentStatus) {
  return prisma.paymentIntent.update({ where: { id }, data: { status } });
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
