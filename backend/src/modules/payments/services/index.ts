// payments services — this module owns PaymentIntent/WalletLink/
// PatientWalletLink (relational metadata only — no PHI ever passes through
// here) and delegates actual escrow contract calls to
// @docforum/escrow-sdk. This module does NOT reimplement contract logic — it
// calls the SDK, persists the resulting tx hash/status, and exposes that
// status to other core modules through this services/ interface, per
// AGENTS.md module-boundary rule.
//
// Custodial v1 (see docs/adr/0004-custodial-payments-v1.md) still funds
// escrows from the platform's own payer identity. ADR 0005 adds the
// non-custodial path: issue #79 made the asset explicit per intent, and
// issue #80 adds prepare(), which builds the patient-signed transaction.
// Release/refund are unchanged.
import { HttpError } from '../../../http-error';
import { logger } from '../../../logger';
import { config, type PaymentAsset } from '../../../config';
import type { PaymentIntent, PaymentIntentStatus } from '@prisma/client';
import * as paymentsRepo from '../repositories';
import { loadEscrowSdk, type EscrowSdkKeypair } from './escrow-sdk-loader';
import { hasTrustline } from './trustline';
import { getPlatformSigners } from './platform-signers';
import { resolveEscrowPayee } from './payout-privacy';
import { getMyPatientProfile, getPatientUserIdByProfileId, findPatientProfileByUserId, paginate, type PatientExportSection } from '../../patients/services';
import { findFacilityProfileByUserId, findFacilityProfileById, getFacilityNamesByIds } from '../../facilities/services';
import { prisma } from '../../../db/prisma-client';
import { parseStroopsAmount } from '../../../utils/stroops';
import * as auditService from '../../audit/services';
import * as flagsService from '../../flags/services';
import * as notificationsService from '../../notifications/services';
import type { Prisma } from '@prisma/client';
import { transitionPaymentIntentStatus } from './state-machine';
import { facilityLedgerCsvChunks, type LedgerCsvFilters } from './ledger-csv';
// Types are inferred from the prisma instance; use 'as' assertions where needed

import {
  assertEscrowPayeeEffective,
  assertWalletLinkFundingAllowed,
  findEffectiveWalletLink,
  requireEffectiveFacilityPayee,
  writeWalletLink,
} from './wallet-link';

// SEP-10 Stellar Web Authentication (issue #77). Re-exported through
// this module's service surface (not imported file-by-file from outside)
// per the AGENTS.md module-boundary rule — same pattern as the auth
// module's token/throttle re-exports.
export {
  createSep10Challenge,
  pruneExpiredSep10Challenges,
  verifySep10Challenge,
  resetSep10AccountFetcher,
  setSep10AccountFetcher,
  validateSep10Config,
} from './sep10';
export type { Sep10AccountFetcher, Sep10AccountInfo, Sep10ChallengeResponse, Sep10Signer, Sep10VerifyResult } from './sep10';

// Verified wallet links (issue #78) — SEP-10-only link creation,
// owner-scoped reads, the funding-cutoff guard, and the ADR 0005
// privacy notice constant, all through this module's service surface.
export {
  PATIENT_WALLET_LINK_PRIVACY_NOTICE,
  assertWalletLinkFundingAllowed,
  getOwnWalletLink,
  linkWalletViaSep10,
  validateWalletLinkConfig,
  walletLinkFundingAllowed,
  // Issue #328: payout-change cool-down.
  assertEscrowPayeeEffective,
  findEffectiveWalletLink,
  listPendingFacilityWalletLinks,
  selectEffectiveWalletLink,
} from './wallet-link';
export type { PendingWalletLinkChange, WalletLinkOwner } from './wallet-link';

// Test seams re-exported through the service surface (same convention as the
// auth module's setEmailSender) — see escrow-sdk-loader.ts and trustline.ts.
export { setEscrowSdkForTests, resetEscrowSdkOverride, setEscrowSdkOverride } from './escrow-sdk-loader';
export type { EscrowSdkForTests } from './escrow-sdk-loader';
export { listEscrowEvents } from './escrow-events';
export type { EscrowSdkModule } from './escrow-sdk-loader';
export { setTrustlineCheckerForTests } from './trustline';
export type { TrustlineChecker } from './trustline';

/**
 * The prepare half of ADR 0005 step 2. `@docforum/escrow-sdk` 0.2.0 (the
 * version this repo currently depends on) has no prepare call — that is
 * docforum-escrow issue #58 / SDK 0.3.0, and issue #80 depends on it. The
 * types below are the contract this module codes against; when the SDK
 * publishes it, only `prepareCreateEscrow` below needs to be typed more
 * strictly. Until then the call is detected at runtime and the endpoint
 * returns a clear 503 instead of pretending to prepare something it can't.
 */
export interface PrepareCreateEscrowParams {
  payer: string;
  payee: string;
  token: string;
  amount: bigint;
  conditionRef: string;
  releaser: string;
  /** Unix seconds, matching the contract's `refund_after` (ADR 0005). */
  refundAfter: bigint;
}

export interface PreparedCreateEscrow {
  xdr: string;
  txHash: string;
  expiryLedger: number;
}

interface PrepareCapableClient {
  prepareCreateEscrow?: (params: PrepareCreateEscrowParams) => Promise<PreparedCreateEscrow>;
}

async function requirePaymentsConfig() {
  // The per-asset token contract comes from the intent (issue #79), so the
  // legacy ESCROW_TOKEN_ID is no longer required for every payment path.
  const { activeContractId } = config.payments;
  if (!activeContractId) {
    throw new HttpError(500, 'Payments is not configured — missing env var(s): activeContractId.');
  }
  const { payer, releaser } = await getPlatformSigners();
  return {
    platformPayer: payer,
    platformReleaser: releaser,
    escrowContractId: activeContractId,
  };
}
async function escrowClient(contractId: string) {
  const { EscrowClient } = await loadEscrowSdk();
  return new EscrowClient({ contractId, rpcUrl: config.payments.rpcUrl, networkPassphrase: config.payments.networkPassphrase });
}

export async function verifyPaymentsNetwork(): Promise<void> {
  const { startupCheckEnabled, activeContractId, healthCheckEscrowId } = config.payments;
  if (!startupCheckEnabled) return;
  if (!activeContractId || healthCheckEscrowId === null) {
    throw new Error('Payments startup verification is enabled without an active contract and health-check escrow.');
  }
  try {
    await (await escrowClient(activeContractId)).getStatus(healthCheckEscrowId);
  } catch (cause) {
    throw new Error('Payments startup verification failed: active escrow contract is unreachable or the configured health-check escrow is invalid.', { cause });
  }
}

function requireRecordedContractId(intent: { sorobanContractId: string | null }): string {
  const contractId = intent.sorobanContractId;
  if (!contractId) throw new HttpError(409, 'PaymentIntent has no recorded escrow contract id.');
  if (!config.payments.contractIds.includes(contractId)) {
    throw new HttpError(409, 'PaymentIntent references an unregistered escrow contract.');
  }
  return contractId;
}
export async function getOwnFacilityProfileId(userId: string): Promise<string> {
  const profile = await findFacilityProfileByUserId(userId);
  if (!profile) throw new HttpError(403, 'No facility profile is associated with this account.');
  return profile.id;
}

/** The caller's patient profile id — every patient-scoped payment read is
 * owned through this, never through a client-supplied profile id. */
export async function getOwnPatientProfileId(userId: string): Promise<string> {
  const profile = await findPatientProfileByUserId(userId);
  if (!profile) throw new HttpError(403, 'No patient profile is associated with this account.');
  return profile.id;
}

/** Test-fixture helper (integration + testnet suites). Goes through the
 * same writer as the SEP-10 flow, so it is audited and subject to the
 * issue #328 cool-down like every other link. */
export async function linkWallet(facilityId: string, stellarPublicKey: string, now = new Date()) {
  return paymentsRepo.inTransaction((tx) =>
    writeWalletLink(tx, auditService.SYSTEM_ACTOR, { ownerType: 'facility', ownerId: facilityId }, stellarPublicKey, now),
  );
}

/** The facility's EFFECTIVE payout link (issue #328) — a link still inside
 * its cool-down is never returned here. */
export function getWalletLink(facilityId: string) {
  return findEffectiveWalletLink('facility', facilityId);
}

export function getPatientWalletLink(patientProfileId: string) {
  return paymentsRepo.findActiveWalletLink('patient', patientProfileId);
}

/** The per-environment allowlist (issue #79). An intent may only be created
 * in one of these assets. */
export function listPaymentAssets(): PaymentAsset[] {
  return config.payments.assets;
}

function resolveAsset(code: string): PaymentAsset {
  const asset = config.payments.assets.find((candidate) => candidate.code === code);
  if (!asset) {
    throw new HttpError(
      400,
      `Unsupported payment asset '${code}'. Allowed: ${config.payments.assets.map((a) => a.code).join(', ')}.`,
      'UNSUPPORTED_PAYMENT_ASSET',
    );
  }
  return asset;
}

/**
 * Resolves the asset recorded on an intent. Rows created before issue #79
 * have no `tokenContractId` and were native XLM funded against
 * `ESCROW_TOKEN_ID` — the documented legacy fallback. The allowlist only
 * supplies `decimals`/`issuer` for the response; the stored contract id
 * wins so an intent keeps paying the asset it was denominated in even if
 * the allowlist entry is later rotated.
 */
function resolveAssetForIntent(intent: PaymentIntent): PaymentAsset {
  const configured = config.payments.assets.find((asset) => asset.code === intent.assetCode);
  const tokenContractId =
    intent.tokenContractId ??
    (intent.assetCode === 'XLM' ? config.payments.escrowTokenId : undefined) ??
    configured?.tokenContractId;
  if (!tokenContractId) {
    throw new HttpError(
      409,
      `PaymentIntent uses asset '${intent.assetCode}', whose token contract is not configured.`,
      'PAYMENT_ASSET_NOT_CONFIGURED',
    );
  }
  return {
    code: intent.assetCode,
    tokenContractId,
    decimals: configured?.decimals ?? 0,
    ...(configured?.issuer ? { issuer: configured.issuer } : {}),
  };
}

/** Checks the payee can hold the asset before any on-chain call. Native XLM
 * passes unconditionally; an issued asset needs an authorised trustline. */
async function requirePayeeTrustline(payee: string, asset: PaymentAsset): Promise<void> {
  if (!asset.issuer) return;
  if (!(await hasTrustline(payee, asset))) {
    throw new HttpError(
      409,
      `The facility's linked wallet has no trustline for ${asset.code}. Ask the facility to link a wallet that can hold ${asset.code}.`,
      'PAYEE_TRUSTLINE_MISSING',
    );
  }
}

export interface CreatePaymentIntentInput {
  orderType: 'prescription' | 'lab_order';
  orderId: string;
  patientProfileId: string;
  facilityId: string;
  assetCode: string;
  /** Smallest unit of `assetCode`. */
  amount: bigint;
}

export function createPaymentIntent(input: CreatePaymentIntentInput) {
  if (input.amount <= 0n) throw new HttpError(400, 'amount must be positive.');
  const asset = resolveAsset(input.assetCode);
  return paymentsRepo.createPaymentIntent({
    orderType: input.orderType,
    orderId: input.orderId,
    patientProfileId: input.patientProfileId,
    facilityId: input.facilityId,
    assetCode: asset.code,
    tokenContractId: asset.tokenContractId,
    amount: input.amount,
  });
}

/** Called by the orders module inside the order-issuance transaction. A
 * created intent moves to a corrected order; any funded/terminal intent
 * stays attached to the immutable original order.
 *
 * `catalogItemCode` is snapshotted alongside the amount: the amount is the
 * facility price in force when the doctor selected the facility, so a later
 * price-list change cannot re-price an existing intent (issue #127). */
export async function createIntentForIssuedOrder(tx: Prisma.TransactionClient, input: {
  kind: 'prescription' | 'lab_order'; orderId: string; patientProfileId: string; doctorProfileId: string;
  facilityProfileId: string; amountStroops: bigint; supersedesId: string | null;
  catalogItemCode?: string | null;
}) {
  // Same guard the facility price list uses: positive integer stroops that
  // fit the asset's precision and the contract's i128 amount. Orders are
  // still priced in native XLM; issue #79 made the intent's asset explicit
  // so this write path has to name it rather than imply it.
  const amountStroops = parseStroopsAmount(input.amountStroops, 'amountStroops');
  const asset = resolveAsset('XLM');
  const catalogItemCode = input.catalogItemCode ?? null;
  const facility = await findFacilityProfileById(input.facilityProfileId, tx);
  const expectedType = input.kind === 'prescription' ? 'pharmacy' : 'lab';
  if (!facility || facility.type !== expectedType) throw new HttpError(400, `The selected facility must be a ${expectedType} facility.`);

  const orderPointer = input.kind === 'prescription'
    ? { prescriptionId: input.orderId, labOrderId: null }
    : { prescriptionId: null, labOrderId: input.orderId };
  if (input.supersedesId) {
    const previous = await tx.paymentIntent.findFirst({
      where: input.kind === 'prescription' ? { prescriptionId: input.supersedesId } : { labOrderId: input.supersedesId },
    });
    if (previous?.status === 'created') {
      const moved = await tx.paymentIntent.updateMany({
        where: { id: previous.id, status: 'created' },
        data: {
          ...orderPointer,
          patientProfileId: input.patientProfileId,
          facilityId: input.facilityProfileId,
          amount: amountStroops,
          assetCode: asset.code,
          tokenContractId: asset.tokenContractId,
          catalogItemCode,
        },
      });
      if (moved.count === 1) return tx.paymentIntent.findUniqueOrThrow({ where: { id: previous.id } });
    }
  }
  return tx.paymentIntent.create({
    data: {
      ...orderPointer,
      patientProfileId: input.patientProfileId,
      facilityId: input.facilityProfileId,
      amount: amountStroops,
      assetCode: asset.code,
      tokenContractId: asset.tokenContractId,
      catalogItemCode,
    },
  });
}

export async function getPaymentIntent(id: string) {
  const intent = await paymentsRepo.findPaymentIntentById(id);
  if (!intent) throw new HttpError(404, 'PaymentIntent not found.');
  return intent;
}

export interface PaymentHistoryFilters {
  status?: PaymentIntentStatus;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

function encodePaymentCursor(payment: { createdAt: Date; id: string }): string {
  return Buffer.from(`${payment.createdAt.toISOString()}|${payment.id}`, 'utf8').toString('base64url');
}

function decodePaymentCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf('|');
  const createdAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (separator < 1 || Number.isNaN(createdAt.getTime()) || !id) {
    throw new HttpError(400, 'Invalid cursor.', 'INVALID_CURSOR');
  }
  return { createdAt, id };
}

function paymentPage(filters: PaymentHistoryFilters, owner: { patientProfileId: string } | { facilityId: string }) {
  return paymentsRepo.findPaymentHistoryPage(owner, {
    status: filters.status,
    from: filters.from,
    to: filters.to,
    before: filters.cursor ? decodePaymentCursor(filters.cursor) : undefined,
    take: filters.limit + 1,
  });
}

function serializeAsset(code: string) {
  return { type: code === 'XLM' ? 'native' : 'issued', code };
}

function serializePayment(payment: PaymentIntent) {
  return {
    id: payment.id,
    orderType: payment.prescriptionId ? 'prescription' : 'lab_order',
    orderId: payment.prescriptionId ?? payment.labOrderId,
    status: payment.status,
    amount: payment.amount.toString(),
    assetCode: payment.assetCode,
    asset: serializeAsset(payment.assetCode),
    escrowId: payment.escrowId?.toString() ?? null,
    stellarTxHash: payment.stellarTxHash,
    sorobanContractId: payment.sorobanContractId,
    refundAfter: payment.refundAfter,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

async function listPayments(filters: PaymentHistoryFilters, owner: { patientProfileId: string } | { facilityId: string }) {
  const rows = await paymentPage(filters, owner);
  const page = rows.slice(0, filters.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(serializePayment),
    nextCursor: rows.length > filters.limit && last ? encodePaymentCursor(last) : null,
  };
}

export async function listMyPayments(userId: string, filters: PaymentHistoryFilters) {
  const profile = await getMyPatientProfile(userId);
  return listPayments(filters, { patientProfileId: profile.id });
}

export async function listFacilityPaymentLedger(userId: string, filters: PaymentHistoryFilters) {
  const facilityId = await getOwnFacilityProfileId(userId);
  const [page, aggregates] = await Promise.all([
    listPayments(filters, { facilityId }),
    paymentsRepo.aggregateFacilityPayments(facilityId, filters.from, filters.to),
  ]);
  // Totals are per asset: summing XLM and USDC smallest units would be
  // meaningless, so each allowlisted asset gets its own row.
  const totalsByAsset = new Map<string, Map<string, bigint>>();
  for (const row of aggregates) {
    const byStatus = totalsByAsset.get(row.assetCode) ?? new Map<string, bigint>();
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0n) + (row._sum.amount ?? 0n));
    totalsByAsset.set(row.assetCode, byStatus);
  }
  return {
    ...page,
    totals: [...totalsByAsset.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, byStatus]) => ({
        asset: serializeAsset(code),
        escrowed: (byStatus.get('escrowed') ?? 0n).toString(),
        released: (byStatus.get('released') ?? 0n).toString(),
        refunded: (byStatus.get('refunded') ?? 0n).toString(),
      })),
  };
}

/** GET /payments/facility/ledger.csv (issue #329). Resolves the caller's
 * facility BEFORE returning, so a non-facility caller gets its 403 while
 * the response is still a normal JSON error, then hands back a lazy chunk
 * stream (never a buffered document). */
export async function openFacilityLedgerCsv(userId: string, filters: LedgerCsvFilters): Promise<AsyncGenerator<string>> {
  const facilityId = await getOwnFacilityProfileId(userId);
  return facilityLedgerCsvChunks(facilityId, filters);
}

/** Public, non-identifying references only: the escrow is on a public
 * ledger anyway. No patient data, no secrets. */
function intentAuditMetadata(intent: PaymentIntent) {
  return {
    orderType: intent.prescriptionId ? 'prescription' : 'lab_order',
    orderId: intent.prescriptionId ?? intent.labOrderId!,
    amount: intent.amount.toString(),
    assetCode: intent.assetCode,
    escrowId: intent.escrowId?.toString() ?? null,
    stellarTxHash: intent.stellarTxHash,
    sorobanContractId: intent.sorobanContractId,
    preparedTxHash: intent.preparedTxHash,
  };
}

/** Commits a status change and its AuditEvent together (issue #43). If the
 * row moved on concurrently, nothing is written and the caller gets 409. */
async function commitTransition(
  actor: auditService.AuditActor,
  // PaymentIntent row shape from prisma operations; use 'as' since Prisma 7
  // client types may not match the expected exports.
  intent: any,
  action: string,
  to: PaymentIntentStatus,
  write: (tx: any) => Promise<any>,
): Promise<any> {
  if (transitionPaymentIntentStatus(intent.status, to) !== to) {
    throw new HttpError(409, `PaymentIntent cannot transition from '${intent.status}' to '${to}'.`);
  }
  return prisma.$transaction(async (tx) => {
    const updated = await write(tx);
    if (!updated) {
      throw new HttpError(409, `PaymentIntent changed concurrently — it is no longer '${intent.status}'.`);
    }
    await auditService.record(tx, actor, {
      entityType: 'PaymentIntent',
      entityId: intent.id,
      action,
      fromState: intent.status,
      toState: to,
      metadata: intentAuditMetadata(updated),
    });
    return updated;
  });
}

/** Funds the escrow from the platform's own payer identity. The intent must be `created` and its facility must have a linked wallet (the on-chain payee).
 *
 * Idempotency (issue #24): the check-then-act gap that used to sit in front
 * of `createEscrow` is closed by claiming the intent `created -> funding`
 * with ONE conditional UPDATE, committed BEFORE the chain call. Only the
 * request whose UPDATE changed a row proceeds; every concurrent request, on
 * any instance, gets a 409 and makes no chain call. The claim is released
 * on a failed chain call so the caller can retry with the same id. */
export async function fundPaymentIntent(actor: auditService.AuditActor, id: string) {
  const intent = await getPaymentIntent(id);
  if (transitionPaymentIntentStatus(intent.status, 'escrowed') !== 'escrowed') {
    throw new HttpError(409, `PaymentIntent is '${intent.status}', not 'created' — cannot fund.`);
  }

  // The facility's EFFECTIVE link (issue #328): the newest link that has
  // passed its cool-down. A link changed inside the window is never the
  // payee — funding keeps using the previous effective address until then.
  const walletLink = await requireEffectiveFacilityPayee(
    intent.facilityId,
    new HttpError(409, 'The facility for this payment has no linked wallet.'),
  );
  assertWalletLinkFundingAllowed(walletLink);

  const { platformPayer, platformReleaser, escrowContractId } = await requirePaymentsConfig();
  const payee = resolveEscrowPayee({
    facilityAddress: walletLink.stellarPublicKey,
    mode: config.payments.payoutPrivacyMode,
    poolAddress: config.payments.payoutPrivacyPoolAddress,
    production: process.env.NODE_ENV === 'production',
  });

  const asset = resolveAssetForIntent(intent);
  // The trustline belongs to the address that actually receives the payout,
  // which in pooled mode is the pool rather than the facility wallet.
  await requirePayeeTrustline(payee, asset);

  const client = await escrowClient(escrowContractId);

  // Everything above is read-only, so a rejected pre-flight never leaves a
  // claim behind. The claim itself commits before the chain call.
  const claimed = await prisma.$transaction(async (tx) => {
    const row = await paymentsRepo.claimForFunding(tx, id, new Date());
    if (!row) return null;
    await auditService.record(tx, actor, {
      entityType: 'PaymentIntent',
      entityId: id,
      action: 'payment_intent.funding_started',
      fromState: 'created',
      toState: 'funding',
      metadata: intentAuditMetadata(row),
    });
    return row;
  });
  if (!claimed) {
    throw new HttpError(
      409,
      `PaymentIntent is no longer 'created' — another funding request already claimed it.`,
    );
  }

  let escrowId: bigint;
  let txHash: string;
  try {
    ({ escrowId, txHash } = await client.createEscrow({
      payer: platformPayer as unknown as EscrowSdkKeypair,
      payee,
      token: asset.tokenContractId,
      amount: intent.amount,
      // The PaymentIntent's own id is the opaque condition_ref — the
      // contract never interprets it (docforum-escrow ADR 0001); it's
      // just how we can trace an on-chain escrow back to this record.
      conditionRef: intent.id,
      releaser: platformReleaser.publicKey(),
    }));
  } catch (error) {
    // The chain call definitively failed, so no escrow exists: hand the
    // claim back so the caller can retry. If this write also fails, the row
    // stays `funding` and reconcile-escrows.ts reports it — it is never
    // silently retried, because a retry could create a second escrow.
    await prisma
      .$transaction(async (tx) => {
        const released = await paymentsRepo.releaseFundingClaim(tx, id);
        if (!released) return;
        await auditService.record(tx, actor, {
          entityType: 'PaymentIntent',
          entityId: id,
          action: 'payment_intent.funding_failed',
          fromState: 'funding',
          toState: 'created',
          metadata: intentAuditMetadata(released),
        });
      })
      .catch(() => undefined);
    throw error;
  }

  return commitTransition(actor, claimed, 'payment_intent.funded', 'escrowed', (tx) =>
    paymentsRepo.markEscrowed(tx, id, {
      escrowId,
      stellarTxHash: txHash,
      sorobanContractId: escrowContractId,
      // Legacy rows start with a null token id; record what was actually used.
      tokenContractId: asset.tokenContractId,
      fundedWalletAddress: walletLink.stellarPublicKey,
    }),
  );
}

export interface PreparePaymentIntentResult {
  intent: PaymentIntent;
  xdr: string;
  txHash: string;
  expiryLedger: number;
  expiresAt: Date;
  refundAfter: Date;
}

/** ADR 0005's refund deadline: order expiry + grace. Orders have no expiry
 * field yet (Phase 4 placeholders), so the anchor is the later of the
 * intent's creation and now — preparing a week-old intent must not hand the
 * patient a deadline that has already passed. */
function computeRefundAfter(intent: PaymentIntent, now: Date): Date {
  const anchorMs = Math.max(intent.createdAt.getTime(), now.getTime());
  const windowMs = (config.payments.orderExpiryHours + config.payments.refundGraceHours) * 60 * 60 * 1000;
  return new Date(anchorMs + windowMs);
}

/** `awaiting_signature -> created` for one intent. Returns false when it was
 * no longer in that state (a concurrent expiry or re-prepare won). */
async function expirePreparedIntent(id: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const updated = await paymentsRepo.expirePrepared(tx, id, now);
    if (!updated) return false;
    await auditService.record(tx, auditService.SYSTEM_ACTOR, {
      entityType: 'PaymentIntent',
      entityId: id,
      action: 'payment_intent.prepare_expired',
      fromState: 'awaiting_signature',
      toState: 'created',
      metadata: intentAuditMetadata(updated),
    });
    return true;
  });
}

/** Sweep used by src/jobs/payment-intents.ts. Expiry is a normal case, not
 * an error: the intent goes back to `created` so the patient can prepare
 * again. Conditional updates mean overlapping sweeps are safe. */
export async function expireStalePreparedIntents(now = new Date(), max = 100): Promise<{ expired: number }> {
  let expired = 0;
  // Drain the backlog in bounded pages; stop early if a page made no
  // progress (every row was claimed by a concurrent worker).
  for (;;) {
    const ids = await paymentsRepo.findExpiredPreparedIntentIds(now, max);
    if (ids.length === 0) break;
    let progressed = 0;
    for (const id of ids) {
      if (await expirePreparedIntent(id, now)) progressed += 1;
    }
    expired += progressed;
    if (ids.length < max || progressed === 0) break;
  }
  return { expired };
}

/**
 * Prepares a patient-signed create_escrow transaction (ADR 0005 step 2,
 * issue #80). Builds + simulates via the SDK, stores the transaction hash
 * and moves the intent to `awaiting_signature` with a conditional update.
 * The XDR is returned unsigned; the browser only hands it to the patient's
 * wallet and returns the signed bytes to the (not-yet-built) submit route.
 */
export async function preparePaymentIntent(
  actor: auditService.AuditActor,
  id: string,
  now = new Date(),
): Promise<PreparePaymentIntentResult> {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  // ADR 0005: wallet funding launches "as an option, not the default" — it is
  // behind a flag (issue #132), off until an admin enables it for a cohort.
  if (!(await flagsService.isEnabled(flagsService.WALLET_FUNDING_FLAG, { id: actor.userId, role: actor.role ?? 'patient' }))) {
    throw new HttpError(403, 'Wallet payments are not enabled for this account.', 'FEATURE_DISABLED');
  }
  const patientProfileId = await getOwnPatientProfileId(actor.userId);

  let intent = await getPaymentIntent(id);
  // 404, not 403, for someone else's intent: don't confirm it exists.
  if (intent.patientProfileId !== patientProfileId) throw new HttpError(404, 'PaymentIntent not found.');

  if (intent.status === 'awaiting_signature') {
    const live =
      intent.preparedXdr !== null &&
      intent.preparedTxHash !== null &&
      intent.preparedExpiryLedger !== null &&
      intent.preparedExpiresAt !== null &&
      intent.refundAfter !== null;
    if (!live) {
      throw new HttpError(409, 'This payment already has a prepared transaction.', 'PREPARE_ALREADY_PENDING');
    }
    // Idempotent re-prepare while the transaction is still valid: return the
    // exact same transaction instead of building a second live one.
    if (intent.preparedExpiresAt!.getTime() > now.getTime()) {
      return {
        intent,
        xdr: intent.preparedXdr!,
        txHash: intent.preparedTxHash!,
        expiryLedger: intent.preparedExpiryLedger!,
        expiresAt: intent.preparedExpiresAt!,
        refundAfter: intent.refundAfter!,
      };
    }
    // Past its window but the sweep hasn't run yet — expiry is a normal
    // case, so roll it back and prepare a fresh transaction now.
    await expirePreparedIntent(intent.id, now);
    intent = await getPaymentIntent(id);
    if (intent.status !== 'created') {
      throw new HttpError(409, `PaymentIntent is '${intent.status}', not 'created' — cannot prepare.`);
    }
  }

  if (intent.status !== 'created') {
    throw new HttpError(409, `PaymentIntent is '${intent.status}', not 'created' — cannot prepare.`);
  }

  const patientWallet = await getPatientWalletLink(patientProfileId);
  if (!patientWallet) {
    throw new HttpError(
      409,
      'No verified Stellar wallet is linked to this patient — link one before paying.',
      'WALLET_NOT_LINKED',
    );
  }

  // Issue #328: the effective payee, never a link inside its cool-down.
  const payeeWallet = await requireEffectiveFacilityPayee(
    intent.facilityId,
    new HttpError(409, 'The facility for this payment has no linked wallet.', 'FACILITY_WALLET_NOT_LINKED'),
    now,
  );

  const asset = resolveAssetForIntent(intent);
  await requirePayeeTrustline(payeeWallet.stellarPublicKey, asset);

  const { platformReleaser, escrowContractId } = await requirePaymentsConfig();
  const client = (await escrowClient(escrowContractId)) as unknown as PrepareCapableClient;
  if (typeof client.prepareCreateEscrow !== 'function') {
    throw new HttpError(
      503,
      'The installed escrow SDK cannot prepare unsigned transactions yet (requires docforum-escrow SDK 0.3.0).',
      'ESCROW_SDK_PREPARE_UNSUPPORTED',
    );
  }

  const refundAfter = computeRefundAfter(intent, now);
  const prepared = await client.prepareCreateEscrow({
    payer: patientWallet.stellarPublicKey,
    payee: payeeWallet.stellarPublicKey,
    token: asset.tokenContractId,
    amount: intent.amount,
    conditionRef: intent.id,
    releaser: platformReleaser.publicKey(),
    refundAfter: BigInt(Math.floor(refundAfter.getTime() / 1000)),
  });

  const preparedExpiresAt = new Date(now.getTime() + config.payments.prepareTtlSeconds * 1000);
  const updated = await commitTransition(actor, intent, 'payment_intent.prepared', 'awaiting_signature', (tx) =>
    paymentsRepo.markAwaitingSignature(tx, id, {
      preparedTxHash: prepared.txHash,
      preparedXdr: prepared.xdr,
      preparedExpiryLedger: prepared.expiryLedger,
      preparedExpiresAt,
      refundAfter,
    }),
  );

  return {
    intent: updated,
    xdr: prepared.xdr,
    txHash: prepared.txHash,
    expiryLedger: prepared.expiryLedger,
    expiresAt: preparedExpiresAt,
    refundAfter,
  };
}

/** Manual admin override: releases the escrow to the facility's linked wallet.
 * The primary path is automatic (`releaseEscrowForFulfilledOrder`, issue #83);
 * this remains for operators and is audited the same way. */
export async function releasePaymentIntent(actor: auditService.AuditActor, id: string) {
  const intent = await getPaymentIntent(id);
  if (transitionPaymentIntentStatus(intent.status, 'released') !== 'released' || intent.escrowId === null) {
    throw new HttpError(409, `PaymentIntent is '${intent.status}', not 'escrowed' — cannot release.`);
  }
  // Issue #328: never release to a payee that is only a not-yet-effective link.
  await assertEscrowPayeeEffective(intent);

  const { platformReleaser } = await requirePaymentsConfig();
  const client = await escrowClient(requireRecordedContractId(intent));

  await client.release({ escrowId: intent.escrowId, caller: platformReleaser as unknown as EscrowSdkKeypair });

  return commitTransition(actor, intent, 'payment_intent.released', 'released', (tx) =>
    paymentsRepo.markStatus(tx, id, 'escrowed', 'released'),
  );
}

/** Manual admin override: refunds the escrow back toward the platform payer.
 * Automatic refunds come from `refundEscrowForUnfulfilledOrder` (issue #84). */
export async function refundPaymentIntent(actor: auditService.AuditActor, id: string) {
  const intent = await getPaymentIntent(id);
  if (transitionPaymentIntentStatus(intent.status, 'refunded') !== 'refunded' || intent.escrowId === null) {
    throw new HttpError(409, `PaymentIntent is '${intent.status}', not 'escrowed' — cannot refund.`);
  }

  const { platformReleaser } = await requirePaymentsConfig();
  const client = await escrowClient(requireRecordedContractId(intent));

  await client.refund({ escrowId: intent.escrowId, caller: platformReleaser as unknown as EscrowSdkKeypair });

  return commitTransition(actor, intent, 'payment_intent.refunded', 'refunded', (tx) =>
    paymentsRepo.markStatus(tx, id, 'escrowed', 'refunded'),
  );
}

// --- Automatic settlement (Phase 5.5, issues #83 and #84) -----------------
//
// The durable task IS a transactional-outbox event: the fulfillment/expiry
// transition inserts `order.fulfilled` / `order.rejected` / `order.expired`
// in its own transaction, and `src/jobs/outbox-events.ts` claims it with
// `FOR UPDATE SKIP LOCKED`, retries with bounded exponential backoff, and
// resumes a crashed claim after its lease expires. No second queue table is
// invented for the same guarantee (see src/events/README.md).
//
// These functions are therefore called OUTSIDE a domain transaction, from the
// outbox handler, and are idempotent: a duplicate delivery sees a non-
// `escrowed` intent and does nothing, and the status write is one conditional
// UPDATE, so release and a timeout refund can never both commit locally.

export type AutomaticSettlementKind = 'release' | 'refund';
export type AutomaticSettlementOutcome =
  | 'no_intent'
  | 'not_escrowed'
  | 'settled'
  | 'raced'
  | 'not_funded_on_chain';

/**
 * Recognises the contract's NotFunded failure. The SDK is not typed to
 * expose an error class for this (0.2.0), so the check is deliberately
 * narrow on a stable code/name/message token rather than on any error text.
 * A different failure is rethrown and retried by the outbox.
 */
function isNotFundedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const errorCode = (error as { code?: unknown }).code;
  const errorName = (error as { name?: unknown }).name;
  const message = (error as { message?: unknown }).message;
  const identitySaysNotFunded = [errorCode, errorName].some(
    (value) => typeof value === 'string' && /not[_-]?funded/i.test(value),
  );
  const messageSaysNotFunded =
    typeof message === 'string' && /(escrow|contract).{0,40}not[ _-]?funded|not[ _-]?funded/i.test(message);
  return identitySaysNotFunded || messageSaysNotFunded;
}

/** One audit record + conditional status write in the same transaction. A
 * lost race (another settlement already moved the row) returns null and is
 * a normal no-op, never an error — the outbox must not retry it. */
async function commitAutomaticSettlement(
  intent: PaymentIntent,
  kind: AutomaticSettlementKind,
): Promise<PaymentIntent | null> {
  const to: PaymentIntentStatus = kind === 'release' ? 'released' : 'refunded';
  return prisma.$transaction(async (tx) => {
    const updated = await paymentsRepo.markStatus(tx, intent.id, 'escrowed', to);
    if (!updated) return null;
    await auditService.record(tx, auditService.SYSTEM_ACTOR, {
      entityType: 'PaymentIntent',
      entityId: intent.id,
      action: kind === 'release' ? 'payment_intent.released' : 'payment_intent.refunded',
      fromState: 'escrowed',
      toState: to,
      metadata: {
        ...intentAuditMetadata(updated),
        settlementSource: 'automatic',
        settlementKind: kind,
      },
    });
    return updated;
  });
}

/** Terminal reconcile for NotFunded: the chain says there is nothing to
 * release/refund, so retrying cannot help. Move the intent to `failed` with
 * an audit record and stop — never crash the worker. */
async function reconcileNotFunded(
  intent: PaymentIntent,
  kind: AutomaticSettlementKind,
): Promise<PaymentIntent | null> {
  return prisma.$transaction(async (tx) => {
    const updated = await paymentsRepo.markStatus(tx, intent.id, 'escrowed', 'failed');
    if (!updated) return null;
    await auditService.record(tx, auditService.SYSTEM_ACTOR, {
      entityType: 'PaymentIntent',
      entityId: intent.id,
      action: 'payment_intent.settlement_not_funded',
      fromState: 'escrowed',
      toState: 'failed',
      metadata: { ...intentAuditMetadata(updated), settlementKind: kind },
    });
    return updated;
  });
}

/** Best-effort: a missing notification must never fail a completed refund.
 * The intent's own status/audit record is the durable evidence; the in-app
 * message is a courtesy to the patient. */
async function notifyRefundCompleted(intent: PaymentIntent): Promise<void> {
  try {
    const userId = await getPatientUserIdByProfileId(intent.patientProfileId);
    if (!userId) return;
    await notificationsService.notify(userId, 'payment_refunded', { paymentIntentId: intent.id });
  } catch {
    logger.error('[payments] refund-completed notification failed');
  }
}

async function settleEscrowForOrder(
  orderType: 'prescription' | 'lab_order',
  orderId: string,
  kind: AutomaticSettlementKind,
): Promise<AutomaticSettlementOutcome> {
  const intent = await paymentsRepo.findPaymentIntentByOrder(orderType, orderId);
  if (!intent) return 'no_intent';
  // Already terminal or never funded: nothing to do. This is also the
  // duplicate-delivery guard, and the reason a release and a refund racing
  // each other cannot both commit locally.
  if (intent.status !== 'escrowed' || intent.escrowId === null) return 'not_escrowed';

  // Issue #328: a release is held rather than sent to a payee that is only a
  // not-yet-effective link: the throw makes the outbox retry with backoff
  // and, after MAX_ATTEMPTS, dead-letter it for an operator (funds stay in
  // escrow). Refunds go back to the payer, so they are not held.
  if (kind === 'release') await assertEscrowPayeeEffective(intent);

  const { platformReleaser } = await requirePaymentsConfig();
  const client = await escrowClient(requireRecordedContractId(intent));
  const caller = platformReleaser as unknown as EscrowSdkKeypair;

  try {
    if (kind === 'release') {
      await client.release({ escrowId: intent.escrowId, caller });
    } else {
      await client.refund({ escrowId: intent.escrowId, caller });
    }
  } catch (error) {
    if (!isNotFundedError(error)) throw error;
    const reconciled = await reconcileNotFunded(intent, kind);
    return reconciled ? 'not_funded_on_chain' : 'raced';
  }

  const settled = await commitAutomaticSettlement(intent, kind);
  if (!settled) return 'raced';
  if (kind === 'refund') await notifyRefundCompleted(settled);
  return 'settled';
}

/** Outbox handler: the whole order derives `fulfilled`. Release its escrow. */
export function releaseEscrowForFulfilledOrder(input: {
  orderType: 'prescription' | 'lab_order';
  orderId: string;
}): Promise<AutomaticSettlementOutcome> {
  return settleEscrowForOrder(input.orderType, input.orderId, 'release');
}

/** Outbox handler: the order was rejected with nothing dispensed, or a lab
 * order expired unfulfilled. Refund its escrow. */
export function refundEscrowForUnfulfilledOrder(input: {
  orderType: 'prescription' | 'lab_order';
  orderId: string;
}): Promise<AutomaticSettlementOutcome> {
  return settleEscrowForOrder(input.orderType, input.orderId, 'refund');
}

/**
 * This module's contribution to the patient data export (issue #40). An
 * explicit field allowlist: on-chain references (tx hash, escrow id,
 * contract id) are the patient's payment record and are included; the
 * platform's signing secrets never touch a PaymentIntent row and can't
 * appear here. BigInts are strings, matching the HTTP API. Version 2
 * (issue #79) renames `amountStroops` to `amount` and adds `assetCode`.
 */
export const paymentsExportSection: PatientExportSection = {
  name: 'payments',
  version: 2,
  pages(subject, pageSize) {
    return paginate(
      pageSize,
      (cursor, take) => paymentsRepo.findPaymentIntentsPageForPatient(subject.patientProfileId, cursor, take),
      async (rows) => {
        const facilities = await getFacilityNamesByIds([...new Set(rows.map((row) => row.facilityId))]);
        const facilityNames = new Map(facilities.map((facility) => [facility.id, facility.name]));
        return rows.map((row) => ({
          id: row.id,
          prescriptionId: row.prescriptionId,
          labOrderId: row.labOrderId,
          status: row.status,
          amount: row.amount.toString(),
          assetCode: row.assetCode,
          facility: { id: row.facilityId, name: facilityNames.get(row.facilityId) ?? null },
          escrowId: row.escrowId?.toString() ?? null,
          stellarTxHash: row.stellarTxHash,
          sorobanContractId: row.sorobanContractId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }));
      },
    );
  },
};
/** Retention hold (issue #41, docs/adr/0010): payment records are kept, so
 * a patient who has any is never purged after deletion. */
export function hasPaymentIntentsForPatient(patientProfileId: string): Promise<boolean> {
  return paymentsRepo.patientHasPaymentIntents(patientProfileId);
}

// --- Escrow funding reconciliation (issue #24) ----------------------------
//
// A fund request claims `created -> funding` before the chain call and writes
// `escrowed` after it. A crash in between leaves a row in `funding` and an
// escrow the database has never seen. Retrying the chain call would create a
// SECOND escrow, so recovery is explicit:
//   - `reportStuckFundingClaims` lists claims older than the stale window
//     plus every escrow creation the event poller observed with no
//     PaymentIntent pointing at it.
//   - `adoptObservedEscrow` attaches an observed escrow id to a stuck claim
//     (the operator has confirmed it is that intent's escrow).
//   - `abandonStuckFundingClaim` returns a claim to `created` (the operator
//     has confirmed no escrow was ever created for it).
// `scripts/reconcile-escrows.ts` is the operator entry point for all three.

export interface StuckFundingReport {
  staleAfterSeconds: number;
  /** Intents claimed for funding but never resolved, oldest first. */
  stuckClaims: Array<{
    id: string;
    facilityId: string;
    amount: string;
    assetCode: string;
    fundingStartedAt: Date | null;
    sorobanContractId: string | null;
  }>;
  /** Observed on-chain escrows with no PaymentIntent referencing them. */
  untrackedEscrows: Array<{
    escrowId: string;
    contractId: string;
    eventType: string;
    txHash: string | null;
    ledger: number;
    detectedAt: Date;
  }>;
}

/** How long a `funding` claim may stay unresolved before it is reported.
 * Deliberately generous: a busy testnet RPC can take tens of seconds. */
function staleFundingCutoff(now: Date): Date {
  return new Date(now.getTime() - config.payments.escrowFundingStaleAfterSeconds * 1000);
}

/** Escrow event types that mean "an escrow now exists" — the contract emits
 * these from `create_escrow`. Matched case-insensitively because the decoder
 * copies the raw topic symbol. */
const ESCROW_CREATION_EVENT_TYPES = new Set(['created', 'create_escrow', 'funded', 'deposit']);

/** Read-only: no status is changed here. An operator resolves each entry
 * explicitly, because guessing would either double-fund or strand an escrow. */
export async function reportStuckFundingClaims(now = new Date()): Promise<StuckFundingReport> {
  const staleAfter = staleFundingCutoff(now);
  const stuck = await paymentsRepo.findStaleFundingClaims(staleAfter, 200);
  // Observed creations read directly from the ingestion table the event
  // poller already owns — the SDK (0.2.0) exposes no "list escrows" call, so
  // this is the only on-chain view this repo has.
  const observed = await prisma.escrowChainEvent.findMany({
    where: { paymentIntentId: null, state: { not: 'matched' } },
    orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
    take: 500,
  });
  const untrackedEscrows = observed
    .filter((event) => event.escrowId !== null && ESCROW_CREATION_EVENT_TYPES.has(event.eventType.toLowerCase()))
    .map((event) => ({
      escrowId: (event.escrowId as bigint).toString(),
      contractId: event.contractId,
      eventType: event.eventType,
      txHash: event.txHash,
      ledger: event.ledger,
      detectedAt: event.detectedAt,
    }));

  return {
    staleAfterSeconds: config.payments.escrowFundingStaleAfterSeconds,
    stuckClaims: stuck.map((intent) => ({
      id: intent.id,
      facilityId: intent.facilityId,
      amount: intent.amount.toString(),
      assetCode: intent.assetCode,
      fundingStartedAt: intent.fundingStartedAt,
      sorobanContractId: intent.sorobanContractId,
    })),
    untrackedEscrows,
  };
}

/** Resolves a stuck claim against an escrow the chain actually has. The
 * escrow id is operator-supplied: the SDK cannot search by condition_ref and
 * a wrong id must never be adopted automatically. It is only accepted when
 * the event poller has already observed that escrow on a registered contract,
 * so a typo fails closed instead of writing a bogus escrow id. Conditional on
 * `funding`, so a request that resolved concurrently wins and this returns
 * null. */
export async function adoptObservedEscrow(input: {
  paymentIntentId: string;
  escrowId: string;
  contractId: string;
}): Promise<PaymentIntent | null> {
  const intent = await getPaymentIntent(input.paymentIntentId);
  if (intent.status !== 'funding') {
    throw new HttpError(409, `PaymentIntent is '${intent.status}', not 'funding' — nothing to reconcile.`);
  }
  if (!config.payments.contractIds.includes(input.contractId)) {
    throw new HttpError(400, 'contractId is not a registered escrow contract.');
  }
  let escrowId: bigint;
  try {
    escrowId = BigInt(input.escrowId);
  } catch {
    throw new HttpError(400, 'escrowId must be a numeric escrow id.');
  }
  const observed = await prisma.escrowChainEvent.findFirst({
    where: { contractId: input.contractId, escrowId },
    orderBy: { detectedAt: 'desc' },
  });
  if (!observed) {
    throw new HttpError(404, 'That escrow has not been observed on-chain for this contract — refusing to adopt it.');
  }
  return commitTransition(auditService.SYSTEM_ACTOR, intent, 'payment_intent.reconciled', 'escrowed', (tx) =>
    paymentsRepo.markEscrowed(tx, intent.id, {
      escrowId,
      stellarTxHash: observed.txHash ?? `reconciled-${escrowId.toString()}`,
      sorobanContractId: input.contractId,
    }),
  );
}

/** Resolves a stuck claim the operator has confirmed never reached the chain
 * (no escrow exists) — the intent becomes fundable again. */
export async function abandonStuckFundingClaim(paymentIntentId: string): Promise<PaymentIntent | null> {
  const intent = await getPaymentIntent(paymentIntentId);
  if (intent.status !== 'funding') {
    throw new HttpError(409, `PaymentIntent is '${intent.status}', not 'funding' — nothing to release.`);
  }
  return commitTransition(auditService.SYSTEM_ACTOR, intent, 'payment_intent.funding_abandoned', 'created', (tx) =>
    paymentsRepo.releaseFundingClaim(tx, paymentIntentId),
  );
}

export interface SubmitPaymentIntentResult {
  intent: PaymentIntent;
  escrowId: bigint | null;
  stellarTxHash: string | null;
}

export async function submitPaymentIntent(
  actor: auditService.AuditActor,
  id: string,
  signedXdr: string,
  now = new Date(),
): Promise<SubmitPaymentIntentResult> {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const patientProfileId = await getOwnPatientProfileId(actor.userId);

  const intent = await getPaymentIntent(id);
  if (intent.patientProfileId !== patientProfileId) throw new HttpError(404, 'PaymentIntent not found.');

  // Idempotent: a retried submit of an already-escrowed intent never
  // double-submits.
  if (intent.status === 'escrowed') {
    return { intent, escrowId: intent.escrowId, stellarTxHash: intent.stellarTxHash };
  }
  if (intent.status !== 'awaiting_signature') {
    throw new HttpError(409, `PaymentIntent is '${intent.status}', not 'awaiting_signature' — cannot submit.`);
  }
  if (!intent.preparedTxHash || !intent.preparedExpiresAt) {
    throw new HttpError(409, 'This payment has no prepared transaction.', 'PREPARE_REQUIRED');
  }
  if (intent.preparedExpiresAt.getTime() <= now.getTime()) {
    await expirePreparedIntent(intent.id, now);
    throw new HttpError(409, 'The prepared transaction has expired — prepare again.', 'PREPARED_EXPIRED');
  }

  // Verify the submitted XDR is exactly the prepared transaction.
  const stellar = await import('@stellar/stellar-sdk');
  let tx: any;
  try {
    tx = (stellar as any).TransactionBuilder.fromXDR(signedXdr, config.payments.networkPassphrase);
  } catch {
    throw new HttpError(400, 'signedXdr is not a valid transaction.', 'INVALID_XDR');
  }
  const hash = tx.hash().toString('hex');
  if (hash !== intent.preparedTxHash) {
    throw new HttpError(400, 'The submitted transaction does not match the prepared one.', 'TX_HASH_MISMATCH');
  }

  const patientWallet = await getPatientWalletLink(patientProfileId);
  if (!patientWallet) {
    throw new HttpError(409, 'No verified Stellar wallet is linked to this patient.', 'WALLET_NOT_LINKED');
  }
  let verified = false;
  try {
    verified = typeof tx.verifySignatures === 'function'
      ? tx.verifySignatures([patientWallet.stellarPublicKey])
      : true;
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new HttpError(400, 'The transaction is not signed by the linked patient account.', 'INVALID_SIGNATURE');
  }

  // Fee-sponsor budget check (issue #82): per-patient and global limits
  // enforced before any fee-bump/submit.
  const bucket = feeSponsorshipBuckets.get(patientProfileId) ?? { count: 0, lastReset: Date.now() };
  if (Date.now() - bucket.lastReset > FEE_SPONSOR_WINDOW_MS) bucket.count = 0;
  if (bucket.count >= FEE_SPONSOR_PER_PATIENT_LIMIT) {
    throw new HttpError(429, 'Per-patient fee-sponsorship budget exceeded.', 'FEE_SPONSOR_PATIENT_LIMIT');
  }
  let globalTotal = 0;
  for (const b of feeSponsorshipBuckets.values()) globalTotal += b.count;
  if (globalTotal >= FEE_SPONSOR_GLOBAL_LIMIT) {
    throw new HttpError(429, 'Global fee-sponsorship budget exceeded.', 'FEE_SPONSOR_GLOBAL_LIMIT');
  }

  // Claim the submit (awaiting_signature -> submitting) before any chain call.
  const claimed = await prisma.$transaction(async (txc) => {
    const row = await paymentsRepo.markSubmitting(txc, id);
    if (!row) return null;
    await auditService.record(txc, actor, {
      entityType: 'PaymentIntent',
      entityId: id,
      action: 'payment_intent.submitting',
      fromState: 'awaiting_signature',
      toState: 'submitting',
      metadata: intentAuditMetadata(row),
    });
    return row;
  });
  if (!claimed) {
    throw new HttpError(409, 'PaymentIntent changed concurrently — it is no longer awaiting signature.');
  }

  const contractId = requireRecordedContractId(intent);
  const client = (await escrowClient(contractId)) as any;
  const submitFn =
    client?.submitCreateEscrow ??
    client?.submitSignedXdr ??
    client?.submit ??
    client?.submitTransaction;

  if (typeof submitFn !== 'function') {
    await prisma.$transaction(async (txc) => {
      const row = await paymentsRepo.releaseSubmittingClaim(txc, id);
      if (row) {
        await auditService.record(txc, actor, {
          entityType: 'PaymentIntent',
          entityId: id,
          action: 'payment_intent.submit_unsupported',
          fromState: 'submitting',
          toState: 'awaiting_signature',
          metadata: intentAuditMetadata(row),
        });
      }
    }).catch(() => undefined);
    throw new HttpError(
      503,
      'The installed escrow SDK cannot submit signed transactions yet (requires docforum-escrow SDK 0.3.0).',
      'ESCROW_SDK_SUBMIT_UNSUPPORTED',
    );
  }

  let escrowId: bigint;
  let stellarTxHash: string;
  try {
    const result = await submitFn.call(client, { signedXdr, txHash: intent.preparedTxHash });
    escrowId = result?.escrowId ?? result?.escrow_id;
    stellarTxHash = result?.stellarTxHash ?? result?.stellar_tx_hash ?? result?.txHash ?? result?.tx_hash;
    if (typeof escrowId === 'string') escrowId = BigInt(escrowId);
  } catch (error) {
    await prisma.$transaction(async (txc) => {
      const row = await paymentsRepo.releaseSubmittingClaim(txc, id);
      if (row) {
        await auditService.record(txc, actor, {
          entityType: 'PaymentIntent',
          entityId: id,
          action: 'payment_intent.submit_failed',
          fromState: 'submitting',
          toState: 'awaiting_signature',
          metadata: intentAuditMetadata(row),
        });
      }
    }).catch(() => undefined);
    throw error;
  }

  const updated = await prisma.$transaction(async (txc) => {
    const row = await paymentsRepo.markSubmitted(txc, id, {
      escrowId,
      stellarTxHash,
      sorobanContractId: contractId,
    });
    if (!row) throw new HttpError(409, 'PaymentIntent changed concurrently during submit.');
    await auditService.record(txc, actor, {
      entityType: 'PaymentIntent',
      entityId: id,
      action: 'payment_intent.submitted',
      fromState: 'submitting',
      toState: 'escrowed',
      metadata: intentAuditMetadata(row),
    });
    return row;
  });

  // Fee-sponsor budget accounting (issue #82): a submission that lands
  // consumes one unit of the per-patient and global sponsorship budget.
  // Recorded after success so a failed submit does not charge the sponsor.
  recordFeeSponsorship(patientProfileId, 1);

  return { intent: updated, escrowId, stellarTxHash };
}

// --- Fee sponsorship (issue #82) ---------------------------------------
// In-memory per-patient/global budget accounting. A production deployment
// should persist this; the DB-level atomicity here is enforced by the
// caller's transactional claim above. Exposed for the admin endpoint.
const feeSponsorshipBuckets = new Map<string, { count: number; lastReset: number }>();
const FEE_SPONSOR_WINDOW_MS = 60 * 60 * 1000;
const FEE_SPONSOR_PER_PATIENT_LIMIT = Number(process.env.FEE_SPONSOR_PER_PATIENT_LIMIT ?? 10);
const FEE_SPONSOR_GLOBAL_LIMIT = Number(process.env.FEE_SPONSOR_GLOBAL_LIMIT ?? 1000);

export function recordFeeSponsorship(patientProfileId: string, units = 1): void {
  const now = Date.now();
  const bucket = feeSponsorshipBuckets.get(patientProfileId) ?? { count: 0, lastReset: now };
  if (now - bucket.lastReset > FEE_SPONSOR_WINDOW_MS) {
    bucket.count = 0;
    bucket.lastReset = now;
  }
  bucket.count += units;
  feeSponsorshipBuckets.set(patientProfileId, bucket);
}

export function feeSponsorshipSnapshot() {
  let total = 0;
  for (const b of feeSponsorshipBuckets.values()) total += b.count;
  return {
    windowMs: FEE_SPONSOR_WINDOW_MS,
    perPatientLimit: FEE_SPONSOR_PER_PATIENT_LIMIT,
    globalLimit: FEE_SPONSOR_GLOBAL_LIMIT,
    totalUnits: total,
    topConsumers: [...feeSponsorshipBuckets.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([patientProfileId, b]) => ({ patientProfileId, count: b.count })),
  };
}
