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
  availableBefore: z.coerce.date().optional(),
}).strict();

export const updateDoctorProfileSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
}).strict();

export const setDoctorSpecialtyVerificationSchema = z
  .object({
    status: z.enum(['pending', 'verified', 'rejected']),
    reviewer: z.string().optional(),
    rejectionReason: z.string().trim().max(200).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.status === 'rejected' && (!data.rejectionReason || data.rejectionReason.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Rejection reason is required when status is rejected.',
        path: ['rejectionReason'],
      });
    }
  });

export const verificationQueueQuerySchema = z
  .object({
    kind: z.enum(['profile', 'specialty']).optional(),
    specialty: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
  })
  .strict();

export const createSpecialtySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must consist of lowercase alphanumeric characters and hyphens')
      .optional(),
  })
  .strict();

export const updateSpecialtySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isRetired: z.boolean().optional(),
    slug: z.string().optional(),
  })
  .strict()
  .refine((data) => data.name !== undefined || data.isRetired !== undefined, {
    message: 'At least one field (name or isRetired) must be provided.',
  });
