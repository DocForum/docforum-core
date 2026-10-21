// medications repositories — data access only. Other modules must not import
// from here directly; go through services/.
import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export async function findMedicationById(id: string, db: DbClient = prisma) {
  return db.medication.findUnique({ where: { id } });
}

export async function findMedicationByExternalCode(externalCode: string, db: DbClient = prisma) {
  return db.medication.findUnique({ where: { externalCode } });
}

export async function createMedication(
  db: DbClient,
  data: {
    genericName: string;
    strength?: string;
    form?: string;
    route?: string;
    externalCode?: string;
    externalSystem?: string;
  },
) {
  return db.medication.create({ data });
}

export async function upsertMedication(
  db: DbClient,
  data: {
    genericName: string;
    strength?: string;
    form?: string;
    route?: string;
    externalCode?: string;
    externalSystem?: string;
  },
) {
  if (!data.externalCode) {
    return db.medication.create({ data });
  }
  return db.medication.upsert({
    where: { externalCode: data.externalCode },
    update: {
      genericName: data.genericName,
      strength: data.strength,
      form: data.form,
      route: data.route,
      externalSystem: data.externalSystem,
    },
    create: data,
  });
}

export async function searchMedications(
  query: string,
  limit: number = 20,
  db: DbClient = prisma,
) {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  // Use PostgreSQL trigram similarity for fuzzy search
  // Requires pg_trgm extension (installed via migration)
  return db.$queryRaw<Array<{ id: string; genericName: string; strength: string | null; form: string | null; route: string | null; externalCode: string | null; externalSystem: string | null }>>`
    SELECT id, "genericName", strength, form, route, "externalCode", "externalSystem"
    FROM "Medication"
    WHERE "genericName" % ${trimmed}
       OR "externalCode" % ${trimmed}
    ORDER BY similarity("genericName", ${trimmed}) DESC
    LIMIT ${limit}
  `;
}

export async function listMedications(
  cursor: string | undefined,
  take: number,
  db: DbClient = prisma,
) {
  return db.medication.findMany({
    orderBy: { genericName: 'asc' },
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

export async function countMedications(db: DbClient = prisma) {
  return db.medication.count();
}

export async function findMedicationsByIds(ids: string[], db: DbClient = prisma) {
  if (ids.length === 0) return [];
  return db.medication.findMany({
    where: { id: { in: ids } },
  });
}