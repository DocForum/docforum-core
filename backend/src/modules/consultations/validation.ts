import { z } from 'zod';

export const closeConsultationSchema = z.object({
  outcome: z.enum(['resolved', 'referred', 'follow_up_needed']),
  notes: z.string().min(1).max(20000),
});
