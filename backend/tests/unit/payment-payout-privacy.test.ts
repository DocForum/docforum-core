import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/http-error';
import { resolveEscrowPayee } from '../../src/modules/payments/services/payout-privacy';

const facilityAddress = `G${'A'.repeat(55)}`;
const poolAddress = `G${'B'.repeat(55)}`;

describe('payout privacy prototype', () => {
  it('keeps the facility wallet as the default payout destination', () => {
    expect(resolveEscrowPayee({ facilityAddress, mode: 'facility', production: true })).toBe(facilityAddress);
  });

  it('uses the shared pool only when explicitly enabled outside production', () => {
    expect(resolveEscrowPayee({ facilityAddress, mode: 'pooled', poolAddress, production: false })).toBe(poolAddress);
  });

  it('rejects pooled mode in production or without a valid pool address', () => {
    expect(() => resolveEscrowPayee({ facilityAddress, mode: 'pooled', poolAddress, production: true })).toThrow(HttpError);
    expect(() => resolveEscrowPayee({ facilityAddress, mode: 'pooled', production: false })).toThrow(HttpError);
    expect(() => resolveEscrowPayee({ facilityAddress, mode: 'pooled', poolAddress: `M${'A'.repeat(55)}`, production: false })).toThrow(HttpError);
  });
});