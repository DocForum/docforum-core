// Verified wallet links (issue #78, ADR 0005). Replaces the old
// facility-only, typed-in `POST /payments/wallet-link` body: an address
// is NEVER read from the request. The only way to create a link is to
// submit a signed SEP-10 challenge, and the address is derived from the
// account that challenge was issued for and successfully verified
// against (`verifySep10Challenge` from issue #77).
//
// Invariant (reviewer check): `createWalletLink` (the only WalletLink
// insert in the repositories) is called from exactly one place — the
// transaction below, after `verifySep10Challenge` has resolved without
// throwing. There is no seed, no admin route, no script and no legacy
// write path; `unverified_legacy` rows only ever come from the
// add_verified_wallet_links migration backfill.
import { HttpError } from '../../../http-error';
import { config } from '../../../config';
import * as paymentsRepo from '../repositories';
import { verifySep10Challenge } from './sep10';
import type { Role, WalletLink, WalletLinkVerificationMethod } from '@prisma/client';

/**
 * ADR 0005, "Consequences → Privacy risk" — reproduced VERBATIM (every
 * word and punctuation mark identical; only the ADR's line wrapping is
 * collapsed to single spaces so the string is usable in a JSON body).
 * tests/unit/wallet-link.test.ts asserts this constant still appears
 * verbatim in docs/adr/0005-non-custodial-patient-payments.md, so this
 * can never drift into a paraphrase silently.
 *
 * It rides on EVERY patient wallet-link response so a client cannot
 * render the link success without somewhere carrying this text — the ADR
 * says "The wallet-linking screen must say this plainly."
 */
export const PATIENT_WALLET_LINK_PRIVACY_NOTICE =
  '**Privacy risk: health information can leak on-chain.** A payment from a patient\'s wallet to a facility\'s wallet is public forever. If the patient\'s address is ever linked to their identity, the facility it paid (for example a specialised clinic) can reveal health information. `condition_ref` stays an opaque id (escrow threat model T9), but that doesn\'t hide who paid whom. The wallet-linking screen must say this plainly.';

export interface WalletLinkOwner {
  ownerType: 'patient' | 'facility';
  ownerId: string;
}

/** Resolves the owner record the caller is allowed to link FOR. Exactly
 * one owner per caller: a user's role determines which profile exists
 * (both profile tables are 1:1 with User), so linking for an owner you
 * don't control is a 403 before any verification work happens.
 *
 * Multi-user facility authorisation (several staff linking for one
 * facility) is NOT modeled — FacilityProfile is 1:1 with User today —
 * and is listed as an open design decision in the PR. */
async function resolveCallerOwner(userId: string, role: Role): Promise<WalletLinkOwner> {
  if (role === 'patient') {
    const profile = await paymentsRepo.findPatientProfileByUserId(userId);
    if (!profile) throw new HttpError(403, 'No patient profile is associated with this account.');
    return { ownerType: 'patient', ownerId: profile.id };
  }
  if (role === 'facility') {
    const profile = await paymentsRepo.findFacilityProfileByUserId(userId);
    if (!profile) throw new HttpError(403, 'No facility profile is associated with this account.');
    return { ownerType: 'facility', ownerId: profile.id };
  }
  throw new HttpError(403, 'Only patient and facility accounts can link a wallet.');
}

/**
 * POST /payments/wallet-link — verifies the signed SEP-10 challenge AND
 * creates (or replaces) the caller's link in ONE transaction, together
 * with consuming the challenge nonce:
 *
 *  - verification fails → the whole transaction rolls back: no link is
 *    created and the nonce is NOT burned (the user can retry);
 *  - the link write fails (e.g. a concurrent request won the
 *    one-active-link race) → the nonce consumption rolls back too, so a
 *    lost race costs nothing but a fresh challenge;
 *  - success → nonce consumed and exactly one active link, atomically.
 *
 * The returned `stellarPublicKey` is always the challenge's verified
 * account — no code path here consults a client-supplied address.
 */
export async function linkWalletViaSep10(
  userId: string,
  role: Role,
  signedChallengeTx: string,
): Promise<WalletLink> {
  const owner = await resolveCallerOwner(userId, role);
  const now = new Date();

  try {
    return await paymentsRepo.inTransaction(async (tx) => {
      // Full SEP-10 server verification, ledger binding (this user) and
      // atomic nonce consumption — inside this transaction.
      const { account } = await verifySep10Challenge(userId, signedChallengeTx, tx);

      // Re-link deactivates rather than mutates/deletes: the previous
      // row keeps its address and history, and the active sentinel key
      // frees up for the new row (unique index keeps this race-safe).
      await paymentsRepo.deactivateActiveWalletLink(owner.ownerType, owner.ownerId, now, tx);

      return paymentsRepo.createWalletLink(
        {
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          stellarPublicKey: account,
          verificationMethod: 'sep10',
          verifiedAt: now,
          activeOwnerKey: `${owner.ownerType}:${owner.ownerId}`,
        },
        tx,
      );
    });
  } catch (err) {
    // P2002 on activeOwnerKey = a concurrent request created the link
    // first (interactive transaction aborted, nonce restored above).
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
      throw new HttpError(409, 'Another wallet link for this account was just created. Refresh and try again.', 'WALLET_LINK_CONFLICT');
    }
    throw err;
  }
}

/** GET /payments/wallet-link — the caller's own ACTIVE link (replaced
 * rows are history, not exposed here). Null when none. */
export async function getOwnWalletLink(userId: string, role: Role): Promise<WalletLink | null> {
  const owner = await resolveCallerOwner(userId, role);
  return paymentsRepo.findActiveWalletLink(owner.ownerType, owner.ownerId);
}

// --- Funding cutoff guard (requirement 4) --------------------------------

/** True once a wallet link may be used as an escrow payee/funder:
 * verified links always; `unverified_legacy` links only before
 * WALLET_LINK_UNVERIFIED_FUNDING_CUTOFF. Exported (and pure in
 * `nowMs`/cutoff) so tests can walk the whole matrix without waiting for
 * a real date to pass. */
export function walletLinkFundingAllowed(
  verificationMethod: WalletLinkVerificationMethod,
  cutoffMs: number,
  nowMs: number,
): boolean {
  if (verificationMethod === 'sep10') return true;
  return nowMs <= cutoffMs;
}

/** The enforcement point used by the funding service (not a controller
 * check): refuses to fund an escrow whose payee is an unverified legacy
 * link after the cutoff. Fail-closed on a misparsed cutoff rather than
 * silently allowing funding. */
export function assertWalletLinkFundingAllowed(link: Pick<WalletLink, 'verificationMethod'>): void {
  const cutoffMs = config.payments.walletLinkUnverifiedFundingCutoff;
  if (Number.isNaN(cutoffMs)) {
    throw new HttpError(
      500,
      'WALLET_LINK_UNVERIFIED_FUNDING_CUTOFF is not a valid date — funding is refused until it is.',
      'PAYMENTS_MISCONFIGURED',
    );
  }
  if (!walletLinkFundingAllowed(link.verificationMethod, cutoffMs, Date.now())) {
    throw new HttpError(
      409,
      "This facility's wallet link predates SEP-10 verification and the funding cutoff has passed. Re-link with a SEP-10-verified wallet to fund payments.",
      'WALLET_LINK_UNVERIFIED',
    );
  }
}

/**
 * Startup validation (requirement 4: "validated at startup"). Called
 * from src/server.ts next to validateSep10Config() — a malformed cutoff
 * must stop boot instead of surfacing as a 500 at first funding.
 * Names the env var, never any value.
 */
export function validateWalletLinkConfig(): void {
  if (Number.isNaN(config.payments.walletLinkUnverifiedFundingCutoff)) {
    throw new Error('WALLET_LINK_UNVERIFIED_FUNDING_CUTOFF is not a valid ISO date.');
  }
}
