import { z } from 'zod';

export const bookSlotSchema = z.object({
  availabilitySlotId: z.string().min(1),
});

export const updateStatusSchema = z.object({
  status: z.enum(['completed', 'cancelled', 'no_show']),
});
