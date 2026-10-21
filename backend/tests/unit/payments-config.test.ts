import { describe, expect, it } from 'vitest';
import { parsePaymentsConfig } from '../../src/config/payments';

const TESTNET = 'Test SDF Network ; September 2015';
const MAINNET = 'Public Global Stellar Network ; September 2015';

describe('payments config', () => {
  it('defaults to testnet and disables live startup checks in tests', () => {
    const config = parsePaymentsConfig({ NODE_ENV: 'test' });
    expect(config).toMatchObject({
      networkPassphrase: TESTNET,
      rpcUrl: 'https://soroban-testnet.stellar.org',
      activeContractId: undefined,
      legacyContractIds: [],
      assetAllowlist: [],
      startupCheckEnabled: false,
    });
  });

  it('rejects mainnet without the explicit opt-in', () => {
    expect(() => parsePaymentsConfig({ ESCROW_NETWORK_PASSPHRASE: MAINNET }))
      .toThrow(/mainnet is disabled/i);
  });

  it('allows mainnet only with ALLOW_MAINNET=true', () => {
    expect(parsePaymentsConfig({ ESCROW_NETWORK_PASSPHRASE: MAINNET, ALLOW_MAINNET: 'true' }).networkPassphrase)
      .toBe(MAINNET);
  });

  it('parses active and legacy contracts and asset allowlist', () => {
    const config = parsePaymentsConfig({
      NODE_ENV: 'test',
      ESCROW_CONTRACT_ID: 'C_ACTIVE',
      ESCROW_LEGACY_CONTRACT_IDS: 'C_OLD_1, C_OLD_2',
      ESCROW_ASSET_ALLOWLIST: 'C_TOKEN_1, C_TOKEN_2',
    });
    expect(config.contractIds).toEqual(['C_ACTIVE', 'C_OLD_1', 'C_OLD_2']);
    expect(config.assetAllowlist).toEqual(['C_TOKEN_1', 'C_TOKEN_2']);
  });

  it('requires a health check escrow id when startup verification is enabled', () => {
    expect(() => parsePaymentsConfig({ NODE_ENV: 'production', ESCROW_CONTRACT_ID: 'C_ACTIVE' }))
      .toThrow(/ESCROW_HEALTHCHECK_ID is required/i);
  });
});
