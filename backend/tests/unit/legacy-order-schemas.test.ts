// Zod schemas for the legacy order controllers (issue #317), the facility
// self-service update (issue #319) and the proof file checks (issue #316).
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/http-error';
import {
  createPharmacyOrderSchema,
  fulfillPharmacyOrderSchema,
  proofDownloadQuerySchema,
} from '../../src/modules/pharmacy-orders/validation';
import { createLabOrderSchema, fulfillLabOrderSchema } from '../../src/modules/lab-orders/validation';
import { listDisputesQuerySchema, resolveDisputeSchema } from '../../src/modules/orders/validation';
import { facilityUpdateSchema } from '../../src/modules/facilities/validation';
import { PROOF_CONTENT_TYPES, assertAcceptableProofFile } from '../../src/modules/pharmacy-orders/services/proof-files';
import { config } from '../../src/config';

const UUID = '7d6f3c5e-1b2a-4c3d-8e9f-0a1b2c3d4e5f';

describe('create order schemas (issue #317)', () => {
  it('require a uuid patientProfileId and bound details', () => {
    for (const schema of [createPharmacyOrderSchema, createLabOrderSchema]) {
      expect(schema.safeParse({ patientProfileId: UUID, details: '  x  ' }).data).toMatchObject({ details: 'x' });
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ patientProfileId: 'not-a-uuid' }).success).toBe(false);
      expect(schema.safeParse({ patientProfileId: UUID, details: 'x'.repeat(5001) }).success).toBe(false);
    }
    expect(createPharmacyOrderSchema.safeParse({ patientProfileId: UUID, prescribingDoctorId: 'nope' }).success).toBe(false);
    expect(createLabOrderSchema.safeParse({ patientProfileId: UUID, orderingDoctorId: 'nope' }).success).toBe(false);
  });
});

describe('fulfill schemas (issues #316, #317)', () => {
  for (const [name, schema] of [['pharmacy', fulfillPharmacyOrderSchema], ['lab', fulfillLabOrderSchema]] as const) {
    it(`${name}: trims the reference number and requires it`, () => {
      expect(schema.parse({ referenceNumber: ' REF-1 ', notes: ' ok ' })).toEqual({ referenceNumber: 'REF-1', notes: 'ok' });
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ referenceNumber: '   ' }).success).toBe(false);
      expect(schema.safeParse({ referenceNumber: 'x'.repeat(201) }).success).toBe(false);
    });
    it(`${name}: refuses any client-supplied attachment (URL or inline data)`, () => {
      expect(schema.safeParse({ referenceNumber: 'R', attachment: 'https://evil.example/x.pdf' }).success).toBe(false);
      expect(schema.safeParse({ referenceNumber: 'R', attachment: { url: 'https://evil.example' } }).success).toBe(false);
      expect(schema.safeParse({ referenceNumber: 'R', attachment: { data: 'JVBERi0=' } }).success).toBe(false);
    });
  }
});

describe('dispute schemas (issue #317)', () => {
  it('resolveDisputeSchema requires trimmed notes and outcome', () => {
    expect(resolveDisputeSchema.parse({ resolutionNotes: ' n ', outcome: ' refunded ' })).toEqual({ resolutionNotes: 'n', outcome: 'refunded' });
    expect(resolveDisputeSchema.safeParse({}).success).toBe(false);
    expect(resolveDisputeSchema.safeParse({ resolutionNotes: ' ', outcome: 'x' }).success).toBe(false);
    expect(resolveDisputeSchema.safeParse({ resolutionNotes: 'n', outcome: '' }).success).toBe(false);
  });
  it('listDisputesQuerySchema only accepts known statuses', () => {
    expect(listDisputesQuerySchema.parse({})).toEqual({});
    expect(listDisputesQuerySchema.parse({ status: 'pending' })).toEqual({ status: 'pending' });
    expect(listDisputesQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false);
  });
  it('proofDownloadQuerySchema takes an optional uuid patientProfileId', () => {
    expect(proofDownloadQuerySchema.parse({})).toEqual({});
    expect(proofDownloadQuerySchema.safeParse({ patientProfileId: 'x' }).success).toBe(false);
  });
});

describe('facilityUpdateSchema (issue #319)', () => {
  it('accepts partial updates and coordinates given together', () => {
    expect(facilityUpdateSchema.safeParse({ name: 'A' }).success).toBe(true);
    expect(facilityUpdateSchema.safeParse({ latitude: -90, longitude: 180 }).success).toBe(true);
    expect(facilityUpdateSchema.safeParse({ address: '1 Road', latitude: 6.5, longitude: 3.3 }).success).toBe(true);
  });
  it('rejects one coordinate alone, out-of-range points, unknown or admin-only fields and empty bodies', () => {
    for (const body of [
      {},
      { latitude: 1 },
      { longitude: 1 },
      { latitude: 90.0001, longitude: 0 },
      { latitude: 0, longitude: 180.5 },
      { latitude: '1', longitude: '1' },
      { type: 'lab' },
      { name: ' ' },
    ]) {
      expect(facilityUpdateSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('assertAcceptableProofFile (issue #316)', () => {
  const pdf = Buffer.from('%PDF-1.7\n');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

  function codeOf(fn: () => unknown): string | undefined {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      return (err as HttpError).code;
    }
    return undefined;
  }

  it('accepts the allowlisted types when the bytes match, ignoring parameters and case', () => {
    expect(PROOF_CONTENT_TYPES.sort()).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
    expect(assertAcceptableProofFile({ body: pdf, contentType: 'Application/PDF; charset=binary' }).contentType).toBe('application/pdf');
    expect(assertAcceptableProofFile({ body: png, contentType: 'image/png' }).body).toBe(png);
    expect(assertAcceptableProofFile({ body: jpeg, contentType: 'image/jpeg' }).contentType).toBe('image/jpeg');
  });

  it('rejects other types, empty bodies, mismatched bytes and oversize files', () => {
    expect(codeOf(() => assertAcceptableProofFile({ body: pdf, contentType: 'text/html' }))).toBe('PROOF_UNSUPPORTED_TYPE');
    expect(codeOf(() => assertAcceptableProofFile({ body: pdf, contentType: undefined }))).toBe('PROOF_UNSUPPORTED_TYPE');
    expect(codeOf(() => assertAcceptableProofFile({ body: Buffer.alloc(0), contentType: 'application/pdf' }))).toBe('PROOF_EMPTY');
    expect(codeOf(() => assertAcceptableProofFile({ body: { data: 'x' }, contentType: 'application/pdf' }))).toBe('PROOF_EMPTY');
    expect(codeOf(() => assertAcceptableProofFile({ body: png, contentType: 'application/pdf' }))).toBe('PROOF_CONTENT_MISMATCH');
    const huge = Buffer.concat([pdf, Buffer.alloc(config.orders.proofMaxBytes)]);
    expect(codeOf(() => assertAcceptableProofFile({ body: huge, contentType: 'application/pdf' }))).toBe('PROOF_TOO_LARGE');
  });
});
