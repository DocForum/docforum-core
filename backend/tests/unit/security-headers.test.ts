// Issue #332: baseline security headers; HSTS only when enabled (production).
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { securityHeaders } from '../../src/middleware/security-headers';

function headersFor(options: Parameters<typeof securityHeaders>[0]) {
  const headers: Record<string, string> = {};
  const res = { setHeader: (name: string, value: string) => void (headers[name.toLowerCase()] = value) };
  const next = vi.fn();
  securityHeaders(options)({} as Request, res as unknown as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return headers;
}

describe('securityHeaders', () => {
  it('sets the baseline headers', () => {
    expect(headersFor({ hsts: false })).toEqual({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
    });
  });

  it('omits HSTS when disabled (local development over http)', () => {
    expect(headersFor({ hsts: false })).not.toHaveProperty('strict-transport-security');
  });

  it('sends HSTS when enabled (production)', () => {
    expect(headersFor({ hsts: true })['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(headersFor({ hsts: true, hstsMaxAgeSeconds: 60 })['strict-transport-security']).toBe('max-age=60; includeSubDomains');
  });
});

describe('config.securityHeaders', () => {
  it('enables HSTS only when NODE_ENV is production', async () => {
    const original = process.env.NODE_ENV;
    try {
      for (const [env, expected] of [['production', true], ['development', false], ['test', false]] as const) {
        process.env.NODE_ENV = env;
        vi.resetModules();
        const { securityHeaders: section } = await import('../../src/config/sections/securityHeaders.js');
        expect(section.hsts).toBe(expected);
      }
    } finally {
      process.env.NODE_ENV = original;
      vi.resetModules();
    }
  });
});
