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

// Shared page bound for the access-log queries — no unpaged dump of the
// read trail, same reasoning as listAuditEventsQuerySchema's `limit`.
const accessLogLimit = z.coerce.number().int().min(1).max(200).default(50);

// `GET /admin/access-logs` (Phase 8, issue #45). Strict: unknown query
// parameters are client bugs worth surfacing. `entityType` alone lists
// everyone who viewed that kind of record; add `entityId` to narrow to one.
export const accessLogByEntityQuerySchema = z
  .object({
    entityType: z.string().min(1).max(64),
    entityId: z.string().min(1).max(128).optional(),
    limit: accessLogLimit,
  })
  .strict();

// `GET /admin/access-logs/user?userId=` — what a specific user accessed.
export const accessLogByUserQuerySchema = z
  .object({
    userId: z.string().min(1).max(128),
    limit: accessLogLimit,
  })
  .strict();

// `GET /patients/me/access-log` — no filters accepted: the profile is
// resolved from the authenticated user, so there is deliberately nothing
// else a patient may query by.
export const patientAccessLogQuerySchema = z
  .object({
    limit: accessLogLimit,
  })
  .strict();
