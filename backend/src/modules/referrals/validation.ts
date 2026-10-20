import { z } from 'zod';

export const referralTargetSchema = z.object({
  // v1 requires a concrete target doctor — the routing rule for "a
  // specialty, no specific doctor" is an unresolved design gap
  // (ARCHITECTURE.md §6.1.2, issue #6), not silently defaulted here.
  targetDoctorId: z.string().min(1),
  targetSpecialtyId: z.string().min(1).optional(),
  snapshotNotes: z.string().trim().min(1),
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
  status: z.enum(['pending', 'accepted', 'declined', 'completed', 'expired', 'cancelled']).optional(),
  olderThan: z.string().regex(/^\d+[hd]$/).optional(),
  loopFlagged: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
