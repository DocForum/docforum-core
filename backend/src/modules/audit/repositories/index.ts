// audit repositories — AuditEvent and AccessLog data access.
//
// AuditEvent (issue #43): INSERT and SELECT only — the table is
// append-only, enforced again by a database trigger. There is
// intentionally no update or delete function for it here; don't add one.
//
// AccessLog (issue #45) is a different table with a different lifecycle:
// reads are far higher volume and retention-managed, so `pruneAccessLogs`
// is the one deliberate delete — it removes rows older than the retention
// window, never arbitrary ones.
import { prisma } from '../../../db/prisma-client';
import type { Prisma, Role } from '@prisma/client';

export interface AuditEventRow {
  actorUserId: string | null;
  actorRole: Role | null;
  entityType: string;
  entityId: string;
  action: string;
  fromState: string | null;
  toState: string | null;
  requestId: string | null;
  metadata: Prisma.InputJsonValue | undefined;
}

/** Must be given the transaction client of the change being audited. */
export function insertAuditEvent(tx: Prisma.TransactionClient, row: AuditEventRow) {
  return tx.auditEvent.create({ data: row });
}

export interface AuditEventQuery {
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  from?: Date;
  to?: Date;
  /** Keyset position: return events strictly older than this one. */
  before?: { createdAt: Date; id: string };
  take: number;
}

/** Newest first, ordered by (createdAt DESC, id DESC) — a total order, so a
 * keyset cursor on that pair never skips or repeats a row. */
export function findAuditEvents(query: AuditEventQuery) {
  const and: Prisma.AuditEventWhereInput[] = [];
  if (query.entityType) and.push({ entityType: query.entityType });
  if (query.entityId) and.push({ entityId: query.entityId });
  if (query.actorUserId) and.push({ actorUserId: query.actorUserId });
  if (query.from) and.push({ createdAt: { gte: query.from } });
  if (query.to) and.push({ createdAt: { lte: query.to } });
  if (query.before) {
    and.push({
      OR: [
        { createdAt: { lt: query.before.createdAt } },
        { createdAt: query.before.createdAt, id: { lt: query.before.id } },
      ],
    });
  }
  return prisma.auditEvent.findMany({
    where: { AND: and },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.take,
  });
}

// --- AccessLog (Phase 8, issue #45) ----------------------------------------
// Written off the read path (fire-and-forget from the service), so this
// uses the root client, unlike insertAuditEvent above.

export interface AccessLogRow {
  accessedBy: string | null;
  patientProfileId: string | null;
  entityType: string;
  entityId: string;
  route: string | null;
  detail: string | null;
}

export function recordAccess(row: AccessLogRow) {
  return prisma.accessLog.create({ data: row });
}

/** Viewer id/role only — callers that surface results to patients must
 * strip even this (see services getAccessForPatient). */
const ACCESS_LOG_VIEWER = { select: { id: true, role: true } } as const;

export interface AccessLogByEntityQuery {
  entityType: string;
  entityId?: string;
  take: number;
}

/** Admin: who accessed a specific kind of record (optionally a specific
 * one). Newest first; bounded by `take` — no unpaged dump. */
export function findAccessByEntity(query: AccessLogByEntityQuery) {
  return prisma.accessLog.findMany({
    where: {
      entityType: query.entityType,
      ...(query.entityId ? { entityId: query.entityId } : {}),
    },
    include: { accessedByUser: ACCESS_LOG_VIEWER },
    orderBy: { accessedAt: 'desc' },
    take: query.take,
  });
}

export interface AccessLogForPatientQuery {
  patientProfileId: string;
  take: number;
}

/** Patient-facing source rows: whose records were viewed, by whom. The
 * service strips the viewer's identity before this shape leaves the API. */
export function findAccessForPatient(query: AccessLogForPatientQuery) {
  return prisma.accessLog.findMany({
    where: { patientProfileId: query.patientProfileId },
    include: { accessedByUser: ACCESS_LOG_VIEWER },
    orderBy: { accessedAt: 'desc' },
    take: query.take,
  });
}

export interface AccessLogByUserQuery {
  accessedBy: string;
  take: number;
}

/** Admin: what a specific user accessed. */
export function findAccessByUser(query: AccessLogByUserQuery) {
  return prisma.accessLog.findMany({
    where: { accessedBy: query.accessedBy },
    include: { accessedByUser: ACCESS_LOG_VIEWER },
    orderBy: { accessedAt: 'desc' },
    take: query.take,
  });
}

/** Retention pruning: removes rows strictly older than `before`. Returns
 * the number of rows deleted. This is the only delete on AccessLog. */
export function pruneAccessLogs(before: Date) {
  return prisma.accessLog
    .deleteMany({ where: { accessedAt: { lt: before } } })
    .then((result) => result.count);
}
