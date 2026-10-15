import { z } from 'zod';

const outcomeSchema = z.enum(['resolved', 'referred', 'follow_up_needed']);

export const createConsultationSchema = z.object({
  notes: z.string().trim().min(1).optional(),
  outcome: outcomeSchema.optional(),
});

/** PATCH is a partial update, but an empty body is meaningless — require at
 * least one field so a no-op request is a 400 rather than silent success. */
export const updateConsultationSchema = createConsultationSchema
  .partial()
  .refine((value) => value.notes !== undefined || value.outcome !== undefined, {
    message: 'Provide notes and/or outcome.',
  });

export const addAddendumSchema = z.object({
  body: z.string().trim().min(1),
});
