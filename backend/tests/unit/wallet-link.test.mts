// Unit tests for verified wallet links (issue #78) — no database, no
// network. Complements tests/integration/wallet-link.test.mts, which
// covers the HTTP/DB flows; this file covers the pure guards, the
// request schema, the privacy-notice verbatim guarantee, and startup
// validation of the cutoff env var.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config/index.js';
import { walletLinkSchema } from '../../src/modules/payments/validation.js';
import {
  PATIENT_WALLET_LINK_PRIVACY_NOTICE,
  assertWalletLinkFundingAllowed,
  validateWalletLinkConfig,
  walletLinkFundingAllowed,
} from '../../src/modules/payments/services/wallet-link.js';

// backend/tests/unit → repo root (the ADR lives outside backend/).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('patient wallet-link privacy notice (ADR 0005, verbatim)', () => {
  it('appears word-for-word in docs/adr/0005-non-custodial-patient-payments.md', () => {
    const adr = fs.readFileSync(path.join(REPO_ROOT, 'docs/adr/0005-non-custodial-patient-payments.md'), 'utf8');
    // Normalise whitespace on both sides: the constant collapses the
    // ADR's line wrapping to single spaces so it is usable in JSON, but
    // every word, punctuation mark and markdown tick must match — any
    // paraphrase fails this test.
    const normalise = (text: string) => text.replace(/\s+/g, ' ').trim();
    expect(normalise(adr)).toContain(normalise(PATIENT_WALLET_LINK_PRIVACY_NOTICE));
    expect(PATIENT_WALLET_LINK_PRIVACY_NOTICE).toContain('public forever');
    expect(PATIENT_WALLET_LINK_PRIVACY_NOTICE).toContain('must say this plainly');
  });
});

describe('funding cutoff guard (requirement 4)', () => {
  const cutoff = config.payments.walletLinkUnverifiedFundingCutoff;

  it('the test environment has a valid cutoff', () => {
    expect(Number.isNaN(cutoff)).toBe(false);
  });

  it('walletLinkFundingAllowed: legacy links work before the cutoff, never after; verified links always work', () => {
    expect(walletLinkFundingAllowed('unverified_legacy', cutoff, cutoff - 1)).toBe(true); // 1ms before
    expect(walletLinkFundingAllowed('unverified_legacy', cutoff, cutoff)).toBe(true); // boundary still allowed
    expect(walletLinkFundingAllowed('unverified_legacy', cutoff, cutoff + 1)).toBe(false); // just past
    expect(walletLinkFundingAllowed('unverified_legacy', cutoff, cutoff + 365 * 24 * 3600_000)).toBe(false);

    expect(walletLinkFundingAllowed('sep10', cutoff, cutoff - 1)).toBe(true);
    expect(walletLinkFundingAllowed('sep10', cutoff, cutoff + 1)).toBe(true);
    expect(walletLinkFundingAllowed('sep10', cutoff, Date.now())).toBe(true);
  });

  it('assertWalletLinkFundingAllowed passes for both kinds before the cutoff (default grace window)', () => {
    // This suite runs with the DEFAULT cutoff (2027-01-01) — well after
    // "now", so legacy links are still inside the grace window here;
    // the after-cutoff refusal path is integration-tested with an
    // explicit past cutoff in tests/integration/wallet-link.test.mts.
    expect(() => assertWalletLinkFundingAllowed({ verificationMethod: 'unverified_legacy' })).not.toThrow();
    expect(() => assertWalletLinkFundingAllowed({ verificationMethod: 'sep10' })).not.toThrow();
  });
});

describe('wallet-link request schema (strict — no raw addresses, ever)', () => {
  it('accepts exactly { transaction }', () => {
    expect(walletLinkSchema.parse({ transaction: 'AAAA' })).toEqual({ transaction: 'AAAA' });
  });

  it('rejects a typed-in address, with or without a transaction', () => {
    const address = 'G' + 'A'.repeat(55);
    expect(() => walletLinkSchema.parse({ transaction: 'AAAA', stellarPublicKey: address })).toThrow();
    expect(() => walletLinkSchema.parse({ stellarPublicKey: address })).toThrow();
    expect(() => walletLinkSchema.parse({ account: address })).toThrow();
    expect(() => walletLinkSchema.parse({})).toThrow();
    expect(() => walletLinkSchema.parse({ transaction: '' })).toThrow();
  });
});

describe('cutoff startup validation (requirement 4: validated at startup)', () => {
  it('passes with the test suite configuration', () => {
    expect(() => validateWalletLinkConfig()).not.toThrow();
  });

  it('names the env var when the cutoff is malformed', async () => {
    vi.resetModules();
    vi.stubEnv('WALLET_LINK_UNVERIFIED_FUNDING_CUTOFF', 'not-a-date');

    const fresh = await import('../../src/modules/payments/services/wallet-link.js');
    expect(() => fresh.validateWalletLinkConfig()).toThrow(/WALLET_LINK_UNVERIFIED_FUNDING_CUTOFF/);
    // Never echoes a value (this one isn't secret, but the rule is the
    // rule — same message shape as the other startup validators).
    expect(() => fresh.validateWalletLinkConfig()).not.toThrow(/not-a-date/);

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
