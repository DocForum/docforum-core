// Issue #334: Prisma known-request errors that are the client's fault map to
// 4xx with fixed messages; nothing from Prisma's message/meta reaches the
// response.
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { errorHandler, PRISMA_CLIENT_ERRORS } from '../../src/middleware/error-handler';

function run(err: unknown) {
  const log = { warn: vi.fn(), error: vi.fn() };
  const req = { headers: {}, log } as unknown as Request;
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  errorHandler(err, req, res as unknown as Response, vi.fn());
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0], log };
}

function prismaError(code: string, meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(
    `Invalid \`prisma.referral.create()\` invocation: constraint "Referral_targetSpecialtyId_fkey" on table "Referral" (code ${code})`,
    { code, clientVersion: 'test', meta },
  );
}

const LEAKS = /Referral|fkey|targetSpecialtyId|prisma|constraint|table|P20\d\d/i;

describe('errorHandler Prisma mapping', () => {
  it.each([
    ['P2002', 409, { target: ['email'], modelName: 'User' }],
    ['P2003', 422, { field_name: 'Referral_targetSpecialtyId_fkey (index)', modelName: 'Referral' }],
    ['P2025', 404, { cause: 'Record to update not found.', modelName: 'Referral' }],
  ])('maps %s to %i with a generic message', (code, status, meta) => {
    const { status: sent, body, log } = run(prismaError(code, meta));
    expect(sent).toBe(status);
    expect(body).toEqual({ message: PRISMA_CLIENT_ERRORS[code].message });
    expect(Object.keys(body)).toEqual(['message']);
    expect(JSON.stringify(body)).not.toMatch(LEAKS);
    // Client errors are warnings server-side, with the full error attached.
    expect(log.warn).toHaveBeenCalledWith({ err: expect.any(Prisma.PrismaClientKnownRequestError) }, expect.any(String));
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps every mapped message free of schema detail', () => {
    for (const mapping of Object.values(PRISMA_CLIENT_ERRORS)) {
      expect(mapping.status).toBeGreaterThanOrEqual(400);
      expect(mapping.status).toBeLessThan(500);
      expect(mapping.message).not.toMatch(LEAKS);
    }
  });

  it('still answers 500 for an unmapped Prisma code, without leaking it', () => {
    const { status, body, log } = run(prismaError('P2034', {}));
    expect(status).toBe(500);
    expect(body).toEqual({ message: 'Internal server error.' });
    expect(log.error).toHaveBeenCalled();
  });

  it('still answers 500 for an unknown Prisma request error', () => {
    const err = new Prisma.PrismaClientUnknownRequestError('violates RESTRICT setting of foreign key constraint "x"', { clientVersion: 'test' });
    const { status, body } = run(err);
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(LEAKS);
  });
});
