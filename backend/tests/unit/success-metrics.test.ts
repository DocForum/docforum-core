import { describe, expect, it } from 'vitest';
import { formatMetrics } from '../../src/modules/metrics/services';
import { metricsQuerySchema } from '../../src/modules/metrics/validation';

const from = new Date('2026-01-01T00:00:00.000Z');
const to = new Date('2026-02-01T00:00:00.000Z');

describe('success metrics formatting', () => {
  it('requires offset-aware dates and a bounded, increasing UTC interval', () => {
    expect(metricsQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-02' }).success).toBe(false);
    expect(metricsQuerySchema.safeParse({ from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' }).success).toBe(false);
    expect(metricsQuerySchema.safeParse({ from: '2025-01-01T00:00:00Z', to: '2026-02-02T00:00:00Z' }).success).toBe(false);
  });

  it('computes no-show rate and average booking lead time for eligible appointments', () => {
    const result = formatMetrics({
      eligibleCount: 10n,
      noShowCount: 2n,
      averageLeadSeconds: 172_800,
      leadTimeCount: 10n,
    }, from, to);

    expect(result.window.timeZone).toBe('UTC');
    expect(result.metrics.noShowRate).toMatchObject({ status: 'available', value: 0.2, numerator: 2, denominator: 10 });
    expect(result.metrics.bookingLeadTimeDays).toMatchObject({ status: 'available', value: 2, denominator: 10 });
    expect(result.metrics.referralCompletionRate.status).toBe('not_yet_available');
    expect(result.metrics.timeFromSymptomToOrder.status).toBe('not_yet_available');
    expect(result.metrics.ordersFulfilledWithinNDays.status).toBe('not_yet_available');
  });

  it('suppresses aggregate values when fewer than five records qualify', () => {
    const result = formatMetrics({
      eligibleCount: 4n,
      noShowCount: 1n,
      averageLeadSeconds: 86_400,
      leadTimeCount: 4n,
    }, from, to);

    expect(result.metrics.noShowRate).toMatchObject({ status: 'suppressed', value: null, numerator: null, denominator: null });
    expect(result.metrics.bookingLeadTimeDays).toMatchObject({ status: 'suppressed', value: null, denominator: null });
  });
});
