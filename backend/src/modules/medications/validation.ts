import { z } from 'zod';

export const medicationSearchSchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const medicationCreateSchema = z.object({
  genericName: z.string().trim().min(1).max(200),
  strength: z.string().trim().max(100).optional(),
  form: z.string().trim().max(100).optional(),
  route: z.string().trim().max(100).optional(),
  externalCode: z.string().trim().max(100).optional(),
  externalSystem: z.string().trim().max(50).optional(),
});

export const medicationListSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});