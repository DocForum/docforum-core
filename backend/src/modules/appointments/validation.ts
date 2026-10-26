import { z } from 'zod';

export const bookSlotSchema = z.object({
  availabilitySlotId: z.string().min(1),
  // Phase 8, issue #42: book for a dependent the caller is guardian of.
  // Omitted (or the caller's own profile id) = book for yourself.
  patientProfileId: z.string().min(1).optional(),
});

// Phase 8, issue #42: `GET /appointments/mine?patientProfileId=` lists a
// dependent's appointments, authorised the same way as booking.
export const listMineQuerySchema = z.object({
  patientProfileId: z.string().min(1).optional(),
});

export const updateStatusSchema = z.object({
  status: z.enum(['completed', 'cancelled', 'no_show']),
});
