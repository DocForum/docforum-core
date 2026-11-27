import { describe, expect, it } from 'vitest';
import { config } from '../../src/config';

// The keys `config` had when it was one object literal in config/index.ts.
// Each now comes from a file in src/config/sections/; add a key here when
// you add a section.
const KEYS = [
  'accessLog', 'accountPurge', 'adminInvites', 'appBaseUrl', 'appointments', 'auth', 'availability', 'consultations', 'cookie', 'corsOrigins',
  'databaseUrl', 'expirySweeps', 'featureFlags', 'fileScanning', 'http', 'idempotency', 'jwt', 'labResults', 'log', 'loginThrottle', 'notificationFanout',
  'notifications', 'objectStorage', 'orders', 'passwordReset', 'patientExport', 'patients', 'payments', 'port', 'rateLimit',
  'referrals', 'securityHeaders', 'sep10', 'sessions', 'tokenPrune', 'trustProxy', 'twoFactor', 'walletLink',
];

describe('config sections', () => {
  it('exposes every config key, and nothing else', () => {
    expect(Object.keys(config).sort()).toEqual([...KEYS].sort());
  });

  it('keeps defaults that depend on the environment', () => {
    expect(config.port).toBe(Number(process.env.PORT ?? 4000));
    expect(config.jwt.accessTtl).toBe('15m');
    expect(config.cookie.path).toBe('/');
    expect(config.objectStorage.driver).toBe('memory');
  });
});
