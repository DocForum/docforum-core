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
import { config, type PaymentAsset } from '../../../config';
import type { PaymentIntent, PaymentIntentStatus } from '@prisma/client';
import * as paymentsRepo from '../repositories';
import { loadEscrowSdk, type EscrowSdkKeypair } from './escrow-sdk-loader';
import { hasTrustline } from './trustline';
import { getPlatformSigners } from './platform-signers';
import { resolveEscrowPayee } from './payout-privacy';
import { getMyPatientProfile, paginate, type PatientExportSection } from '../../patients/services';
import { prisma } from '../../../db/prisma-client';
import { parseStroopsAmount } from '../../../utils/stroops';
import * as auditService from '../../audit/services';
import type { Prisma } from '@prisma/client';
import { transitionPaymentIntentStatus } from './state-machine';
// Types are inferred from the prisma instance; use 'as' assertions where needed

import { assertWalletLinkFundingAllowed } from './wallet-link';

// SEP-10 Stellar Web Authentication (issue #77). Re-exported through
// this module's service surface (not imported file-by-file from outside)
// per the AGENTS.md module-boundary rule — same pattern as the auth
// module's token/throttle re-exports.
export {
  createSep10Challenge,
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
} from './wallet-link';
export type { WalletLinkOwner } from './wallet-link';

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
  const profile = await paymentsRepo.findFacilityProfileByUserId(userId);
  if (!profile) throw new HttpError(403, 'No facility profile is associated with this account.');
  return profile.id;
}

/** The caller's patient profile id — every patient-scoped payment read is
 * owned through this, never through a client-supplied profile id. */
export async function getOwnPatientProfileId(userId: string): Promise<string> {
  const profile = await paymentsRepo.findPatientProfileByUserId(userId);
  if (!profile) throw new HttpError(403, 'No patient profile is associated with this account.');
  return profile.id;
}

export async function linkWallet(facilityId: string, stellarPublicKey: string) {
  const now = new Date();
  await paymentsRepo.deactivateActiveWalletLink('facility', facilityId, now);
  return paymentsRepo.createWalletLink({
    ownerType: 'facility',
    ownerId: facilityId,
    stellarPublicKey,
    verificationMethod: 'sep10',
    verifiedAt: now,
    activeOwnerKey: `facility:${facilityId}`,
  });
}

export function getWalletLink(facilityId: string) {
  return paymentsRepo.findActiveWalletLink('facility', facilityId);
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
  const facility = await tx.facilityProfile.findUnique({ where: { id: input.facilityProfileId }, select: { type: true } });
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

/** Funds the escrow from the platform's own payer identity. The intent must be `created` and its facility must have a linked wallet (the on-chain payee). */
export async function fundPaymentIntent(actor: auditService.AuditActor, id: string) {
  const intent = await getPaymentIntent(id);
  if (transitionPaymentIntentStatus(intent.status, 'escrowed') !== 'escrowed') {
    throw new HttpError(409, `PaymentIntent is '${intent.status}', not 'created' — cannot fund.`);
  }

  // The facility's ACTIVE link (issue #78: one per owner; replaced rows
  // are history and must never be picked up here).
  const walletLink = await paymentsRepo.findActiveWalletLink('facility', intent.facilityId);
  if (!walletLink) throw new HttpError(409, 'The facility for this payment has no linked wallet.');
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

  const { escrowId, txHash } = await client.createEscrow({
    payer: platformPayer as unknown as EscrowSdkKeypair,
    payee,
    token: asset.tokenContractId,
    amount: intent.amount,
    // The PaymentIntent's own id is the opaque condition_ref — the
    // contract never interprets it (docforum-escrow ADR 0001); it's
    // just how we can trace an on-chain escrow back to this record.
    conditionRef: intent.id,
    releaser: platformReleaser.publicKey(),
  });

  return commitTransition(actor, intent, 'payment_intent.funded', 'escrowed', (tx) =>
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

  const payeeWallet = await getWalletLink(intent.facilityId);
  if (!payeeWallet) {
    throw new HttpError(
      409,
      'The facility for this payment has no linked wallet.',
      'FACILITY_WALLET_NOT_LINKED',
    );
  }

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

/** Releases the escrow to the facility's linked wallet. v1: admin-triggered (see ADR 0004 "Consequences") — no automatic FulfillmentRecord trigger yet, since that model doesn't exist. */
export async function releasePaymentIntent(actor: auditService.AuditActor, id: string) {
  const intent = await getPaymentIntent(id);
  if (transitionPaymentIntentStatus(intent.status, 'released') !== 'released' || intent.escrowId === null) {
    throw new HttpError(409, `PaymentIntent is '${intent.status}', not 'escrowed' — cannot release.`);
  }

  const { platformReleaser } = await requirePaymentsConfig();
  const client = await escrowClient(requireRecordedContractId(intent));

  await client.release({ escrowId: intent.escrowId, caller: platformReleaser as unknown as EscrowSdkKeypair });

  return commitTransition(actor, intent, 'payment_intent.released', 'released', (tx) =>
    paymentsRepo.markStatus(tx, id, 'escrowed', 'released'),
  );
}

/** Refunds the escrow back toward the platform payer. v1: admin-triggered, same reasoning as release. */
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
        const facilities = await paymentsRepo.findFacilityNamesByIds([...new Set(rows.map((row) => row.facilityId))]);
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
