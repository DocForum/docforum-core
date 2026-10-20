import { z } from 'zod';

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';
const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

const optionalTrimmedString = z.preprocess((value) => value === '' ? undefined : value, z.string().trim().min(1).optional());
const paymentsEnvironmentSchema = z.object({
  ESCROW_NETWORK_PASSPHRASE: z.string().trim().min(1).default(TESTNET_PASSPHRASE),
  ESCROW_RPC_URL: z.string().url().default(TESTNET_RPC_URL),
  SOROBAN_RPC_URL: z.string().url().optional(),
  ESCROW_CONTRACTS: z.string().default(''),
  ESCROW_EVENT_START_LEDGER: z.string().default('1'),
  ESCROW_EVENT_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
  ESCROW_EVENT_ALERT_WEBHOOK_URL: optionalTrimmedString,
  ESCROW_CONTRACT_ID: optionalTrimmedString,
  ESCROW_HEALTHCHECK_ID: z.preprocess((value) => value === '' ? undefined : value, z.string().regex(/^[1-9][0-9]*$/).optional()),
  ESCROW_LEGACY_CONTRACT_IDS: z.string().default(''),
  ESCROW_TOKEN_ID: optionalTrimmedString,
  ESCROW_ASSET_ALLOWLIST: z.string().default(''),
  ALLOW_MAINNET: z.enum(['true', 'false']).default('false'),
});

export function parsePaymentsConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = paymentsEnvironmentSchema.parse(env);
  const allowMainnet = parsed.ALLOW_MAINNET === 'true';
  if (parsed.ESCROW_NETWORK_PASSPHRASE === MAINNET_PASSPHRASE && !allowMainnet) {
    throw new Error('Payments mainnet is disabled. Set ALLOW_MAINNET=true only after the required security review.');
  }

  const legacyContractIds = splitList(parsed.ESCROW_LEGACY_CONTRACT_IDS);
  const rawContracts = parsed.ESCROW_CONTRACTS || (parsed.ESCROW_CONTRACT_ID ? parsed.ESCROW_CONTRACT_ID + '@' + parsed.ESCROW_EVENT_START_LEDGER : '');
  const escrowContracts = rawContracts.split(',').map((entry) => {
    const [contractId, rawStartLedger = '1'] = entry.trim().split('@');
    if (!contractId) return null;
    const startLedger = Number(rawStartLedger);
    if (!Number.isSafeInteger(startLedger) || startLedger < 1) throw new Error(`Invalid ESCROW_CONTRACTS entry: ${entry}`);
    return { contractId, startLedger };
  }).filter((entry): entry is { contractId: string; startLedger: number } => entry !== null);
  const configuredAssets = splitList(parsed.ESCROW_ASSET_ALLOWLIST);
  const assetAllowlist = configuredAssets.length > 0
    ? configuredAssets
    : parsed.ESCROW_TOKEN_ID ? [parsed.ESCROW_TOKEN_ID] : [];
  const healthCheckEscrowId = parsed.ESCROW_HEALTHCHECK_ID ? BigInt(parsed.ESCROW_HEALTHCHECK_ID) : null;
  const startupCheckEnabled = env.NODE_ENV !== 'test' && parsed.ESCROW_CONTRACT_ID !== undefined;

  if (startupCheckEnabled && healthCheckEscrowId === null) {
    throw new Error('ESCROW_HEALTHCHECK_ID is required when payments startup verification is enabled.');
  }

  return {
    platformPayerSecret: env.PLATFORM_PAYER_SECRET,
    platformReleaserSecret: env.PLATFORM_RELEASER_SECRET,
    platformSignerMode: env.PLATFORM_SIGNER_MODE ?? 'env',
    platformSignerUrl: env.PLATFORM_SIGNER_URL,
    platformSignerToken: env.PLATFORM_SIGNER_TOKEN,
    platformPayerPublicKey: env.PLATFORM_PAYER_PUBLIC_KEY,
    platformReleaserPublicKey: env.PLATFORM_RELEASER_PUBLIC_KEY,
    platformSignerTimeoutMs: Number(env.PLATFORM_SIGNER_TIMEOUT_MS ?? 10_000),
    activeContractId: parsed.ESCROW_CONTRACT_ID,
    legacyContractIds,
    contractIds: parsed.ESCROW_CONTRACT_ID
      ? [parsed.ESCROW_CONTRACT_ID, ...legacyContractIds]
      : legacyContractIds,
    healthCheckEscrowId,
    startupCheckEnabled,
    networkPassphrase: parsed.ESCROW_NETWORK_PASSPHRASE,
    rpcUrl: parsed.ESCROW_RPC_URL,
    sorobanRpcUrl: parsed.SOROBAN_RPC_URL ?? parsed.ESCROW_RPC_URL,
    escrowContracts,
    escrowEventPollIntervalSeconds: parsed.ESCROW_EVENT_POLL_INTERVAL_SECONDS,
    escrowEventAlertWebhookUrl: parsed.ESCROW_EVENT_ALERT_WEBHOOK_URL,
    escrowTokenId: parsed.ESCROW_TOKEN_ID,
    assetAllowlist,
  };
}

function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}