import { describe, expect, it } from 'vitest';
import {
  WebhookUrlError,
  assertWebhookUrl,
  isBlockedWebhookAddress,
  signWebhookPayload,
  verifyWebhookSignature,
  webhookRetryDelaySeconds,
} from '../../src/utils/webhook-security';

describe('assertWebhookUrl', () => {
  it('accepts an https URL with a public host', () => {
    expect(assertWebhookUrl('https://facility.example.com/hooks').hostname).toBe('facility.example.com');
  });

  it('rejects plain http', () => {
    expect(() => assertWebhookUrl('http://facility.example.com/hooks')).toThrow(WebhookUrlError);
  });

  it('rejects a URL with embedded credentials', () => {
    expect(() => assertWebhookUrl('https://user:pass@facility.example.com/')).toThrow(/credentials/);
  });

  it('rejects metadata and private IP literals', () => {
    expect(() => assertWebhookUrl('https://169.254.169.254/latest')).toThrow(/private or reserved/);
    expect(() => assertWebhookUrl('https://10.0.0.5/hook')).toThrow(/private or reserved/);
    expect(() => assertWebhookUrl('https://[::1]/hook')).toThrow(/private or reserved/);
  });

  it('rejects a malformed URL', () => {
    expect(() => assertWebhookUrl('not a url')).toThrow(WebhookUrlError);
  });
});

describe('isBlockedWebhookAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0'])(
    'blocks IPv4 %s',
    (address) => {
      expect(isBlockedWebhookAddress(address)).toBe(true);
    },
  );

  it('allows a public IPv4 address', () => {
    expect(isBlockedWebhookAddress('93.184.216.34')).toBe(false);
    expect(isBlockedWebhookAddress('172.32.0.1')).toBe(false);
  });

  it.each(['::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:10.0.0.1', '::ffff:169.254.169.254'])(
    'blocks IPv6 %s',
    (address) => {
      expect(isBlockedWebhookAddress(address)).toBe(true);
    },
  );

  it('fails closed on something that is not an IP literal', () => {
    expect(isBlockedWebhookAddress('not-an-ip')).toBe(true);
  });
});

describe('webhook signatures', () => {
  const secret = 'facility-secret';
  const body = '{"event":"order.assigned","orderId":"o-1"}';

  it('verifies a payload signed with the same secret and a fresh timestamp', () => {
    const header = signWebhookPayload(secret, body, 1_000_000);
    expect(verifyWebhookSignature(secret, body, header, 1_000_060)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const header = signWebhookPayload(secret, body, 1_000_000);
    expect(verifyWebhookSignature(secret, body.replace('o-1', 'o-2'), header, 1_000_000)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const header = signWebhookPayload(secret, body, 1_000_000);
    expect(verifyWebhookSignature('other-secret', body, header, 1_000_000)).toBe(false);
  });

  it('rejects a replay outside the tolerance window', () => {
    const header = signWebhookPayload(secret, body, 1_000_000);
    expect(verifyWebhookSignature(secret, body, header, 1_000_000 + 301)).toBe(false);
  });

  it('rejects a malformed header', () => {
    expect(verifyWebhookSignature(secret, body, 'garbage', 1_000_000)).toBe(false);
  });
});

describe('webhookRetryDelaySeconds', () => {
  it('doubles the delay per attempt from 30 seconds', () => {
    expect([1, 2, 3, 4].map(webhookRetryDelaySeconds)).toEqual([30, 60, 120, 240]);
  });

  it('caps the delay at six hours', () => {
    expect(webhookRetryDelaySeconds(50)).toBe(6 * 60 * 60);
  });
});
