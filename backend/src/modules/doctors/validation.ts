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
  // Issue #60: a curated symptom slug resolves to weighted specialties. When
  // both are given, `symptom` takes precedence over `q` (the curated mapping
  // is the more specific request); `specialty` still narrows the result set.
  symptom: z.string().trim().min(1).max(100).optional(),
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

// --- Symptom -> specialty mapping (issue #60) ----------------------------

export const symptomAutocompleteQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

export const createSymptomSchema = z
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

export const updateSymptomSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isRetired: z.boolean().optional(),
  })
  .strict()
  .refine((data) => data.name !== undefined || data.isRetired !== undefined, {
    message: 'At least one field (name or isRetired) must be provided.',
  });

export const setSymptomSpecialtiesSchema = z
  .object({
    // PUT semantics: this is the complete mapping set. Weight is the mapping
    // strength, 1 (weak) .. 5 (strong) — the same range the migration's check
    // constraint enforces.
    mappings: z
      .array(
        z
          .object({
            specialtyId: z.string().uuid(),
            weight: z.number().int().min(1).max(5),
          })
          .strict(),
      )
      .max(30),
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
