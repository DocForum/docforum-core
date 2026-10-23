// SEP-10 Stellar Web Authentication server (issue #77, ADR 0005 step 4).
//
// Before a patient or facility wallet can be trusted as payer or payee,
// the backend must prove the caller controls that Stellar address. SEP-10
// is the standard flow: the server issues a challenge transaction, the
// user's wallet signs it server-side (the backend builds and submits
// everything; the browser only relays XDR — docforum-web hard rule 1),
// and the server verifies the signature. This file is generic
// infrastructure; wallet-link storage (patient/facility scoped links) is
// future work on top of it.
//
// What verifies what — the SEP-10 server verification list, in order:
//   1. base64 XDR deserializes as a Transaction          → readChallengeTx
//   2. sequence number == 0                              → readChallengeTx
//   3. tx source == server signing account               → readChallengeTx
//   4. bounded, unexpired timebounds                     → readChallengeTx (SDK
//      allows 5 min of clock-drift grace; our DB record enforces the issued
//      timeout strictly, so the two layers together are tighter than either)
//   5. >= 1 operation; first op is Manage Data with the client account as
//      source; key is "<home domain> auth"; value is a 48-byte-base64
//      nonce; subsequent ops are Manage Data sourced by the server with
//      web_auth_domain == ours                        → readChallengeTx
//   6. server signature present and valid                → readChallengeTx
//      (steps 1-6 = WebAuth.readChallengeTx)
//   7. client signatures: for a FUNDED account, signer weights loaded from
//      Horizon must meet the account's medium threshold
//      (verifyChallengeTxThreshold); for an UNFUNDED account (per spec —
//      see below) the master key must sign
//      (verifyChallengeTxSigners).
// Plus our own additions on top of the spec list: the challenge's nonce
// must exist in OUR issuance ledger, still unconsumed and unexpired
// (single-use, consumed atomically), and must be bound to the
// authenticated caller and the exact account in the challenge.
import { HttpError } from '../../../http-error';
import { config } from '../../../config';
import * as paymentsRepo from '../repositories';
import { loadStellarSdk } from './stellar-sdk-loader';
import type { Keypair, Transaction } from '@stellar/stellar-sdk' with { 'resolution-mode': 'import' };

// --- Configuration -------------------------------------------------------

export interface Sep10Config {
  serverKeypair: Keypair;
  serverAccountId: string;
  homeDomain: string;
  webAuthDomain: string;
  networkPassphrase: string;
  horizonUrl: string;
  timeoutSeconds: number;
}

/** Human-readable configuration problems, naming ENV VAR NAMES only —
 * never the secret value. Used by both the startup check and the lazy
 * per-request check. */
export async function sep10ConfigProblems(): Promise<string[]> {
  const problems: string[] = [];
  if (!config.sep10.signingSecret) problems.push('SEP10_SIGNING_SECRET');
  if (!config.sep10.homeDomain) problems.push('SEP10_HOME_DOMAIN');
  if (!config.sep10.webAuthDomain) problems.push('SEP10_WEB_AUTH_DOMAIN');
  if (!Number.isInteger(config.sep10.challengeTimeoutSeconds) || config.sep10.challengeTimeoutSeconds <= 0) {
    problems.push('SEP10_CHALLENGE_TIMEOUT_SECONDS (must be a positive integer)');
  }
  if (config.sep10.signingSecret) {
    const { Keypair } = await loadStellarSdk();
    try {
      Keypair.fromSecret(config.sep10.signingSecret);
    } catch {
      // The parse error itself would echo the bad secret — report the var
      // name, never the value.
      problems.push('SEP10_SIGNING_SECRET (not a valid Stellar secret key)');
    }
  }
  return problems;
}

/** Startup validation (issue #77: "validate at startup"). Called from
 * src/server.ts before the listener starts, so a deployment with a
 * missing/typo'd web-auth key fails to boot instead of 500ing on the
 * first challenge request. Deliberately NOT called at module import:
 * test suites build the app without importing server.ts. */
export async function validateSep10Config(): Promise<void> {
  const problems = await sep10ConfigProblems();
  if (problems.length > 0) {
    throw new Error(`SEP-10 configuration invalid — missing or invalid env var(s): ${problems.join(', ')}.`);
  }
}

/** Lazy per-request check for paths that need the config (mirrors
 * requirePaymentsConfig in the sibling payments services). Throws a 500
 * HttpError, not a boot failure — this is the second line of defence for
 * environments that don't run server.ts. */
async function requireSep10Config(): Promise<Sep10Config> {
  const problems = await sep10ConfigProblems();
  if (problems.length > 0) {
    throw new HttpError(500, `SEP-10 is not configured — missing or invalid env var(s): ${problems.join(', ')}.`);
  }
  const { Keypair } = await loadStellarSdk();
  const serverKeypair = Keypair.fromSecret(config.sep10.signingSecret!);
  return {
    serverKeypair,
    serverAccountId: serverKeypair.publicKey(),
    homeDomain: config.sep10.homeDomain!,
    webAuthDomain: config.sep10.webAuthDomain!,
    networkPassphrase: config.sep10.networkPassphrase,
    horizonUrl: config.sep10.horizonUrl,
    timeoutSeconds: config.sep10.challengeTimeoutSeconds,
  };
}

// --- Horizon seam (tests inject a fake; no network in the test suite) ----

export interface Sep10Signer {
  key: string;
  weight: number;
  type: string;
}

export interface Sep10AccountInfo {
  accountId: string;
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
  signers: Sep10Signer[];
}

/** Returns null when the account does not exist on the network yet
 * (Horizon 404 — the SEP-10 "unfunded" case). Throws on any other
 * Horizon failure. */
export type Sep10AccountFetcher = (accountId: string) => Promise<Sep10AccountInfo | null>;

let accountFetcherOverride: Sep10AccountFetcher | undefined;

/** Test seam, same pattern as auth's setEmailSender: unit/integration
 * tests replace the outbound Horizon call through this module's service
 * surface instead of mocking a network client. Never called with an
 * override in production code. */
export function setSep10AccountFetcher(fetcher: Sep10AccountFetcher): void {
  accountFetcherOverride = fetcher;
}

export function resetSep10AccountFetcher(): void {
  accountFetcherOverride = undefined;
}

function isHorizonNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { name?: string; status?: number; response?: { status?: number } };
  return candidate.name === 'NotFoundError' || candidate.status === 404 || candidate.response?.status === 404;
}

async function defaultAccountFetcher(accountId: string): Promise<Sep10AccountInfo | null> {
  const { Horizon } = await loadStellarSdk();
  const horizon = new Horizon.Server(config.sep10.horizonUrl);
  try {
    const account = await horizon.accounts().accountId(accountId).call();
    return {
      accountId: account.id,
      thresholds: {
        low_threshold: account.thresholds.low_threshold,
        med_threshold: account.thresholds.med_threshold,
        high_threshold: account.thresholds.high_threshold,
      },
      signers: account.signers.map((signer) => ({ key: signer.key, weight: signer.weight, type: signer.type })),
    };
  } catch (err) {
    if (isHorizonNotFound(err)) return null;
    throw err;
  }
}

async function fetchAccountInfo(accountId: string): Promise<Sep10AccountInfo | null> {
  try {
    return await (accountFetcherOverride ?? defaultAccountFetcher)(accountId);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (isHorizonNotFound(err)) return null;
    // Don't forward Horizon/axios internals (URLs, request config) to the
    // client — the fact that we couldn't load signers is all they get.
    throw new HttpError(502, 'Could not load the account from Horizon to verify its signers.', 'SEP10_HORIZON_UNAVAILABLE');
  }
}

// --- Challenge building --------------------------------------------------

/** The nonce is the base64 string in the first Manage Data op's value
 * ("<home domain> auth", source = client account): 48 random bytes
 * base64-encoded to 64 chars, per SEP-10. That exact string is what gets
 * stored as Sep10Challenge.nonce — the single-use key. */
function challengeNonce(tx: Transaction): string {
  const [firstOp] = tx.operations;
  if (!firstOp || firstOp.type !== 'manageData') {
    throw new HttpError(500, 'Built challenge is malformed (first operation is not Manage Data).');
  }
  // Parsed Manage Data values arrive as a string for valid UTF-8 (which
  // a base64 nonce always is) and as a Buffer otherwise; normalise to
  // the exact string form SEP-10 specifies.
  const value = firstOp.value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

/** Parses a submitted challenge XDR just enough to pull the nonce out.
 * Assumes the caller already ran WebAuth.readChallengeTx (structure,
 * timebounds and server signature are its job, not this helper's). */
function signedChallengeNonce(tx: Transaction): string {
  return challengeNonce(tx);
}

export interface Sep10ChallengeResponse {
  transaction: string;
  expires_in: number;
  network_passphrase: string;
}

/** GET /payments/sep10/challenge — builds a server-signed SEP-10
 * challenge for `account` and records the issuance binding
 * (userId, account, nonce, expiresAt) so a verified signature can only
 * ever be redeemed by that user, for that account, once. */
export async function createSep10Challenge(userId: string, account: string): Promise<Sep10ChallengeResponse> {
  const { StrKey, WebAuth } = await loadStellarSdk();

  // Full strkey validation (base32 + CRC16 checksum), not just the G…
  // shape — a checksum-invalid key would otherwise be discovered only at
  // wallet-signing time.
  if (!StrKey.isValidEd25519PublicKey(account)) {
    throw new HttpError(400, 'account must be a valid Stellar public key (G…).', 'SEP10_INVALID_ACCOUNT');
  }

  const cfg = await requireSep10Config();

  let transaction: string;
  try {
    // Server-signed, Manage Data nonce, bounded timebounds, home domain
    // and web_auth_domain — all handled by the SDK helper.
    transaction = WebAuth.buildChallengeTx(
      cfg.serverKeypair,
      account,
      cfg.homeDomain,
      cfg.timeoutSeconds,
      cfg.networkPassphrase,
      cfg.webAuthDomain,
    );
  } catch (err) {
    // No secret can appear here (the keypair was already validated), but
    // keep the message generic anyway.
    throw new HttpError(500, `Could not build the SEP-10 challenge: ${err instanceof Error ? err.message : 'unknown error'}`);
  }

  // Read our own challenge back through the same validation path a client
  // submission takes — if it doesn't round-trip, we'd be handing out a
  // challenge we would later reject.
  const read = WebAuth.readChallengeTx(transaction, cfg.serverAccountId, cfg.networkPassphrase, cfg.homeDomain, cfg.webAuthDomain);
  const nonce = challengeNonce(read.tx);
  const maxTimeSeconds = Number(read.tx.timeBounds?.maxTime ?? NaN);
  if (!Number.isFinite(maxTimeSeconds)) {
    throw new HttpError(500, 'Built challenge has no time bounds.');
  }
  const expiresAt = new Date(maxTimeSeconds * 1000);

  await paymentsRepo.createSep10Challenge({ userId, account, nonce, expiresAt });

  return {
    transaction,
    expires_in: cfg.timeoutSeconds,
    network_passphrase: cfg.networkPassphrase,
  };
}

// --- Challenge verification ---------------------------------------------

export interface Sep10VerifyResult {
  account: string;
  signers: string[];
}

/** POST /payments/sep10/verify — the full SEP-10 server verification
 * list plus DocForum's own single-use/binding rules. On success the
 * caller has proven control of `account` (fundamentally: the same proof
 * of control the Stellar network itself would honour for this
 * transaction), and the challenge is consumed.
 *
 * UNFUNDED ACCOUNTS (SEP-10 spec): an account that does not exist on the
 * network has no signers and no thresholds on record, so weights cannot
 * be checked. The spec's rule for that case is that the challenge must be
 * signed by the account's MASTER key, and by exactly one other signature
 * (the server's) on the envelope — verifyChallengeTxSigners enforces
 * both. We detect the unfunded case by a Horizon 404; any other Horizon
 * error is a 502, never silently treated as unfunded (that would downgrade
 * multisig accounts to master-key-only verification).
 *
 * This endpoint does NOT mint a DocForum session JWT: DocForum's own
 * auth (Bearer access token) already authenticates the caller — SEP-10's
 * job here is proving wallet control, not issuing a session. */
export async function verifySep10Challenge(userId: string, challengeTx: string): Promise<Sep10VerifyResult> {
  const cfg = await requireSep10Config();
  const { WebAuth } = await loadStellarSdk();

  // Steps 1-6 of the SEP-10 list: deserialize, sequence == 0, source ==
  // server account, bounded/unexpired timebounds, operation shape
  // (first op Manage Data sourced by the client with "<home domain> auth"
  // key and a valid nonce, later ops Manage Data sourced by the server,
  // web_auth_domain == ours), and the server signature.
  let read: { tx: Transaction; clientAccountID: string };
  try {
    read = WebAuth.readChallengeTx(
      challengeTx,
      cfg.serverAccountId,
      cfg.networkPassphrase,
      cfg.homeDomain,
      cfg.webAuthDomain,
    );
  } catch (err) {
    throw new HttpError(400, `Invalid challenge: ${err instanceof Error ? err.message : 'could not parse transaction'}`, 'SEP10_INVALID_CHALLENGE');
  }

  const nonce = signedChallengeNonce(read.tx);

  // Our own ledger: was this challenge issued by us, is it still good,
  // and is it THIS caller's, for THIS account? Checked before the Horizon
  // round trip so a mismatched submission can't make us fetch signers.
  const record = await paymentsRepo.findSep10ChallengeByNonce(nonce);
  if (!record) {
    throw new HttpError(401, 'Challenge was not issued by this server.', 'SEP10_CHALLENGE_UNKNOWN');
  }
  if (record.userId !== userId || record.account !== read.clientAccountID) {
    // A signed challenge is never transferable: not to another user, and
    // not for another account than the one the challenge was issued for.
    throw new HttpError(403, 'This challenge was issued to a different user or account.', 'SEP10_CHALLENGE_NOT_FOR_CALLER');
  }
  if (record.consumedAt) {
    throw new HttpError(401, 'This challenge has already been used.', 'SEP10_CHALLENGE_ALREADY_USED');
  }
  // Strict check against OUR clock, without the SDK's 5-minute drift
  // grace — a challenge is good for exactly the window we issued it for.
  if (record.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(401, 'This challenge has expired.', 'SEP10_CHALLENGE_EXPIRED');
  }

  // Steps 7/8 of the SEP-10 list: client signatures.
  const accountInfo = await fetchAccountInfo(read.clientAccountID);
  let matchedSigners: string[];
  try {
    if (accountInfo === null) {
      // Unfunded account — no on-chain signers/thresholds exist; the
      // master key must sign (documented in the API docs as well).
      matchedSigners = WebAuth.verifyChallengeTxSigners(
        challengeTx,
        cfg.serverAccountId,
        cfg.networkPassphrase,
        [read.clientAccountID],
        cfg.homeDomain,
        cfg.webAuthDomain,
      );
    } else {
      // Multisig: load signers + thresholds from Horizon and enforce the
      // account's MEDIUM threshold — SEP-10's guidance is medium for
      // authority aligned with the ability to move funds, which is
      // exactly what a verified wallet link gates. The server's own
      // signature contributes no client weight (enforced by the SDK).
      matchedSigners = WebAuth.verifyChallengeTxThreshold(
        challengeTx,
        cfg.serverAccountId,
        cfg.networkPassphrase,
        accountInfo.thresholds.med_threshold,
        accountInfo.signers,
        cfg.homeDomain,
        cfg.webAuthDomain,
      );
    }
  } catch (err) {
    // A structurally sound challenge whose client signature is missing,
    // unknown, or below threshold.
    throw new HttpError(401, `Challenge signature verification failed: ${err instanceof Error ? err.message : 'unknown error'}`, 'SEP10_INVALID_SIGNATURE');
  }

  // Step 9 — single-use, consumed atomically and LAST: a bad signature
  // never burns a legitimately issued nonce, and two concurrent replays
  // of the same signed challenge race here — exactly one conditional
  // UPDATE wins (`WHERE consumedAt IS NULL AND expiresAt > now`).
  const consumedAt = new Date();
  const { count } = await paymentsRepo.consumeSep10Challenge(nonce, consumedAt);
  if (count !== 1) {
    throw new HttpError(401, 'This challenge has already been used.', 'SEP10_CHALLENGE_ALREADY_USED');
  }

  return { account: read.clientAccountID, signers: matchedSigners };
}
