import { z } from 'zod';
import { referralTargetSchema } from '../referrals/validation';

const outcomeSchema = z.enum(['resolved', 'referred', 'follow_up_needed']);

export const createConsultationSchema = z.object({
  // One consultation per appointment (unique in the DB) — the appointment
  // is the record this note closes.
  appointmentId: z.string().min(1),
  notes: z.string().trim().min(1).optional(),
  outcome: outcomeSchema.optional(),
});

/** PATCH is a partial update, but an empty body is meaningless — require at
 * least one field so a no-op request is a 400 rather than silent success. */
export const updateConsultationSchema = z
  .object({
    notes: z.string().trim().min(1).optional(),
    outcome: outcomeSchema.optional(),
  })
  .refine((value) => value.notes !== undefined || value.outcome !== undefined, {
    message: 'Provide notes and/or outcome.',
  });

export const addAddendumSchema = z.object({
  body: z.string().trim().min(1),
});

// Issue #66: several referrals from one consultation, all-or-none.
export const createReferralsSchema = z.object({
  targets: z.array(referralTargetSchema).min(1),
});
