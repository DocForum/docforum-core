// The derived `expiresAt` a patient sees and the sweep that expires the row
// must be the same rule (issue #361 — "reviewer checks the field and the sweep
// use one shared function"). These tests pin that agreement without a
// database: the sweep's cutoff is captured from the repository call, and the
// field is computed from the exported rule, then compared over the ages that
// sit right on the boundary.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReferralStatus } from '@prisma/client';
import { config } from '../../src/config';
import {
  expireStaleReferrals,
  pendingReferralExpiresAt,
} from '../../src/modules/referrals/services';
import * as referralsRepo from '../../src/modules/referrals/repositories';

vi.mock('../../src/modules/referrals/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/modules/referrals/repositories')>()),
  expireStalePendingReferrals: vi.fn(),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES: ReferralStatus[] = ['accepted', 'declined', 'completed', 'expired', 'cancelled'];

/** The cutoff the sweep actually queried with, for its most recent run. */
async function lastSweepCutoff(): Promise<Date> {
  const call = vi.mocked(referralsRepo.expireStalePendingReferrals).mock.calls.at(-1);
  if (!call) throw new Error('expireStalePendingReferrals was not called');
  return call[1];
}

function row(status: ReferralStatus, updatedAt: Date) {
  return { status, updatedAt };
}

describe('pending referral expiry rule (issue #361)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(referralsRepo.expireStalePendingReferrals).mockResolvedValue({ count: 0 } as never);
  });

  it('gives a pending referral updatedAt + TTL', () => {
    const updatedAt = new Date('2026-11-01T08:00:00.000Z');
    const ttl = config.referrals.pendingTtlDays * DAY_MS;

    expect(pendingReferralExpiresAt(row('pending', updatedAt))).toEqual(new Date(updatedAt.getTime() + ttl));
  });

  it('returns null for every non-pending status', () => {
    const updatedAt = new Date('2026-11-01T08:00:00.000Z');

    for (const status of TERMINAL_STATUSES) {
      expect(pendingReferralExpiresAt(row(status, updatedAt)), status).toBeNull();
    }
  });

  it('agrees with the sweep on which pending referrals are past their deadline', async () => {
    vi.mocked(referralsRepo.expireStalePendingReferrals).mockResolvedValue({ count: 0 } as never);
    const now = new Date('2026-11-20T12:00:00.000Z');
    await expireStaleReferrals(now);
    const cutoff = await lastSweepCutoff();

    // Ages straddling the boundary, including the exact threshold. The sweep's
    // predicate is `updatedAt < cutoff`, so a referral exactly TTL old is still
    // alive — and its deadline is exactly `now`, i.e. not yet `< now`.
    const ttl = config.referrals.pendingTtlDays * DAY_MS;
    const ages = [0, ttl / 2, ttl - 1, ttl, ttl + 1, ttl * 2];

    for (const age of ages) {
      const updatedAt = new Date(now.getTime() - age);
      const expiresAt = pendingReferralExpiresAt(row('pending', updatedAt));

      expect(expiresAt, `age ${age}ms`).not.toBeNull();
      expect(
        !!expiresAt && expiresAt < now,
        `field says expired at age ${age}ms (cutoff ${cutoff.toISOString()})`,
      ).toBe(updatedAt < cutoff);
    }
  });

  it('reads the TTL per call, so a config change moves the field and the sweep together', async () => {
    const original = config.referrals.pendingTtlDays;
    const now = new Date('2026-11-20T12:00:00.000Z');
    const updatedAt = new Date(now.getTime() - 5 * DAY_MS);
    vi.mocked(referralsRepo.expireStalePendingReferrals).mockResolvedValue({ count: 0 } as never);

    try {
      const before = pendingReferralExpiresAt(row('pending', updatedAt));
      await expireStaleReferrals(now);
      const cutoffBefore = await lastSweepCutoff();

      (config.referrals as { pendingTtlDays: number }).pendingTtlDays = 3;

      const after = pendingReferralExpiresAt(row('pending', updatedAt));
      await expireStaleReferrals(now);
      const cutoffAfter = await lastSweepCutoff();

      // Shorter TTL: the deadline moved earlier, and so did the cutoff — and
      // the referral that was safe before is now past its deadline.
      expect(after!.getTime()).toBeLessThan(before!.getTime());
      expect(cutoffAfter.getTime()).toBeGreaterThan(cutoffBefore.getTime());
      expect(before! < now).toBe(false);
      expect(after! < now).toBe(true);
      expect(updatedAt < cutoffAfter).toBe(true);
    } finally {
      (config.referrals as { pendingTtlDays: number }).pendingTtlDays = original;
    }
  });
});
