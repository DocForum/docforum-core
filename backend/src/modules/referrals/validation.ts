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
  patientProfileId: z.string().uuid().optional(),
});

export const declineReferralSchema = z.object({
  patientProfileId: z.string().uuid().optional(),
  reason: z.object({
    enum: z.enum(['cost', 'distance', 'second_opinion', 'other']),
    note: z.string().trim().max(200).optional(),
  }).optional(),
});

/** GET /referrals/mine — issue #305: an active guardian lists a dependent's
 * referrals by naming the dependent. Authorised in the service. */
export const listMineQuerySchema = z.object({
  patientProfileId: z.string().uuid().optional(),
});

export const referralDetailQuerySchema = z.object({
  patientProfileId: z.string().min(1).optional(),
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

export const withdrawReferralSchema = z.object({
  reason: z.string().trim().min(1).max(200),
});

const referralStatusSchema = z.enum(['pending', 'accepted', 'declined', 'completed', 'expired', 'cancelled']);

export const incomingReferralsQuerySchema = z
  .object({
    status: referralStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

export const adminQueueQuerySchema = z.object({
  status: referralStatusSchema.optional(),
  olderThan: z.string().regex(/^\d+[hd]$/).optional(),
  loopFlagged: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  targetSpecialtyId: z.string().optional(),
  targetDoctorId: z.string().optional(),
});
