// payments repositories — PaymentIntent, WalletLink and PatientWalletLink
// data access only. Never store PHI here. Never call docforum-escrow
// directly from here — go through services/.
import { prisma } from '../../../db/prisma-client';
import type { PaymentIntent, PaymentIntentStatus, Prisma, WalletLinkOwnerType } from '@prisma/client';

type Db = Prisma.TransactionClient;

// findFacilityProfileByUserId and findPatientProfileByUserId removed in
// issue #318 — payments now calls the owning module's service directly.

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
    // Issue #328: when the link may first be used as an escrow payee.
    effectiveAt: Date;
  },
  db: Db = prisma,
) {
  return db.walletLink.create({ data });
}

/** Issue #328: every link for an owner that had taken effect by `now`,
 * newest effectiveAt first. The caller (selectEffectiveWalletLink) drops
 * cancelled rows; an owner has a handful of rows, so the cap is generous. */
export function findWalletLinksEffectiveBy(
  ownerType: WalletLinkOwnerType,
  ownerId: string,
  now: Date,
  db: Db = prisma,
) {
  return db.walletLink.findMany({
    where: { ownerType, ownerId, effectiveAt: { lte: now } },
    orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }],
    take: 50,
  });
}

/** Issue #328: has this owner ever had a link? Decides the first-link
 * exemption from the cool-down. */
export function countWalletLinks(ownerType: WalletLinkOwnerType, ownerId: string, db: Db = prisma) {
  return db.walletLink.count({ where: { ownerType, ownerId } });
}

/** Issue #328: the facility's links for one address — the release guard
 * checks the address an escrow was funded to took effect. */
export function findFacilityWalletLinksByAccount(facilityId: string, stellarPublicKey: string) {
  return prisma.walletLink.findMany({
    where: { ownerType: 'facility', ownerId: facilityId, stellarPublicKey },
  });
}

/** Issue #328: active facility links still inside their cool-down. */
export function findPendingFacilityWalletLinks(now: Date, take: number) {
  return prisma.walletLink.findMany({
    where: { ownerType: 'facility', replacedAt: null, effectiveAt: { gt: now } },
    orderBy: [{ effectiveAt: 'asc' }, { id: 'asc' }],
    take,
  });
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
  assetCode: string;
  tokenContractId: string;
  amount: bigint;
}) {
  const orderPointer = input.orderType === 'prescription'
    ? { prescriptionId: input.orderId, labOrderId: null }
    : { prescriptionId: null, labOrderId: input.orderId };
  return prisma.paymentIntent.create({
    data: {
      ...orderPointer,
      patientProfileId: input.patientProfileId,
      facilityId: input.facilityId,
      assetCode: input.assetCode,
      tokenContractId: input.tokenContractId,
      amount: input.amount,
    },
  });
}

export function findPaymentIntentById(id: string) {
  return prisma.paymentIntent.findUnique({ where: { id } });
}

/** The intent attached to an order, addressed by its typed order FK
 * (issue #85) — never by a string `orderType` + `orderId` pair. */
export function findPaymentIntentByOrder(
  orderType: 'prescription' | 'lab_order',
  orderId: string,
) {
  return prisma.paymentIntent.findFirst({
    where: orderType === 'prescription' ? { prescriptionId: orderId } : { labOrderId: orderId },
  });
}

/** The login user who owns a patient profile — used to address the refund
 * notification (issue #84). Not a clinical read: id only. */
// findPatientUserIdByProfileId removed in issue #318 — call
// patientsService.getPatientUserIdByProfileId instead.

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

/** Aggregate each lifecycle bucket, per asset, in PostgreSQL. The amount
 * stays BigInt end to end; mixing assets in one total would be meaningless. */
export function aggregateFacilityPayments(facilityId: string, from?: Date, to?: Date) {
  return prisma.paymentIntent.groupBy({
    by: ['status', 'assetCode'],
    where: {
      facilityId,
      status: { in: ['escrowed', 'released', 'refunded'] },
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    _sum: { amount: true },
  });
}

// findFacilityNamesByIds removed in issue #318 — call
// facilitiesService.getFacilityNamesByIds instead.

/**
 * Status writes are conditional on the state the caller observed (issue
 * #43): `created -> funding`, `funding -> escrowed|created`,
 * `created -> awaiting_signature`, `awaiting_signature -> created`
 * (expiry), `escrowed -> released|refunded`.
 * They run in the caller's transaction alongside the AuditEvent, and return
 * null if the row was no longer in the expected state (a concurrent action
 * won), so an audit event can never claim a transition that didn't happen.
 */

/** Claim an intent for funding (issue #24) — ONE conditional UPDATE, so of
 * N concurrent fund requests exactly one moves `created -> funding` and the
 * rest get null. This is the DB-level equivalent of booking's conditional
 * slot update (ARCHITECTURE.md §5.1): the guard is the WHERE clause, not an
 * in-process lock that would be correct on one instance and broken on two. */
export async function claimForFunding(
  tx: Prisma.TransactionClient,
  id: string,
  now: Date,
): Promise<PaymentIntent | null> {
  // No version bump: the claim is an internal reservation, like
  // `created -> awaiting_signature` (issue #80). The externally visible
  // transition is the settle write, so a funded intent still advances its
  // version exactly once and existing ETag/If-Match clients see no change.
  const result = await tx.paymentIntent.updateMany({
    where: { id, status: 'created' },
    data: { status: 'funding', fundingStartedAt: now },
  });
  return result.count === 1 ? tx.paymentIntent.findUniqueOrThrow({ where: { id } }) : null;
}

/** `funding -> created` after the chain call failed. Conditional, so a
 * request that lost its claim can never clobber the winner's row. */
export async function releaseFundingClaim(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<PaymentIntent | null> {
  const result = await tx.paymentIntent.updateMany({
    where: { id, status: 'funding' },
    data: { status: 'created', fundingStartedAt: null },
  });
  return result.count === 1 ? tx.paymentIntent.findUniqueOrThrow({ where: { id } }) : null;
}

export async function markEscrowed(
  tx: Prisma.TransactionClient,
  id: string,
  input: {
    escrowId: bigint;
    stellarTxHash: string;
    sorobanContractId: string;
    tokenContractId?: string;
    fundedWalletAddress?: string;
  },
) {
  const result = await tx.paymentIntent.updateMany({
    where: { id, status: 'funding' },
    data: { status: 'escrowed', fundingStartedAt: null, ...input, version: { increment: 1 } },
  });
  return result.count === 1 ? tx.paymentIntent.findUniqueOrThrow({ where: { id } }) : null;
}

/** Stuck `funding` claims for reconciliation (issue #24): oldest claim
 * first, so a page always makes progress. */
export function findStaleFundingClaims(olderThan: Date, take: number): Promise<PaymentIntent[]> {
  return prisma.paymentIntent.findMany({
    where: { status: 'funding', fundingStartedAt: { lt: olderThan } },
    orderBy: [{ fundingStartedAt: 'asc' }, { id: 'asc' }],
    take,
  });
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
  const result = await tx.paymentIntent.updateMany({
    where: { id, status: from },
    data: { status: to, version: { increment: 1 } },
  });
  return result.count === 1 ? tx.paymentIntent.findUniqueOrThrow({ where: { id } }) : null;
}

/** Existence check for the account-deletion retention hold (issue #41). */
export async function patientHasPaymentIntents(patientProfileId: string): Promise<boolean> {
  return (await prisma.paymentIntent.findFirst({ where: { patientProfileId }, select: { id: true } })) !== null;
}

// --- SEP-10 (Stellar Web Authentication) — issue #77 ----------------------
// One row per issued challenge. The nonce comes from the challenge
// transaction's first Manage Data op; its uniqueness makes a challenge
// single-use at the DB level.

export function createSep10Challenge(input: { userId: string; account: string; nonce: string; expiresAt: Date }) {
  return prisma.sep10Challenge.create({ data: input });
}


export function findSep10ChallengeByNonce(nonce: string, db: Db = prisma) {
  return db.sep10Challenge.findUnique({ where: { nonce } });
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

/** Retention prune (issue #276): deletes up to `batchSize` SEP-10 challenge
 * rows that expired or were consumed before `cutoff`. An unexpired,
 * unconsumed challenge never matches. */
export function pruneExpiredSep10Challenges(options: { cutoff: Date; batchSize: number }) {
  return prisma.$executeRaw`
    DELETE FROM "Sep10Challenge"
    WHERE "id" IN (
      SELECT "id" FROM "Sep10Challenge"
      WHERE "expiresAt" < ${options.cutoff}
         OR ("consumedAt" IS NOT NULL AND "consumedAt" < ${options.cutoff})
      ORDER BY "expiresAt" ASC
      LIMIT ${options.batchSize}
    )
  `;
}

/** Runs `fn` inside ONE interactive transaction with a generous timeout
 * (the wallet-link flow performs a Horizon lookup inside it). Single
 * place the service layer opens transactions, so the Prisma client
 * stays a repository concern. */
export function inTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { timeout: 15_000 });
}


export async function markSubmitting(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<PaymentIntent | null> {
  const result = await tx.paymentIntent.updateMany({
    where: { id, status: 'awaiting_signature' },
    data: { status: 'submitting' },
  });
  return result.count === 1 ? tx.paymentIntent.findUniqueOrThrow({ where: { id } }) : null;
}

export async function markSubmitted(
  tx: Prisma.TransactionClient,
  id: string,
  input: { escrowId: bigint; stellarTxHash: string; sorobanContractId: string },
): Promise<PaymentIntent | null> {
  const result = await tx.paymentIntent.updateMany({
    where: { id, status: 'submitting' },
    data: { status: 'escrowed', ...input, version: { increment: 1 } },
  });
  return result.count === 1 ? tx.paymentIntent.findUniqueOrThrow({ where: { id } }) : null;
}

export async function releaseSubmittingClaim(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<PaymentIntent | null> {
  const result = await tx.paymentIntent.updateMany({
    where: { id, status: 'submitting' },
    data: { status: 'awaiting_signature' },
  });
  return result.count === 1 ? tx.paymentIntent.findUniqueOrThrow({ where: { id } }) : null;
}
