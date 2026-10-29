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

export const rescheduleSlotSchema = z.object({
  newSlotId: z.string().min(1),
});

// Schema for reschedule request body
export const rescheduleSlotBodySchema = z.object({
  newSlotId: z.string().min(1),
});

// Schema for cancellation request body
export const cancelAppointmentSchema = z.object({
  reason: z.enum(['patient', 'doctor']).optional(),
});

// Schema for joining the waitlist
export const waitlistJoinSchema = z.object({
  doctorProfileId: z.string().optional(),
  specialtyId: z.string().optional(),
  earliestAcceptable: z.string().datetime(),
  latestAcceptable: z.string().datetime(),
  holdDurationMinutes: z.number().int().positive().optional(),
});

// Schema for leaving the waitlist
export const leaveWaitlistSchema = z.object({
  entryId: z.string().optional(),
});

// Schema for accepting a waitlist offer
export const acceptWaitlistSchema = z.object({
  entryId: z.string(),
});

export const updateStatusSchema = z.object({
  status: z.enum(['completed', 'cancelled', 'no_show']),
});
