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

/** Atomically consumes a challenge — ONE conditional UPDATE, no
 * read-then-write. Only a row that is still unconsumed AND unexpired
 * moves to `consumedAt`; the returned `count` tells the caller whether
 * THIS request won the race. Two concurrent replays of the same signed
 * challenge can never both see `count === 1`. Same DB-level pattern as
 * booking's conditional slot update (ARCHITECTURE.md §5.1).
 * Takes an optional transaction client so the wallet-link flow can
 * consume the nonce and write the link in ONE transaction (issue #78). */
export function consumeSep10Challenge(nonce: string, consumedAt: Date, db: Db = prisma) {
  return db.sep10Challenge.updateMany({
    where: { nonce, consumedAt: null, expiresAt: { gt: consumedAt } },
    data: { consumedAt },
  });
}

export function findSep10ChallengeByNonce(nonce: string, db: Db = prisma) {
  return db.sep10Challenge.findUnique({ where: { nonce } });
}

/** Runs `fn` inside ONE interactive transaction with a generous timeout
 * (the wallet-link flow performs a Horizon lookup inside it). Single
 * place the service layer opens transactions, so the Prisma client
 * stays a repository concern. */
export function inTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { timeout: 15_000 });
}
