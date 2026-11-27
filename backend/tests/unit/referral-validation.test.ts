import { describe, expect, it } from 'vitest';
import {
  adminCancelSchema,
  adminQueueQuerySchema,
  adminReassignSchema,
  createReferralBatchSchema,
  createReferralSchema,
  declineReferralSchema,
} from '../../src/modules/referrals/validation';
import { updateStatusSchema } from '../../src/modules/appointments/validation';

describe('referral validation schemas', () => {
  it('accepts a full referral create payload', () => {
    const parsed = createReferralSchema.parse({
      sourceConsultationId: 'c1',
      targetDoctorId: 'd1',
      targetSpecialtyId: 's1',
      snapshotNotes: '  trimmed  ',
    });
    expect(parsed.snapshotNotes).toBe('trimmed');
  });

  it('requires notes and rejects empty targets', () => {
    expect(() =>
      createReferralSchema.parse({ sourceConsultationId: 'c1', targetDoctorId: 'd1', snapshotNotes: ' ' }),
    ).toThrow();
    expect(() => createReferralBatchSchema.parse({ targets: [] })).toThrow();
  });

  it('accepts a specialty-only target (issue #6 routing) and rejects one with neither', () => {
    const specialtyOnly = createReferralSchema.parse({
      sourceConsultationId: 'c1',
      targetSpecialtyId: 's1',
      snapshotNotes: 'needs a cardiologist',
    });
    expect(specialtyOnly.targetDoctorId).toBeUndefined();
    expect(specialtyOnly.targetSpecialtyId).toBe('s1');

    // Neither a doctor nor a specialty is not a target — routing has
    // nothing to resolve against, so this must fail validation rather
    // than reach the service.
    expect(() =>
      createReferralSchema.parse({ sourceConsultationId: 'c1', snapshotNotes: 'notes' }),
    ).toThrow();
    expect(() => createReferralBatchSchema.parse({ targets: [{ snapshotNotes: 'notes' }] })).toThrow();
  });

  it('parses admin queue filters', () => {
    expect(adminQueueQuerySchema.parse({ status: 'pending', olderThan: '48h', loopFlagged: 'true' })).toEqual({
      status: 'pending',
      olderThan: '48h',
      loopFlagged: true,
    });
    expect(() => adminQueueQuerySchema.parse({ olderThan: '48hours' })).toThrow();
  });

  it('requires a reason for reassign and cancel', () => {
    expect(() => adminReassignSchema.parse({ targetDoctorId: 'd1', reason: ' ' })).toThrow();
    expect(() => adminCancelSchema.parse({ reason: '' })).toThrow();
    expect(adminCancelSchema.parse({ reason: 'why' })).toEqual({ reason: 'why' });
  });

  it('accepts an empty decline body and an optional decline reason (issue #309)', () => {
    // Backwards compatible: no body at all is valid.
    expect(declineReferralSchema.parse({})).toEqual({});
    expect(declineReferralSchema.parse({ patientProfileId: '00000000-0000-4000-8000-000000000000' })).toEqual({
      patientProfileId: '00000000-0000-4000-8000-000000000000',
    });

    expect(declineReferralSchema.parse({ reason: { enum: 'cost' } })).toEqual({ reason: { enum: 'cost' } });
    expect(declineReferralSchema.parse({ reason: { enum: 'other', note: '  explanation  ' } })).toEqual({
      reason: { enum: 'other', note: 'explanation' },
    });
  });

  it('rejects an invalid decline enum, a missing enum and an over-long note', () => {
    expect(() => declineReferralSchema.parse({ reason: { enum: 'too_expensive' } })).toThrow();
    expect(() => declineReferralSchema.parse({ reason: { note: 'no enum' } })).toThrow();
    expect(() => declineReferralSchema.parse({ reason: { enum: 'cost', note: 'x'.repeat(201) } })).toThrow();
  });
});

describe('appointment status schema', () => {
  it('allows only terminal transitions from the body', () => {
    expect(updateStatusSchema.parse({ status: 'no_show' })).toEqual({ status: 'no_show' });
    expect(() => updateStatusSchema.parse({ status: 'scheduled' })).toThrow();
  });
});
