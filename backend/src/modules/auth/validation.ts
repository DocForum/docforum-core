import { z } from 'zod';

export const signupSchema = z.object({
  role: z.enum(['patient', 'doctor']),
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().trim().min(1),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
