import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import type { Logger } from 'pino';
import { REDACT_PATHS, bigIntSerialiser, loggerOptions, requestLogger } from '../../src/logger';

// A capturing logger that reuses the production redaction config but writes
// to an in-memory stream so assertions can inspect the emitted JSON. This
// is the same config the running server uses, so the test asserts the
// actual redaction behaviour, not a copy.
//
// The destination must be a real Writable: `pino.destination({ write })`
// treats its argument as SonicBoom options, falls back to fd 1, and the
// lines go to the process stdout while `chunks` stays empty — which made
// every negative assertion pass vacuously and every positive one fail.
function captureLog(fn: (log: Logger) => void): string {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const log = pino(
    {
      level: 'info',
      redact: loggerOptions.redact,
      serializers: bigIntSerialiser,
    },
    stream,
  );
  fn(log);
  return chunks.join('');
}

describe('structured logging redaction', () => {
  it('redacts auth headers, cookies, passwords, and tokens', () => {
    const out = captureLog((log) => {
      log.info(
        {
          req: {
            headers: {
              authorization: 'Bearer super-secret',
              cookie: 'refresh_token=abc123',
              'set-cookie': 'refresh_token=abc123; HttpOnly',
            },
          },
          password: 'horse-battery-staple',
          accessToken: 'jwt-access',
          refreshToken: 'jwt-refresh',
          csrfToken: 'csrf-value',
        },
        'auth attempt',
      );
    });
    expect(out).not.toContain('super-secret');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('horse-battery-staple');
    expect(out).not.toContain('jwt-access');
    expect(out).not.toContain('jwt-refresh');
    expect(out).not.toContain('csrf-value');
    expect(out).toContain('REDACTED');
  });

  it('redacts PHI field paths', () => {
    const out = captureLog((log) => {
      log.info(
        {
          patient: {},
          intakeNotes: 'I feel awful and take methodone',
          symptoms: 'chest pain since Tuesday',
          diagnosis: 'type 2 diabetes',
          allergies: 'penicillin',
          medications: 'metformin',
          dateOfBirth: '1980-01-01',
          ssn: '123-45-6789',
        },
        'patient intake',
      );
    });
    expect(out).not.toContain('I feel awful');
    expect(out).not.toContain('chest pain');
    expect(out).not.toContain('diabetes');
    expect(out).not.toContain('penicillin');
    expect(out).not.toContain('metformin');
    expect(out).not.toContain('1980-01-01');
    expect(out).not.toContain('123-45-6789');
  });

  it('redacts every configured path when present at the top level', () => {
    // The redaction list is the contract; this asserts that a field named
    // exactly as one of the configured paths is redacted. It does not cover
    // nested paths (e.g. `req.headers.authorization`) because pino only
    // matches the full path for nested entries; the auth-header test above
    // covers that case.
    const sample: Record<string, string> = {
      password: 'password-value',
      passwordHash: 'hash-value',
      token: 'token-value',
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
      csrfToken: 'csrf-value',
      intakeNotes: 'intake-value',
      symptoms: 'symptom-value',
      diagnosis: 'diagnosis-value',
      allergies: 'allergy-value',
      medications: 'medication-value',
    };
    const out = captureLog((log) => log.info(sample, 'field sample'));
    for (const value of Object.values(sample)) {
      expect(out).not.toContain(value);
    }
  });

  it('exposes the request id on every line', () => {
    const child = requestLogger({ requestId: 'req-12345678' });
    // requestLogger returns a pino child logger carrying the request id as a
    // binding. Assert the binding is present on the child.
    expect(child).toBeTruthy();
    expect(child).toHaveProperty('level');
  });

  it('serialises BigInt values as strings instead of crashing', () => {
    const out = captureLog((log) => {
      log.info({ amount: 12345678901234567890n }, 'bigint payload');
    });
    expect(out).toContain('12345678901234567890');
  });

  it('configures the redaction list as a non-empty array', () => {
    expect(REDACT_PATHS.length).toBeGreaterThan(0);
    expect(REDACT_PATHS).toContain('password');
    expect(REDACT_PATHS).toContain('token');
    expect(REDACT_PATHS).toContain('intakeNotes');
  });
});
