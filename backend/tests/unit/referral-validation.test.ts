import { describe, expect, it } from 'vitest';
import {
  adminCancelSchema,
  adminQueueQuerySchema,
  adminReassignSchema,
  createReferralBatchSchema,
  createReferralSchema,
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
});

describe('appointment status schema', () => {
  it('allows only terminal transitions from the body', () => {
    expect(updateStatusSchema.parse({ status: 'no_show' })).toEqual({ status: 'no_show' });
    expect(() => updateStatusSchema.parse({ status: 'scheduled' })).toThrow();
  });
});
