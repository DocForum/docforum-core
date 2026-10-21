// Unit tests for the facility price-list selection rules (issue #127).
// Pure helpers only: no database, no HTTP, so these run anywhere.
import { describe, expect, it } from 'vitest';
import {
  NATIVE_PRICE_ASSET,
  parseEffectiveFrom,
  priceOnRequestError,
  selectCurrentPrice,
} from '../../src/modules/facilities/pricing';
import { MAX_STROOPS, parseStroopsAmount } from '../../src/utils/stroops';
import { prescriptionSchema, labOrderSchema } from '../../src/modules/orders/validation';

const version = (iso: string, amount: bigint) => ({ effectiveFrom: new Date(iso), amount });

describe('selectCurrentPrice', () => {
  const versions = [version('2026-10-01T00:00:00.000Z', 100n), version('2026-10-10T00:00:00.000Z', 200n)];

  it('returns the latest version not after the instant', () => {
    expect(selectCurrentPrice(versions, new Date('2026-10-15T00:00:00.000Z'))?.amount).toBe(200n);
    expect(selectCurrentPrice(versions, new Date('2026-10-05T00:00:00.000Z'))?.amount).toBe(100n);
  });

  it('treats a version effective exactly at the instant as in force', () => {
    expect(selectCurrentPrice(versions, new Date('2026-10-10T00:00:00.000Z'))?.amount).toBe(200n);
  });

  it('returns undefined before the first version (price on request)', () => {
    expect(selectCurrentPrice(versions, new Date('2026-09-30T23:59:59.999Z'))).toBeUndefined();
  });

  it('does not depend on row order', () => {
    expect(selectCurrentPrice([...versions].reverse(), new Date('2026-10-15T00:00:00.000Z'))?.amount).toBe(200n);
  });
});

describe('parseStroopsAmount', () => {
  it('accepts plain digit strings and bigints', () => {
    expect(parseStroopsAmount('10000000')).toBe(10_000_000n);
    expect(parseStroopsAmount(5n)).toBe(5n);
  });

  it.each(['0', '-1', '1.5', '1e7', ' 1', 'abc', ''])('rejects %j', (value) => {
    expect(() => parseStroopsAmount(value)).toThrowError(/must be/);
  });

  it('rejects an amount above i128::MAX', () => {
    expect(() => parseStroopsAmount((MAX_STROOPS + 1n).toString())).toThrowError(/representable range/);
    expect(parseStroopsAmount(MAX_STROOPS.toString())).toBe(MAX_STROOPS);
  });

  it('rejects unsafe JS numbers rather than rounding them', () => {
    expect(() => parseStroopsAmount(Number.MAX_SAFE_INTEGER + 2)).toThrowError(/safe integer/);
  });
});

describe('parseEffectiveFrom', () => {
  it('defaults to now', () => {
    const now = new Date('2026-10-20T12:00:00.000Z');
    expect(parseEffectiveFrom(undefined, now)).toEqual(now);
  });

  it('accepts ISO strings and rejects invalid dates', () => {
    expect(parseEffectiveFrom('2026-10-21T00:00:00.000Z').toISOString()).toBe('2026-10-21T00:00:00.000Z');
    expect(() => parseEffectiveFrom('not-a-date')).toThrowError(/ISO-8601/);
  });
});

describe('priceOnRequestError', () => {
  it('is a 422 with a stable machine-readable code', () => {
    const error = priceOnRequestError('CBC');
    expect(error.status).toBe(422);
    expect(error.code).toBe('PRICE_ON_REQUEST');
    expect(error.message).toContain('CBC');
  });
});

describe('native price asset', () => {
  it('defaults quotes to native XLM', () => {
    expect(NATIVE_PRICE_ASSET).toBe('native');
  });
});

describe('order pricing validation (issue #127)', () => {
  const base = { facilityProfileId: '5b1d4c0e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', items: [] as never[] };
  const prescriptionItem = { drugName: 'Amoxicillin', dosage: '500mg', frequency: 'TID', duration: '7d' };

  it('accepts amountStroops alone (legacy manual pricing)', () => {
    const parsed = prescriptionSchema.parse({ ...base, items: [prescriptionItem], amountStroops: '15000000' });
    expect(parsed.amountStroops).toBe(15_000_000n);
    expect(parsed.catalogItemCode).toBeUndefined();
  });

  it('accepts catalogItemCode alone (facility price list)', () => {
    const parsed = prescriptionSchema.parse({ ...base, items: [prescriptionItem], catalogItemCode: 'amoxicillin-500mg' });
    expect(parsed.catalogItemCode).toBe('amoxicillin-500mg');
    expect(parsed.amountStroops).toBeUndefined();
  });

  it('rejects both or neither', () => {
    expect(() => prescriptionSchema.parse({ ...base, items: [prescriptionItem], amountStroops: '100', catalogItemCode: 'x' })).toThrowError(/exactly one/);
    expect(() => prescriptionSchema.parse({ ...base, items: [prescriptionItem] })).toThrowError(/exactly one/);
    expect(() => labOrderSchema.parse({ facilityProfileId: base.facilityProfileId, testType: 'CBC' })).toThrowError(/exactly one/);
  });

  it('still rejects a malformed manual amount', () => {
    expect(() => prescriptionSchema.parse({ ...base, items: [prescriptionItem], amountStroops: '0' })).toThrowError();
  });
});
