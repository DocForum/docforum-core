import { z } from 'zod';

export const labTestSearchSchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const labTestCreateSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  specimenType: z.string().trim().max(100).optional(),
  category: z.string().trim().max(100).optional(),
  panelOfIds: z.array(z.string().uuid()).optional(),
});

export const labTestListSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});