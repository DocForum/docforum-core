import { z } from 'zod';

export const generateSlotsSchema = z.object({
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
	startHour: z.number().int().min(0).max(23),
	endHour: z.number().int().min(1).max(24),
	slotLengthMinutes: z.number().int().positive(),
});

export const closurePeriodScopeSchema = z.enum(['PLATFORM', 'FACILITY']);

export const createClosurePeriodSchema = z.object({
	scope: closurePeriodScopeSchema,
	facilityId: z.string().uuid().optional().nullable(),
	startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD'),
	endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD'),
	timeZone: z.string().min(1).optional(),
	reason: z.string().trim().min(1).max(500),
})
	.superRefine((data) => data.endDate >= data.startDate, {
		message: 'endDate must be on or after startDate',
		path: ['endDate'],
	})
	.superRefine((data) => (data.scope === 'PLATFORM' ? data.facilityId == null : data.facilityId != null), {
		message: 'facilityId is required for FACILITY scope and forbidden for PLATFORM scope',
		path: ['facilityId'],
	});

export const updateClosurePeriodSchema = createClosurePeriodSchema.partial();

export const listClosurePeriodsQuerySchema = z.object({
	facilityId: z.string().uuid().optional(),
	fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
	toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
	scope: closurePeriodScopeSchema.optional(),
});

export type GenerateSlotsInput = z.infer<typeof generateSlotsSchema>;
export type CreateClosurePeriodInput = z.infer<typeof createClosurePeriodSchema>;
export type UpdateClosurePeriodInput = z.infer<typeof updateClosurePeriodSchema>;
export type ListClosurePeriodsQuery = z.infer<typeof listClosurePeriodsQuerySchema>;
