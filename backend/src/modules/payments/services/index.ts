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
// Test seam for the escrow SDK (offline funding tests, issue #78).
export { resetEscrowSdkOverride, setEscrowSdkOverride } from './escrow-sdk-loader';
export type { EscrowSdkForTests } from './escrow-sdk-loader';

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

  // The facility's ACTIVE link (issue #78: one per owner; replaced rows
  // are history and must never be picked up here).
  const walletLink = await paymentsRepo.findActiveWalletLink('facility', intent.facilityId);
  if (!walletLink) throw new HttpError(409, 'The facility for this payment has no linked wallet.');

  // Funding guard (issue #78 requirement 4) — in the SERVICE, so scripts,
  // future controllers or internal callers all hit it. Unverified legacy
  // links fund only before WALLET_LINK_UNVERIFIED_FUNDING_CUTOFF.
  assertWalletLinkFundingAllowed(walletLink);

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

  return paymentsRepo.markEscrowed(id, {
    escrowId,
    stellarTxHash: txHash,
    sorobanContractId: escrowContractId,
    // Snapshot the payee this escrow was actually funded to (issue #78
    // requirement 5): a later re-link of the facility's wallet must not
    // rewrite which address this intent references.
    fundedWalletAddress: walletLink.stellarPublicKey,
  });
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
