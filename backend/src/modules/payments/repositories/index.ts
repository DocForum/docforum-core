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

export function markEscrowed(id: string, input: { escrowId: bigint; stellarTxHash: string; sorobanContractId: string }) {
  return prisma.paymentIntent.update({
    where: { id },
    data: { status: 'escrowed', ...input },
  });
}

export function markStatus(id: string, status: PaymentIntentStatus) {
  return prisma.paymentIntent.update({ where: { id }, data: { status } });
}
