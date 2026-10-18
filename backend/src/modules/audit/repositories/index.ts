// audit repositories — AuditEvent data access. INSERT and SELECT only: this
// table is append-only (issue #43), enforced again by a database trigger.
// There is intentionally no update or delete function here; don't add one.
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
