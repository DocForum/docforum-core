// AuditEvent foundation (Phase 8, issue #43): the pure parts — metadata
// validation (no PHI/secrets), the keyset cursor, query validation, the
// transaction-only guard on record(), and the request-id middleware.
// Database-backed behaviour is in tests/integration/audit.test.mts.
import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  AuditMetadataError,
  SYSTEM_ACTOR,
  decodeAuditCursor,
  encodeAuditCursor,
  record,
  validateAuditMetadata,
} from '../../src/modules/audit/services';
import { listAuditEventsQuerySchema } from '../../src/modules/audit/validation';
import { requestId } from '../../src/middleware/request-id';

describe('validateAuditMetadata', () => {
  it('accepts a small flat map of ids and codes', () => {
    const metadata = { availabilitySlotId: 's1', doctorProfileId: 'd1', origin: 'direct_booking', amount: '100', escrowId: null, retried: false, attempt: 2 };
    expect(validateAuditMetadata(metadata)).toEqual(metadata);
    expect(validateAuditMetadata(undefined)).toBeUndefined();
  });

  it.each(['email', 'fullName', 'patientName', 'phone', 'dateOfBirth', 'dob', 'notes', 'intakeText', 'symptoms', 'password', 'secret', 'releaserSecret', 'refreshToken', 'apiKey', 'requestBody', 'payload'])(
    'refuses a key that could carry personal or secret data: %s',
    (key) => {
      expect(() => validateAuditMetadata({ [key]: 'x' })).toThrow(AuditMetadataError);
    },
  );

  it('refuses nested objects, arrays, long strings, non-finite numbers and too many keys', () => {
    expect(() => validateAuditMetadata({ nested: { a: 1 } } as never)).toThrow(AuditMetadataError);
    expect(() => validateAuditMetadata({ list: [1, 2] } as never)).toThrow(AuditMetadataError);
    expect(() => validateAuditMetadata({ reason: 'x'.repeat(201) })).toThrow(AuditMetadataError);
    expect(() => validateAuditMetadata({ n: Number.NaN })).toThrow(AuditMetadataError);
    expect(() => validateAuditMetadata(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])))).toThrow(AuditMetadataError);
    expect(() => validateAuditMetadata({ 'bad key': 1 })).toThrow(AuditMetadataError);
  });
});

describe('record()', () => {
  it('refuses the root client — it must run inside the transaction of the change', async () => {
    // A real root client (Prisma 7) exposes its lifecycle methods; that —
    // not `$transaction`, which v7's transaction client also has — is what
    // the guard keys on. See the doc comment on record().
    const rootLike = {
      $transaction: () => undefined,
      $connect: () => undefined,
      $disconnect: () => undefined,
      auditEvent: { create: () => undefined },
    } as unknown as Prisma.TransactionClient;
    await expect(
      record(rootLike, SYSTEM_ACTOR, { entityType: 'Appointment', entityId: 'a', action: 'appointment.booked', fromState: null, toState: 'scheduled' }),
    ).rejects.toThrow(/inside the transaction/);
  });

  it('accepts a Prisma 7 transaction client even though it carries $transaction', async () => {
    // Regression: since prisma@7 the interactive-transaction client has a
    // $transaction method identical to the root client's (issue #47's
    // upgrade). Guarding on it refused every legitimate call and aborted
    // the surrounding change; this shape must be accepted and must write.
    let wrote = false;
    const v7TransactionClient = {
      $transaction: () => undefined,
      auditEvent: { create: async () => { wrote = true; } },
    } as unknown as Prisma.TransactionClient;
    await record(v7TransactionClient, SYSTEM_ACTOR, { entityType: 'Appointment', entityId: 'a', action: 'appointment.booked', fromState: null, toState: 'scheduled' });
    expect(wrote).toBe(true);
  });

  it('refuses a malformed action name before writing anything', async () => {
    let wrote = false;
    const tx = { auditEvent: { create: async () => { wrote = true; } } } as unknown as Prisma.TransactionClient;
    await expect(
      record(tx, SYSTEM_ACTOR, { entityType: 'Appointment', entityId: 'a', action: 'Booked!', fromState: null, toState: null }),
    ).rejects.toThrow(/Invalid audit action/);
    expect(wrote).toBe(false);
  });
});

describe('audit cursor', () => {
  it('round-trips (createdAt, id) and rejects garbage', () => {
    const position = { createdAt: new Date('2026-10-17T10:00:00.123Z'), id: 'abc-123' };
    expect(decodeAuditCursor(encodeAuditCursor(position))).toEqual(position);
    for (const bad of ['', 'not-base64-!!', Buffer.from('nodate|id').toString('base64url'), Buffer.from('2026-10-17T10:00:00Z|').toString('base64url')]) {
      expect(() => decodeAuditCursor(bad)).toThrow(/Invalid cursor/);
    }
  });
});

describe('listAuditEventsQuerySchema', () => {
  it('defaults the limit and coerces it from the query string', () => {
    expect(listAuditEventsQuerySchema.parse({}).limit).toBe(50);
    expect(listAuditEventsQuerySchema.parse({ limit: '10' }).limit).toBe(10);
  });

  it('bounds the page size', () => {
    expect(listAuditEventsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listAuditEventsQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });

  it('rejects unknown parameters, bad dates and entityId without entityType', () => {
    expect(listAuditEventsQuerySchema.safeParse({ patientEmail: 'x' }).success).toBe(false);
    expect(listAuditEventsQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false);
    expect(listAuditEventsQuerySchema.safeParse({ entityId: 'a1' }).success).toBe(false);
    expect(listAuditEventsQuerySchema.parse({ from: '2026-10-01', to: '2026-10-17T12:00:00Z' }).to).toEqual(new Date('2026-10-17T12:00:00Z'));
  });
});

describe('requestId middleware', () => {
  function run(inbound?: string) {
    const headers: Record<string, string> = {};
    const req = { get: (name: string) => (name.toLowerCase() === 'x-request-id' ? inbound : undefined) } as never as { requestId?: string; get(n: string): string | undefined };
    const res = { set: (name: string, value: string) => { headers[name] = value; } };
    let called = false;
    requestId(req as never, res as never, () => { called = true; });
    return { id: req.requestId!, header: headers['X-Request-Id'], called };
  }

  it('keeps a well-formed inbound id and echoes it', () => {
    expect(run('render-abc12345')).toEqual({ id: 'render-abc12345', header: 'render-abc12345', called: true });
  });

  it('replaces a missing, short, oversized or unsafe id with a fresh UUID', () => {
    for (const inbound of [undefined, 'short', 'x'.repeat(129), 'has spaces in it', '<script>alert(1)</script>']) {
      const { id, header } = run(inbound);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(header).toBe(id);
    }
  });
});
