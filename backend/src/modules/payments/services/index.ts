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
import { loadEscrowSdk } from './escrow-sdk-loader';

async function requirePaymentsConfig() {
  const { platformPayerSecret, platformReleaserSecret, escrowContractId, escrowTokenId } = config.payments;
  const missing = Object.entries({ platformPayerSecret, platformReleaserSecret, escrowContractId, escrowTokenId })
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new HttpError(500, `Payments is not configured — missing env var(s): ${missing.join(', ')}.`);
  }
  const { Keypair } = await loadEscrowSdk();
  return {
    platformPayer: Keypair.fromSecret(platformPayerSecret!),
    platformReleaser: Keypair.fromSecret(platformReleaserSecret!),
    escrowContractId: escrowContractId!,
    escrowTokenId: escrowTokenId!,
  };
}

async function escrowClient(contractId: string) {
  const { EscrowClient } = await loadEscrowSdk();
  return new EscrowClient({ contractId });
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

export interface CreatePaymentIntentInput {
  orderType: 'prescription' | 'lab_order';
  orderId: string;
  patientProfileId: string;
  facilityId: string;
  amountStroops: bigint;
}

export function createPaymentIntent(input: CreatePaymentIntentInput) {
  if (input.amountStroops <= 0n) throw new HttpError(400, 'amountStroops must be positive.');
  return paymentsRepo.createPaymentIntent(input);
}

export async function getPaymentIntent(id: string) {
  const intent = await paymentsRepo.findPaymentIntentById(id);
  if (!intent) throw new HttpError(404, 'PaymentIntent not found.');
  return intent;
}

/** Funds the escrow from the platform's own payer identity. The intent must be `created` and its facility must have a linked wallet (the on-chain payee). */
export async function fundPaymentIntent(id: string) {
  const intent = await getPaymentIntent(id);
  if (intent.status !== 'created') {
    throw new HttpError(409, `PaymentIntent is '${intent.status}', not 'created' — cannot fund.`);
  }

  const walletLink = await paymentsRepo.findWalletLinkByFacilityId(intent.facilityId);
  if (!walletLink) throw new HttpError(409, 'The facility for this payment has no linked wallet.');

  const { platformPayer, platformReleaser, escrowContractId, escrowTokenId } = await requirePaymentsConfig();
  const client = await escrowClient(escrowContractId);

  const { escrowId, txHash } = await client.createEscrow({
    payer: platformPayer,
    payee: walletLink.stellarPublicKey,
    token: escrowTokenId,
    amount: intent.amountStroops,
    // The PaymentIntent's own id is the opaque condition_ref — the
    // contract never interprets it (docforum-escrow ADR 0001); it's
    // just how we can trace an on-chain escrow back to this record.
    conditionRef: intent.id,
    releaser: platformReleaser.publicKey(),
  });

  return paymentsRepo.markEscrowed(id, { escrowId, stellarTxHash: txHash, sorobanContractId: escrowContractId });
}

/** Releases the escrow to the facility's linked wallet. v1: admin-triggered (see ADR 0004 "Consequences") — no automatic FulfillmentRecord trigger yet, since that model doesn't exist. */
export async function releasePaymentIntent(id: string) {
  const intent = await getPaymentIntent(id);
  if (intent.status !== 'escrowed' || intent.escrowId === null) {
    throw new HttpError(409, `PaymentIntent is '${intent.status}', not 'escrowed' — cannot release.`);
  }

  const { platformReleaser, escrowContractId } = await requirePaymentsConfig();
  const client = await escrowClient(intent.sorobanContractId ?? escrowContractId);

  await client.release({ escrowId: intent.escrowId, caller: platformReleaser });

  return paymentsRepo.markStatus(id, 'released');
}

/** Refunds the escrow back toward the platform payer. v1: admin-triggered, same reasoning as release. */
export async function refundPaymentIntent(id: string) {
  const intent = await getPaymentIntent(id);
  if (intent.status !== 'escrowed' || intent.escrowId === null) {
    throw new HttpError(409, `PaymentIntent is '${intent.status}', not 'escrowed' — cannot refund.`);
  }

  const { platformReleaser, escrowContractId } = await requirePaymentsConfig();
  const client = await escrowClient(intent.sorobanContractId ?? escrowContractId);

  await client.refund({ escrowId: intent.escrowId, caller: platformReleaser });

  return paymentsRepo.markStatus(id, 'refunded');
}
