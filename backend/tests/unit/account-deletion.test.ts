// Account deletion (Phase 8, issue #41, docs/adr/0010): the pure helpers.
// Database behaviour is in tests/integration/account-deletion.test.mts.
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { tombstoneEmail } from '../../src/modules/auth/services';
import { isForeignKeyRefusal } from '../../src/modules/patients/services';
import { signupSchema } from '../../src/modules/auth/validation';

describe('tombstoneEmail', () => {
  it('is stable per user, unique across users, and on the reserved .invalid TLD', () => {
    const a = tombstoneEmail('11111111-1111-1111-1111-111111111111');
    expect(a).toBe(tombstoneEmail('11111111-1111-1111-1111-111111111111'));
    expect(a).not.toBe(tombstoneEmail('22222222-2222-2222-2222-222222222222'));
    expect(a.endsWith('@deleted.invalid')).toBe(true);
  });

  it('never collides with an address someone could sign up with in practice', () => {
    // It's syntactically an email (so the column's shape is unchanged) but
    // on a TLD that can't be registered or receive mail.
    const parsed = signupSchema.safeParse({
      role: 'patient',
      email: tombstoneEmail('11111111-1111-1111-1111-111111111111'),
      password: 'longenough',
      fullName: 'x',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('isForeignKeyRefusal', () => {
  it('recognises Postgres RESTRICT (23001), which Prisma reports as an unknown error', () => {
    const err = new Prisma.PrismaClientUnknownRequestError(
      'PostgresError { code: "23001", message: "update or delete on table \\"User\\" violates RESTRICT setting of foreign key constraint" }',
      { clientVersion: 'test' },
    );
    expect(isForeignKeyRefusal(err)).toBe(true);
  });

  it('recognises P2003 (NO ACTION / 23503)', () => {
    const err = new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' });
    expect(isForeignKeyRefusal(err)).toBe(true);
  });

  it('does not swallow unrelated errors', () => {
    expect(isForeignKeyRefusal(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }))).toBe(false);
    expect(isForeignKeyRefusal(new Prisma.PrismaClientUnknownRequestError('deadlock detected', { clientVersion: 'test' }))).toBe(false);
    expect(isForeignKeyRefusal(new Error('boom'))).toBe(false);
  });
});
