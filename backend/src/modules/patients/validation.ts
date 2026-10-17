import { z } from 'zod';

// Phase 8, issue #41 — `DELETE /patients/me` re-confirms the password.
export const deleteAccountSchema = z.object({
  password: z.string().min(1, 'password is required to delete your account.'),
});
