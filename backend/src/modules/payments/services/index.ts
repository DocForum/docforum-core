// payments services — this module owns PaymentIntent/WalletLink
// (relational metadata only — no PHI ever passes through here) and
// delegates actual escrow contract calls to @docforum/escrow-sdk. This
// module does NOT reimplement contract logic — it calls the SDK,
// persists the resulting tx hash/status, and exposes that status to
// other core modules through this services/ interface, per AGENTS.md
// module-boundary rule.
//
// Custodial v1 (see docs/adr/0004-custodial-payments-v1.md):
// docforum-core holds its own Stellar payer + releaser identities.
// Patients never hold or sign with a wallet in this design.
import { HttpError } from '../../../http-error';
import { config } from '../../../config';
import * as paymentsRepo from '../repositories';
import { loadEscrowSdk, type EscrowSdkKeypair } from './escrow-sdk-loader';
import { getPlatformSigners } from './platform-signers';
import { paginate, type PatientExportSection } from '../../patients/services';
import { prisma } from '../../../db/prisma-client';
import * as auditService from '../../audit/services';
import type { Prisma } from '@prisma/client';
// Types are inferred from the prisma instance; use 'as' assertions where needed

// Test seam re-exported through the service surface (same convention as the
// auth module's setEmailSender) — see escrow-sdk-loader.ts.
export { setEscrowSdkForTests } from './escrow-sdk-loader';
export { listEscrowEvents } from './escrow-events';
export type { EscrowSdkModule } from './escrow-sdk-loader';

async function requirePaymentsConfig() {
  const { activeContractId, escrowTokenId } = config.payments;
  const missing = Object.entries({ activeContractId, escrowTokenId })
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new HttpError(500, `Payments is not configured — missing env var(s): ${missing.join(', ')}.`);
  }
  const { payer, releaser } = await getPlatformSigners();
  return {
    platformPayer: payer,
    platformReleaser: releaser,
    escrowContractId: activeContractId!,
    escrowTokenId: escrowTokenId!,
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

export function linkWallet(facilityId: string, stellarPublicKey: string) {
  return paymentsRepo.upsertWalletLink(facilityId, stellarPublicKey);
}

export function getWalletLink(facilityId: string) {
  return paymentsRepo.findWalletLinkByFacilityId(facilityId);
}

/** Called by the orders module inside the order-issuance transaction. A
 * created intent moves to a corrected order; any funded/terminal intent
 * stays attached to the immutable original order. */
export async function createIntentForIssuedOrder(tx: Prisma.TransactionClient, input: {
  kind: 'prescription' | 'lab_order'; orderId: string; patientProfileId: string; doctorProfileId: string;
  facilityProfileId: string; amountStroops: bigint; supersedesId: string | null;
}) {
  if (input.amountStroops <= 0n) throw new HttpError(400, 'amountStroops must be positive.');
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
        data: { ...orderPointer, patientProfileId: input.patientProfileId, facilityId: input.facilityProfileId, amountStroops: input.amountStroops },
      });
      if (moved.count === 1) return tx.paymentIntent.findUniqueOrThrow({ where: { id: previous.id } });
    }
  }
  return tx.paymentIntent.create({
    data: { ...orderPointer, patientProfileId: input.patientProfileId, facilityId: input.facilityProfileId, amountStroops: input.amountStroops },
  });
}

export async function getPaymentIntent(id: string) {
  const intent = await paymentsRepo.findPaymentIntentById(id);
  if (!intent) throw new HttpError(404, 'PaymentIntent not found.');
  return intent;
}

/** Commits a status change and its AuditEvent together (issue #43). If the
 * row moved on concurrently, nothing is written and the caller gets 409. */
async function commitTransition(
  actor: auditService.AuditActor,
  // PaymentIntent row shape from prisma operations; use 'as' since Prisma 7
  // client types may not match the expected exports.
  intent: any,
  action: string,
  to: any,
  write: (tx: any) => Promise<any>,
): Promise<any> {
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
      // Public, non-identifying references only: the escrow is on a public
      // ledger anyway. No patient data, no secrets.
      metadata: {
        orderType: updated.prescriptionId ? 'prescription' : 'lab_order',
        orderId: updated.prescriptionId ?? updated.labOrderId!,
        amountStroops: updated.amountStroops.toString(),
        escrowId: updated.escrowId?.toString() ?? null,
        stellarTxHash: updated.stellarTxHash,
        sorobanContractId: updated.sorobanContractId,
      },
    });
    return updated;
  });
}

/** Funds the escrow from the platform's own payer identity. The intent must be `created` and its facility must have a linked wallet (the on-chain payee). */
export async function fundPaymentIntent(actor: auditService.AuditActor, id: string) {
  const intent = await getPaymentIntent(id);
  if (intent.status !== 'created') {
    throw new HttpError(409, `PaymentIntent is '${intent.status}', not 'created' — cannot fund.`);
  }

  const walletLink = await paymentsRepo.findWalletLinkByFacilityId(intent.facilityId);
  if (!walletLink) throw new HttpError(409, 'The facility for this payment has no linked wallet.');

  const { platformPayer, platformReleaser, escrowContractId, escrowTokenId } = await requirePaymentsConfig();
  if (config.payments.assetAllowlist.length > 0 && !config.payments.assetAllowlist.includes(escrowTokenId)) {
    throw new HttpError(500, 'Configured escrow token is not in the payments asset allowlist.');
  }
  const client = await escrowClient(escrowContractId);

  const { escrowId, txHash } = await client.createEscrow({
    payer: platformPayer as unknown as EscrowSdkKeypair,
    payee: walletLink.stellarPublicKey,
    token: escrowTokenId,
    amount: intent.amountStroops,
    // The PaymentIntent's own id is the opaque condition_ref — the
    // contract never interprets it (docforum-escrow ADR 0001); it's
    // just how we can trace an on-chain escrow back to this record.
    conditionRef: intent.id,
    releaser: platformReleaser.publicKey(),
  });

  return commitTransition(actor, intent, 'payment_intent.funded', 'escrowed', (tx) =>
    paymentsRepo.markEscrowed(tx, id, { escrowId, stellarTxHash: txHash, sorobanContractId: escrowContractId }),
  );
}

/** Releases the escrow to the facility's linked wallet. v1: admin-triggered (see ADR 0004 "Consequences") — no automatic FulfillmentRecord trigger yet, since that model doesn't exist. */
export async function releasePaymentIntent(actor: auditService.AuditActor, id: string) {
  const intent = await getPaymentIntent(id);
  if (intent.status !== 'escrowed' || intent.escrowId === null) {
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
  if (intent.status !== 'escrowed' || intent.escrowId === null) {
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
 * appear here. BigInts are strings, matching the HTTP API.
 */
export const paymentsExportSection: PatientExportSection = {
  name: 'payments',
  version: 1,
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
          amountStroops: row.amountStroops.toString(),
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
