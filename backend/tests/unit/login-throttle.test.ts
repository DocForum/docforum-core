import { describe, expect, it } from 'vitest';
import {
  backoffDelaySeconds,
  emailThrottleKey,
  evaluateBucket,
  evaluateBuckets,
  normalizeClientIp,
  type ThrottleBucket,
  type ThrottlePolicy,
} from '../../src/modules/auth/services/login-throttle';

const policy: ThrottlePolicy = {
  windowSeconds: 900,
  backoffAfterFailures: 3,
  backoffBaseSeconds: 2,
  backoffMaxSeconds: 30,
  lockAfterFailures: 5,
  lockSeconds: 60,
};

function bucket(overrides: Partial<ThrottleBucket> = {}): ThrottleBucket {
  return {
    scope: 'email',
    key: 'doc@example.com',
    failedCount: 0,
    lastFailedAt: new Date('2026-10-15T12:00:00.000Z'),
    lockUntil: null,
    ...overrides,
  };
}

describe('login throttle policy (issue #35)', () => {
  it('applies no backoff below the threshold', () => {
    expect(backoffDelaySeconds(0, policy)).toBe(0);
    expect(backoffDelaySeconds(2, policy)).toBe(0);
  });

  it('grows the delay exponentially and caps it', () => {
    expect(backoffDelaySeconds(3, policy)).toBe(2); // 2 * 2^0
    expect(backoffDelaySeconds(4, policy)).toBe(4); // 2 * 2^1
    expect(backoffDelaySeconds(5, policy)).toBe(8); // 2 * 2^2
    expect(backoffDelaySeconds(50, policy)).toBe(30); // capped at max
  });

  it('is not blocked before any failure', () => {
    expect(evaluateBucket(bucket(), new Date('2026-10-15T12:00:00.000Z'), policy)).toMatchObject({
      blocked: false,
      reason: null,
    });
  });

  it('blocks inside the backoff window and lets the attempt through once it lapses', () => {
    const attempted = bucket({ failedCount: 3, lastFailedAt: new Date('2026-10-15T12:00:00.000Z') });

    const during = evaluateBucket(attempted, new Date('2026-10-15T12:00:00.500Z'), policy);
    expect(during.blocked).toBe(true);
    expect(during.reason).toBe('backoff');
    // base 2s at the threshold failure, rounded up from the 1.5s remaining.
    expect(during.retryAfterSeconds).toBe(2);

    const after = evaluateBucket(attempted, new Date('2026-10-15T12:00:05.000Z'), policy);
    expect(after.blocked).toBe(false);
  });

  it('reports a lock with the exact remaining seconds', () => {
    const locked = bucket({ failedCount: 5, lockUntil: new Date('2026-10-15T12:00:30.000Z') });
    const decision = evaluateBucket(locked, new Date('2026-10-15T12:00:00.000Z'), policy);
    expect(decision).toEqual({ blocked: true, retryAfterSeconds: 30, reason: 'locked' });

    // An expired lock is not a lock.
    expect(evaluateBucket(locked, new Date('2026-10-15T12:00:31.000Z'), policy).blocked).toBe(false);
  });

  it('takes the strictest bucket and prefers a lock over a backoff on a tie', () => {
    const emailBucket = bucket({ scope: 'email', failedCount: 3, lastFailedAt: new Date('2026-10-15T12:00:00.000Z') });
    const ipBucket = bucket({
      scope: 'ip',
      key: '203.0.113.7',
      failedCount: 5,
      lockUntil: new Date('2026-10-15T12:00:45.000Z'),
    });

    const decision = evaluateBuckets([emailBucket, ipBucket], new Date('2026-10-15T12:00:00.000Z'), policy);
    expect(decision).toEqual({ blocked: true, retryAfterSeconds: 45, reason: 'locked' });
  });

  it('normalises the email bucket key without touching account lookup semantics', () => {
    expect(emailThrottleKey('  Doc@Example.COM ')).toBe('doc@example.com');
    expect(emailThrottleKey('doc@example.com')).toBe('doc@example.com');
  });

  it('collapses IPv6-mapped IPv4 addresses so one client keeps one bucket', () => {
    expect(normalizeClientIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientIp('2001:DB8::1')).toBe('2001:db8::1');
    expect(normalizeClientIp(undefined)).toBeNull();
    expect(normalizeClientIp('   ')).toBeNull();
  });
});
