import { z } from 'zod';

export const setVerificationStatusSchema = z.object({
  status: z.enum(['pending', 'verified', 'rejected']),
});
