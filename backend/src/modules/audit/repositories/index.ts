// audit repositories — AccessLog data access only. Not to be imported
// outside this module's services — see AGENTS.md "Non-negotiable rules".
import { prisma } from '../../../db/prisma-client';

export type AccessLogCreateInput = {
  accessedBy?: string | null;
  patientProfileId?: string | null;
  entityType: string;
  entityId: string;
  route?: string | null;
  detail?: string | null;
};

/** Appends one read-access row. Never updates or deletes existing rows —
 * an audit trail that can be rewritten isn't one. */
export async function recordAccess(input: AccessLogCreateInput) {
  return prisma.accessLog.create({
    data: {
      accessedBy: input.accessedBy ?? null,
      patientProfileId: input.patientProfileId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      route: input.route ?? null,
      detail: input.detail ?? null,
    },
  });
}

/** Admin read-side: who accessed a specific entity. */
export async function findAccessByEntity(entityType: string, entityId: string) {
  return prisma.accessLog.findMany({
    where: { entityType, entityId },
    orderBy: { accessedAt: 'desc' },
    take: 200,
    include: {
      accessedByUser: { select: { id: true, role: true, email: true } },
    },
  });
}

/** Patient read-side: who viewed MY records (scoped by patientProfileId). */
export async function findAccessForPatient(patientProfileId: string) {
  return prisma.accessLog.findMany({
    where: { patientProfileId },
    orderBy: { accessedAt: 'desc' },
    take: 200,
    include: {
      accessedByUser: { select: { id: true, role: true } },
    },
  });
}

/** Admin read-side: what a specific user has accessed. */
export async function findAccessByUser(accessedBy: string) {
  return prisma.accessLog.findMany({
    where: { accessedBy },
    orderBy: { accessedAt: 'desc' },
    take: 200,
  });
}

/** Retention pruning: delete rows older than the retention window.
 * Returns the number of rows deleted. */
export async function pruneAccessLogs(olderThan: Date): Promise<number> {
  const result = await prisma.accessLog.deleteMany({
    where: { accessedAt: { lt: olderThan } },
  });
  return result.count;
}
