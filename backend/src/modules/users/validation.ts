import { z } from 'zod';

// Phase 8, issue #39. Deactivate/reactivate take no body — the target is the
// path parameter.
export const createAdminInviteSchema = z.object({
  email: z.string().email(),
});
