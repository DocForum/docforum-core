import { z } from 'zod';

export const symptomSchema = z.object({
  symptom: z.string().trim().min(1).max(200),
  duration: z.string().trim().min(1).max(100),
  severity: z.enum(['mild', 'moderate', 'severe']),
});

export const createIntakeSchema = z.object({
  symptoms: z.array(symptomSchema).min(1).max(50),
  freeTextNotes: z.string().trim().max(4000).optional(),
});
