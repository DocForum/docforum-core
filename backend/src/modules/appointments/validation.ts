import { z } from 'zod';

export const bookSlotSchema = z.object({
  availabilitySlotId: z.string().min(1),
});
