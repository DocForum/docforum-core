import { z } from 'zod';

export const setVerificationStatusSchema = z.object({
  status: z.enum(['pending', 'verified', 'rejected']),
});

export const setMySpecialtiesSchema = z.object({
  specialtyIds: z.array(z.string().uuid()).max(30).transform((ids) => [...new Set(ids)]),
}).strict();

export const publicDoctorListQuerySchema = z.object({
  specialty: z.string().trim().min(1).max(100).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().uuid().optional(),
}).strict();
