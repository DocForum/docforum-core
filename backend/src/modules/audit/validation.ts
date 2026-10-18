import { z } from 'zod';

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()) && /^\d{4}-\d{2}-\d{2}/.test(value), {
    message: 'must be an ISO-8601 date or date-time',
  })
  .transform((value) => new Date(value));

// `GET /admin/audit-events` (Phase 8, issue #43). Strict: an unknown query
// parameter is a client bug worth surfacing, not something to ignore.
export const listAuditEventsQuerySchema = z
  .object({
    entityType: z.string().min(1).max(64).optional(),
    entityId: z.string().min(1).max(128).optional(),
    actorUserId: z.string().min(1).max(128).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    cursor: z.string().min(1).max(512).optional(),
    // Bounded on purpose: no unpaged dump of the audit trail.
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict()
  .refine((q) => !q.entityId || q.entityType, { message: 'entityId requires entityType' });
