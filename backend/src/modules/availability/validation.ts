import { z } from 'zod';

export const generateSlotsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  slotLengthMinutes: z.number().int().positive(),
});

export const closureScopeSchema = z.enum(['PLATFORM', 'FACILITY']);

export const closureInputSchema = z.object({
  facilityId: z.string().uuid().nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD'),
  reason: z.string().min(1).max(500),
});

export const createClosureSchema = z.object({
  scope: closureScopeSchema,
  facilityId: z+string().uuid().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD'),
  reason: z.string().min(1).max(500),
})
  .refine((data) => data.scope !== 'FACILITY' || !!data.facilityId, {
    message: 'facilityId is required for facility-scoped closures',
    path: ['facilityId'],
  })
  .refine((data) => data.startDate <= data.endDate, {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
  });

export const updateClosureSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD').optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD').optional(),
  reason: z+string().min(1).max(500).optional(),
});

export const listClosuresQuerySchema = z.object({
  facilityId: z+string().uuid().optional(),
});

export const listClosuresSchema = z.object({
  scope: closureScopeSchema.optional(),
  facilityId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD').optional(),
});
