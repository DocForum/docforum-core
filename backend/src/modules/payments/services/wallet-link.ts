// Verified wallet links (issue #78, ADR 0005). Replaces the old
// facility-only, typed-in `POST /payments/wallet-link` body: an address
// is NEVER read from the request. The only way to create a link is to
// submit a signed SEP-10 challenge, and the address is derived from the
// account that challenge was issued for and successfully verified
// against (`verifySep10Challenge` from issue #77).
//
// Invariant (reviewer check): `createWalletLink` (the only WalletLink
// insert in the repositories) is called from exactly one place —
// `writeWalletLink` below, which also writes the issue #328 AuditEvent and
// cool-down in the same transaction. Its HTTP caller runs it only after
// `verifySep10Challenge` has resolved without throwing; the other caller is
// the test-fixture helper `linkWallet` in services/index.ts. There is no
// seed, no admin route, no script and no legacy write path;
// `unverified_legacy` rows only ever come from the
// add_verified_wallet_links migration backfill.
import { HttpError } from '../../../http-error';
import { config } from '../../../config';
import * as paymentsRepo from '../repositories';
import { verifySep10Challenge } from './sep10';
import type { PaymentIntent, Prisma, Role, WalletLink, WalletLinkOwnerType, WalletLinkVerificationMethod } from '@prisma/client';
import { findFacilityProfileByUserId, getFacilityNamesByIds } from '../../facilities/services';
import { findPatientProfileByUserId } from '../../patients/services';
import * as auditService from '../../audit/services';

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
    const profile = await findPatientProfileByUserId(userId);
    if (!profile) throw new HttpError(403, 'No patient profile is associated with this account.');
    return { ownerType: 'patient', ownerId: profile.id };
  }
  if (role === 'facility') {
    const profile = await findFacilityProfileByUserId(userId);
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
  actor: auditService.AuditActor = { userId, role, requestId: null },
): Promise<WalletLink> {
  const owner = await resolveCallerOwner(userId, role);
  const now = new Date();

  try {
    return await paymentsRepo.inTransaction(async (tx) => {
      // Full SEP-10 server verification, ledger binding (this user) and
      // atomic nonce consumption — inside this transaction.
      const { account } = await verifySep10Challenge(userId, signedChallengeTx, tx);
      return writeWalletLink(tx, actor, owner, account, now);
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

// --- Payout-address change audit + cool-down (issue #328) -----------------
//
// Rule: a facility's FIRST-EVER link is effective immediately (there is no
// earlier payee to redirect away from). Every later facility link becomes
// effective only WALLET_LINK_COOLDOWN_HOURS after it was created; until then
// the previously effective link keeps being the escrow payee for funding and
// prepare. Re-linking again inside the window cancels the pending link (it
// never takes effect) and restarts the window. Patient links (payer side)
// are immediate: they can't redirect a payout.
//
// Escrows already funded are bound on chain to the payee recorded at
// funding (PaymentIntent.fundedWalletAddress) and stay that way; release
// can never move them. assertEscrowPayeeEffective is a defence-in-depth
// check on the release paths on top of that.

type EffectiveCandidate = Pick<WalletLink, 'effectiveAt' | 'replacedAt' | 'createdAt'>;

/** A link replaced before it took effect was cancelled and never becomes
 * effective. */
export function isCancelledWalletLink(link: Pick<WalletLink, 'effectiveAt' | 'replacedAt'>): boolean {
  return link.replacedAt !== null && link.replacedAt.getTime() < link.effectiveAt.getTime();
}

/** Pure: the link that is the owner's payee at `now` — the latest-effective
 * row that has taken effect and was not cancelled. Exported for unit tests. */
export function selectEffectiveWalletLink<T extends EffectiveCandidate>(rows: readonly T[], now: Date): T | null {
  const candidates = rows.filter((row) => row.effectiveAt.getTime() <= now.getTime() && !isCancelledWalletLink(row));
  candidates.sort(
    (a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return candidates[0] ?? null;
}

/** The owner's effective link at `now` (the payee funding must use). */
export async function findEffectiveWalletLink(
  ownerType: WalletLinkOwnerType,
  ownerId: string,
  now: Date = new Date(),
  db?: Prisma.TransactionClient,
): Promise<WalletLink | null> {
  return selectEffectiveWalletLink(await paymentsRepo.findWalletLinksEffectiveBy(ownerType, ownerId, now, db), now);
}

function cooldownMs(): number {
  const hours = config.walletLink.cooldownHours;
  if (Number.isNaN(hours)) {
    throw new HttpError(
      500,
      'WALLET_LINK_COOLDOWN_HOURS is not a valid non-negative number — wallet changes are refused until it is.',
      'PAYMENTS_MISCONFIGURED',
    );
  }
  return hours * 60 * 60 * 1000;
}

/**
 * The ONLY WalletLink insert path. Runs inside the caller's transaction:
 * deactivates the current active row, inserts the new one with its
 * effectiveAt, and records the AuditEvent — all or nothing.
 */
export async function writeWalletLink(
  tx: Prisma.TransactionClient,
  actor: auditService.AuditActor,
  owner: WalletLinkOwner,
  account: string,
  now: Date,
): Promise<WalletLink> {
  const previousEffective = await findEffectiveWalletLink(owner.ownerType, owner.ownerId, now, tx);
  const previousActive = await paymentsRepo.findActiveWalletLink(owner.ownerType, owner.ownerId, tx);

  // Re-link deactivates rather than mutates/deletes: the previous row keeps
  // its address and history, and the active sentinel key frees up for the
  // new row (unique index keeps this race-safe). The deactivation count is
  // read-committed against the latest row, so two near-simultaneous "first"
  // links can't both claim the first-link exemption: the second either sees
  // the first and gets the cool-down, or loses the unique-key race (409).
  const { count: replaced } = await paymentsRepo.deactivateActiveWalletLink(owner.ownerType, owner.ownerId, now, tx);
  const firstLink = replaced === 0 && (await paymentsRepo.countWalletLinks(owner.ownerType, owner.ownerId, tx)) === 0;
  const delayMs = owner.ownerType === 'facility' && !firstLink ? cooldownMs() : 0;
  const effectiveAt = new Date(now.getTime() + delayMs);

  const link = await paymentsRepo.createWalletLink(
    {
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      stellarPublicKey: account,
      verificationMethod: 'sep10',
      verifiedAt: now,
      activeOwnerKey: `${owner.ownerType}:${owner.ownerId}`,
      effectiveAt,
    },
    tx,
  );

  const cancelledPending =
    previousActive !== null && previousActive.effectiveAt.getTime() > now.getTime() ? previousActive : null;
  // Facility payout addresses are business accounts and the point of the
  // audit row. A patient's payer address is NOT recorded: linking it to
  // their identity is the ADR 0005 on-chain privacy risk.
  const recordAccounts = owner.ownerType === 'facility';
  await auditService.record(tx, actor, {
    entityType: 'WalletLink',
    entityId: link.id,
    action: firstLink ? 'wallet_link.linked' : 'wallet_link.changed',
    fromState: previousEffective ? 'effective' : null,
    toState: effectiveAt.getTime() > now.getTime() ? 'pending' : 'effective',
    metadata: {
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      previousLinkId: previousEffective?.id ?? null,
      previousStellarAccount: recordAccounts ? previousEffective?.stellarPublicKey ?? null : null,
      newStellarAccount: recordAccounts ? account : null,
      effectiveAt: effectiveAt.toISOString(),
      cooldownHours: delayMs / (60 * 60 * 1000),
      firstLink,
      cancelledPendingLinkId: cancelledPending?.id ?? null,
    },
  });
  return link;
}

/** Thrown when an owner has a link but it is still inside its cool-down. */
function cooldownError(effectiveAt: Date): HttpError {
  return new HttpError(
    409,
    `The facility's new payout wallet is in its security cool-down until ${effectiveAt.toISOString()}.`,
    'WALLET_LINK_COOLDOWN',
  );
}

/**
 * The payee for funding/prepare: the facility's EFFECTIVE link. Never the
 * newest row — a link inside its cool-down is skipped in favour of the
 * previous effective one. No effective link at all: `notLinked` (each
 * caller keeps its existing error), or WALLET_LINK_COOLDOWN when the only
 * link is still pending.
 */
export async function requireEffectiveFacilityPayee(facilityId: string, notLinked: HttpError, now = new Date()): Promise<WalletLink> {
  const effective = await findEffectiveWalletLink('facility', facilityId, now);
  if (effective) return effective;
  const active = await paymentsRepo.findActiveWalletLink('facility', facilityId);
  if (active && active.effectiveAt.getTime() > now.getTime()) throw cooldownError(active.effectiveAt);
  throw notLinked;
}

/**
 * Release-path guard (defence in depth). An escrow's payee is fixed on
 * chain at funding, and funding only ever uses an effective link, so this
 * cannot fail through the normal flow. It refuses a release whose recorded
 * payee is known to this facility ONLY as a link that has not taken effect
 * (pending or cancelled). An address with no link row at all (pre-#78
 * escrows, escrows adopted from chain events) is not a wallet linked inside
 * the window and is left alone; a null fundedWalletAddress likewise.
 */
export async function assertEscrowPayeeEffective(
  intent: Pick<PaymentIntent, 'facilityId' | 'fundedWalletAddress'>,
  now = new Date(),
): Promise<void> {
  if (!intent.fundedWalletAddress) return;
  const links = await paymentsRepo.findFacilityWalletLinksByAccount(intent.facilityId, intent.fundedWalletAddress);
  if (links.length === 0) return;
  if (links.some((link) => link.effectiveAt.getTime() <= now.getTime() && !isCancelledWalletLink(link))) return;
  const soonest = links.reduce((a, b) => (a.effectiveAt < b.effectiveAt ? a : b));
  throw cooldownError(soonest.effectiveAt);
}

export interface PendingWalletLinkChange {
  id: string;
  facilityId: string;
  facilityName: string | null;
  newStellarPublicKey: string;
  previousStellarPublicKey: string | null;
  linkedAt: Date;
  effectiveAt: Date;
}

/** GET /admin/payments/wallet-links/pending — facility payout changes still
 * inside their cool-down, soonest first, with the address they replace. */
export async function listPendingFacilityWalletLinks(now = new Date(), limit = 100): Promise<PendingWalletLinkChange[]> {
  const pending = await paymentsRepo.findPendingFacilityWalletLinks(now, limit);
  if (pending.length === 0) return [];
  const facilityIds = [...new Set(pending.map((link) => link.ownerId))];
  const [names, previous] = await Promise.all([
    getFacilityNamesByIds(facilityIds),
    Promise.all(facilityIds.map(async (id) => [id, await findEffectiveWalletLink('facility', id, now)] as const)),
  ]);
  const nameById = new Map(names.map((facility) => [facility.id, facility.name]));
  const previousById = new Map(previous);
  return pending.map((link) => ({
    id: link.id,
    facilityId: link.ownerId,
    facilityName: nameById.get(link.ownerId) ?? null,
    newStellarPublicKey: link.stellarPublicKey,
    previousStellarPublicKey: previousById.get(link.ownerId)?.stellarPublicKey ?? null,
    linkedAt: link.createdAt,
    effectiveAt: link.effectiveAt,
  }));
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
  // Issue #328.
  if (Number.isNaN(config.walletLink.cooldownHours)) {
    throw new Error('WALLET_LINK_COOLDOWN_HOURS must be a non-negative number of hours.');
  }
}
