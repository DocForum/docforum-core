import { z } from 'zod';

// A target is either a named doctor or a specialty (issue #6, ADR 0008).
// Specialty-only targets are routed to a concrete doctor at creation —
// the resolved doctor is always what gets stored, so nothing here creates
// an unassigned referral. Both absent is a validation error rather than a
// silent default; naming a doctor is never overridden by routing.
export const referralTargetSchema = z
  .object({
    targetDoctorId: z.string().min(1).optional(),
    targetSpecialtyId: z.string().min(1).optional(),
    snapshotNotes: z.string().trim().min(1),
  })
  .refine((target) => !!target.targetDoctorId || !!target.targetSpecialtyId, {
    message: 'A referral target needs a targetDoctorId or a targetSpecialtyId.',
    path: ['targetDoctorId'],
  });

export const createReferralSchema = referralTargetSchema.extend({
  sourceConsultationId: z.string().min(1),
});

export const createReferralBatchSchema = z.object({
  targets: z.array(referralTargetSchema).min(1),
});

export const acceptReferralSchema = z.object({
  availabilitySlotId: z.string().min(1),
});

// The reason travels into the audit trail as a metadata value, and the
// audit module caps metadata strings at 200 characters (ARCHITECTURE.md
// §4.10). Bound it here so an over-long reason is a 400, not a failed
// transaction in the middle of an admin action.
export const adminReassignSchema = z.object({
  targetDoctorId: z.string().min(1),
  reason: z.string().trim().min(1).max(200),
});

export const adminCancelSchema = z.object({
  reason: z.string().trim().min(1).max(200),
});

export const adminQueueQuerySchema = z.object({
  status: z.enum(['pending', 'waiting_for_specialist', 'accepted', 'declined', 'completed', 'expired', 'cancelled']).optional(),
  olderThan: z.string().regex(/^\d+[hd]$/).optional(),
  loopFlagged: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
