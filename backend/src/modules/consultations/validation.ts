import { z } from 'zod';
import { referralTargetSchema } from '../referrals/validation';

export const createConsultationSchema = z.object({
  appointmentId: z.string().min(1),
  outcome: z.enum(['resolved', 'referred', 'follow_up_needed']).optional(),
  notes: z.string().trim().min(1).optional(),
});

export const createReferralsSchema = z.object({
  targets: z.array(referralTargetSchema).min(1),
});
