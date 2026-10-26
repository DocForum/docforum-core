import { z } from 'zod';

// Phase 8, issue #41 — `DELETE /patients/me` re-confirms the password.
export const deleteAccountSchema = z.object({
  password: z.string().min(1, 'password is required to delete your account.'),
});

// Phase 8, issue #42 (docs/adr/0011). `.strict()` on purpose: a body that
// tries to name an existing profile or user (`patientProfileId`, `userId`,
// ...) is rejected outright — dependents are create-only, never linked.
export const createDependentSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'dateOfBirth must be YYYY-MM-DD')
      .transform((value, ctx) => {
        const date = new Date(`${value}T00:00:00.000Z`);
        // Rejects impossible dates like 2020-02-30 (Date would roll them over).
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
          ctx.addIssue({ code: 'custom', message: 'dateOfBirth must be a real calendar date.' });
          return z.NEVER;
        }
        return date;
      }),
  })
  .strict();
