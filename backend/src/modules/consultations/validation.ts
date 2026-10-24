import { z } from 'zod';
import { referralTargetSchema } from '../referrals/validation';

/** Close route: the outcome is the point of closing, so it is required, and
 * notes are the clinical record itself (empty notes are not a record). */
export const closeConsultationSchema = z.object({
  outcome: z.enum(['resolved', 'referred', 'follow_up_needed']),
  notes: z.string().min(1).max(20000),
});

/** Create route (Phase 3's slice): the same row, addressable before sign-off. */
export const createConsultationSchema = z.object({
  appointmentId: z.string().min(1),
  outcome: z.enum(['resolved', 'referred', 'follow_up_needed']).optional(),
  notes: z.string().trim().min(1).optional(),
  targetSpecialtyId: z.string().min(1).optional(),
  targetDoctorId: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.outcome === 'referred' && !value.targetSpecialtyId) {
    ctx.addIssue({ code: 'custom', path: ['targetSpecialtyId'], message: 'Required when outcome is referred.' });
  }
  if (value.outcome !== 'referred' && (value.targetSpecialtyId || value.targetDoctorId)) {
    ctx.addIssue({ code: 'custom', path: ['targetSpecialtyId'], message: 'Referral target is only valid for a referred consultation.' });
  }
});

export const createReferralsSchema = z.object({
  targets: z.array(referralTargetSchema).min(1),
});
