// Issue #115: machine-readable error codes. The catalogue is the single
// source of truth for both the code list and each code's HTTP status; the
// handler always answers `{ code, message, details? }`.
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ERROR_CATALOGUE, ERROR_GROUPS } from '../../src/error-catalogue';
import { HttpError } from '../../src/http-error';
import { errorHandler } from '../../src/middleware/error-handler';

function run(err: unknown) {
  const log = { warn: vi.fn(), error: vi.fn() };
  const req = { headers: {}, log } as unknown as Request;
  const res = { status: vi.fn(), json: vi.fn(), headersSent: false };
  res.status.mockReturnValue(res);
  errorHandler(err, req, res as unknown as Response, vi.fn());
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0], log };
}

describe('error catalogue', () => {
  it('has a well-formed definition for every code', () => {
    for (const [code, definition] of Object.entries(ERROR_CATALOGUE)) {
      expect(code, code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(definition.status, code).toBeGreaterThanOrEqual(400);
      expect(definition.status, code).toBeLessThanOrEqual(599);
      expect(ERROR_GROUPS, code).toContain(definition.module);
      expect(definition.message.length, code).toBeGreaterThan(0);
      expect(definition.meaning.length, code).toBeGreaterThan(0);
      expect(definition.guidance.length, code).toBeGreaterThan(0);
    }
  });

  it('lists every module group, and every group used has a title order', () => {
    const used = new Set(Object.values(ERROR_CATALOGUE).map((definition) => definition.module));
    for (const module of used) expect(ERROR_GROUPS, module).toContain(module);
  });
});

describe('HttpError', () => {
  it('derives the status from the code and defaults the message', () => {
    const err = new HttpError('SLOT_TAKEN');
    expect(err.code).toBe('SLOT_TAKEN');
    expect(err.status).toBe(409);
    expect(err.message).toBe(ERROR_CATALOGUE.SLOT_TAKEN.message);
  });

  it('keeps a custom message and structured details', () => {
    const err = new HttpError('SLOT_TAKEN', 'That slot went to someone else.', { slotId: 'abc' });
    expect(err.message).toBe('That slot went to someone else.');
    expect(err.details).toEqual({ slotId: 'abc' });
  });
});

describe('coded error envelope', () => {
  it('always includes the code and omits details when there are none', () => {
    const { status, body } = run(new HttpError('EMAIL_NOT_VERIFIED'));
    expect(status).toBe(403);
    expect(body).toEqual({ code: 'EMAIL_NOT_VERIFIED', message: ERROR_CATALOGUE.EMAIL_NOT_VERIFIED.message });
    expect(Object.keys(body)).toHaveLength(2);
  });

  it('includes details when the thrower supplied them', () => {
    const { body } = run(new HttpError('CONFLICT', 'Conflicting state.', { version: 4 }));
    expect(body).toEqual({ code: 'CONFLICT', message: 'Conflicting state.', details: { version: 4 } });
  });

  it('maps a Zod failure to one VALIDATION_FAILED code with field details', () => {
    const schema = z.object({ email: z.string().email(), password: z.string().min(8) });
    const parsed = schema.safeParse({ email: 'not-an-email', password: 'short' });
    expect(parsed.success).toBe(false);

    const { status, body } = run(parsed.error);
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.details.fields)).toBe(true);
    expect(body.details.fields.map((field: { path: string }) => field.path)).toEqual(['email', 'password']);
    for (const field of body.details.fields) {
      expect(field.code).toBeTruthy();
      expect(field.message).toBeTruthy();
    }
  });

  it('keeps a catalogue code from a schema refinement at the top level and in details.fields', () => {
    const schema = z.object({
      password: z.string().superRefine((_value, ctx) => {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Password is too short.',
          params: { code: 'PASSWORD_TOO_SHORT' },
        });
      }),
    });
    const parsed = schema.safeParse({ password: 'x' });
    expect(parsed.success).toBe(false);

    const { status, body } = run(parsed.error);
    // Backwards compatible with the pre-catalogue envelope: clients branch on
    // the top-level PASSWORD_TOO_SHORT.
    expect(status).toBe(400);
    expect(body.code).toBe('PASSWORD_TOO_SHORT');
    expect(body.details.fields).toEqual([
      { path: 'password', code: 'PASSWORD_TOO_SHORT', message: 'Password is too short.' },
    ]);
  });

  it('answers INTERNAL for an unknown error without leaking its message or stack', () => {
    const { status, body } = run(new Error('database password is hunter2'));
    expect(status).toBe(500);
    expect(body).toEqual({ code: 'INTERNAL', message: 'Internal server error.' });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('keeps the body-parser codes and statuses', () => {
    const err = Object.assign(new Error('bad json'), { type: 'entity.parse.failed', status: 400 });
    const { status, body } = run(err);
    expect(status).toBe(400);
    expect(body).toEqual({ code: 'INVALID_JSON', message: 'The request body is not valid JSON.' });
  });
});
