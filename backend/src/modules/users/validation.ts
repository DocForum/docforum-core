import { z } from 'zod';

// Phase 8, issue #39. Deactivate/reactivate take no body — the target is the
// path parameter.
export const createAdminInviteSchema = z.object({
  email: z.string().email(),
});

// `GET /admin/invites` (issue #277). Strict: an unknown query parameter is a
// client bug worth surfacing, not something to ignore. `status` is required —
// there is no unpaged "all invites" mode, and a derived status is always one
// of the four below.
export const listAdminInvitesQuerySchema = z
  .object({
    status: z.enum(['pending', 'redeemed', 'expired', 'revoked']).default('pending'),
    cursor: z.string().min(1).max(512).optional(),
    // Bounded on purpose: no unpaged dump of invite addresses.
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

// `GET /admin/users` (issue #275). Read-only account directory.
// `state` is a single derived bucket; `emailPrefix` is a prefix match on the
// stored address (never a wildcard), and the matching index is
// `User_email_prefix_idx`.
export const listAdminUsersQuerySchema = z
  .object({
    role: z.enum(['patient', 'doctor', 'facility', 'admin']).optional(),
    state: z.enum(['active', 'deactivated', 'deleted']).optional(),
    emailPrefix: z.string().min(1).max(254).optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
