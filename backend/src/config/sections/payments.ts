import { parsePaymentsConfig } from '../payments';

const payoutPrivacyMode = process.env.PAYOUT_PRIVACY_MODE ?? 'facility';
if (payoutPrivacyMode !== 'facility' && payoutPrivacyMode !== 'pooled') {
  throw new Error('PAYOUT_PRIVACY_MODE must be either "facility" or "pooled".');
}

/** A payment asset the escrow may be denominated in (issue #79). The
 * contract id is the Stellar Asset Contract address the escrow pulls from;
 * `decimals` is informational for clients (every amount in this API is
 * already in the asset's smallest unit, so the server never scales one). */
export interface PaymentAsset {
  code: string;
  tokenContractId: string;
  decimals: number;
  /** Set for issued assets (e.g. USDC). Native XLM has none and needs no
   * trustline; every issued asset's payee must have one before funding. */
  issuer?: string;
}

// Testnet defaults. Override per environment with PAYMENT_ASSETS; production
// must set it explicitly (mainnet contract ids differ). Only assets without
// clawback, transfer fees or rebasing belong in the allowlist — escrow
// threat model T5 — and the parser refuses entries that opt into clawback or
// rebasing. This is a curated policy list, not an on-chain capability probe.
const TESTNET_NATIVE_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const TESTNET_USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const STELLAR_CONTRACT_ID = /^C[A-Z2-7]{55}$/;
const STELLAR_PUBLIC_KEY = /^G[A-Z2-7]{55}$/;

function parsePaymentAssets(raw: string | undefined): PaymentAsset[] {
  const fallback: PaymentAsset[] = [
    { code: 'XLM', tokenContractId: process.env.ESCROW_TOKEN_ID ?? TESTNET_NATIVE_SAC, decimals: 7 },
    {
      code: 'USDC',
      tokenContractId: TESTNET_USDC_SAC,
      decimals: 7,
      issuer: TESTNET_USDC_ISSUER,
    },
  ];
  if (!raw) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PAYMENT_ASSETS must be a JSON array of { code, tokenContractId, decimals, issuer? }.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('PAYMENT_ASSETS must be a non-empty JSON array.');
  }
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`PAYMENT_ASSETS[${index}] must be an object.`);
    const { code, tokenContractId, decimals, issuer, clawback, rebase } = entry as Record<string, unknown>;
    if (clawback === true || rebase === true) {
      throw new Error(`PAYMENT_ASSETS[${index}] opts into clawback/rebasing, which the escrow allowlist forbids (T5).`);
    }
    if (typeof code !== 'string' || !/^[A-Z0-9]{1,12}$/.test(code)) {
      throw new Error(`PAYMENT_ASSETS[${index}].code must be 1-12 uppercase alphanumeric characters.`);
    }
    if (seen.has(code)) throw new Error(`PAYMENT_ASSETS contains duplicate asset code ${code}.`);
    seen.add(code);
    if (typeof tokenContractId !== 'string' || !STELLAR_CONTRACT_ID.test(tokenContractId)) {
      throw new Error(`PAYMENT_ASSETS[${index}].tokenContractId must be a Stellar contract id.`);
    }
    if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw new Error(`PAYMENT_ASSETS[${index}].decimals must be an integer between 0 and 18.`);
    }
    if (issuer !== undefined && (typeof issuer !== 'string' || !STELLAR_PUBLIC_KEY.test(issuer))) {
      throw new Error(`PAYMENT_ASSETS[${index}].issuer must be a Stellar public key.`);
    }
    return { code, tokenContractId, decimals, ...(issuer ? { issuer } : {}) };
  });
}

/** Issue #78: the date after which funding refuses facility wallet links
 * that were never SEP-10 verified. Defaults to 2027-01-01 (UTC) — a
 * deliberate fail-closed default: legacy links keep working for a
 * defined grace window without any deployment needing to remember to
 * set the variable, but "never enforce" is never the default. Returns
 * NaN for a malformed value so startup validation can name the var. */
function parseWalletLinkCutoff(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return Date.parse('2027-01-01T00:00:00Z');
  return Date.parse(raw);
}

export const payments = {
  ...parsePaymentsConfig(process.env),
  // Issue #79: per-environment asset allowlist (USDC + native XLM by
  // default on testnet). The legacy `escrowTokenId`/`assetAllowlist`
  // fields above remain for the pre-#79 native-XLM path.
  assets: parsePaymentAssets(process.env.PAYMENT_ASSETS),
  // Horizon is read only for payee trustline checks — never for contract
  // calls, which go through the SDK.
  horizonUrl: process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
  // Issue #80: how long a prepared, unsigned create_escrow transaction is
  // considered live before the expiry job returns the intent to `created`.
  prepareTtlSeconds: Number(process.env.PAYMENT_PREPARE_TTL_SECONDS ?? 5 * 60),
  // ADR 0005: refund_after = order expiry + grace. Orders are still
  // placeholders without an expiry field (Phase 4), so the intent's own
  // createdAt is the order-expiry anchor today.
  orderExpiryHours: Number(process.env.PAYMENT_ORDER_EXPIRY_HOURS ?? 72),
  refundGraceHours: Number(process.env.PAYMENT_REFUND_GRACE_HOURS ?? 24),
  // Expiry sweep cadence (src/jobs/payment-intents.ts).
  prepareExpirySweepIntervalSeconds: Number(process.env.PAYMENT_PREPARE_EXPIRY_SWEEP_INTERVAL_SECONDS ?? 60),
  // Issue #24: how long a `funding` claim may stay unresolved before
  // scripts/reconcile-escrows.ts reports it. Generous — a slow testnet RPC
  // must not look like a crash.
  escrowFundingStaleAfterSeconds: Number(process.env.ESCROW_FUNDING_STALE_AFTER_SECONDS ?? 15 * 60),
  payoutPrivacyMode,
  payoutPrivacyPoolAddress: process.env.PAYOUT_PRIVACY_POOL_ADDRESS,
  walletLinkUnverifiedFundingCutoff: parseWalletLinkCutoff(
    process.env.WALLET_LINK_UNVERIFIED_FUNDING_CUTOFF,
  ),
} as const;
