// lab-tests repositories — data access only. Other modules must not import
// from here directly; go through services/.
import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export async function findLabTestById(id: string, db: DbClient = prisma) {
  return db.labTest.findUnique({ where: { id } });
}

export async function findLabTestByCode(code: string, db: DbClient = prisma) {
  return db.labTest.findUnique({ where: { code } });
}

export async function createLabTest(
  db: DbClient,
  data: {
    code: string;
    name: string;
    specimenType?: string;
    category?: string;
    panelOfIds?: string[];
  },
) {
  const { panelOfIds, ...rest } = data;
  const test = await db.labTest.create({ data: rest });
  if (panelOfIds && panelOfIds.length > 0) {
    await db.labTest.update({
      where: { id: test.id },
      data: { panelOf: { connect: panelOfIds.map((id) => ({ id })) } },
    });
  }
  return test;
}

export async function upsertLabTest(
  db: DbClient,
  data: {
    code: string;
    name: string;
    specimenType?: string;
    category?: string;
  },
) {
  return db.labTest.upsert({
    where: { code: data.code },
    update: {
      name: data.name,
      specimenType: data.specimenType,
      category: data.category,
    },
    create: data,
  });
}

export async function searchLabTests(
  query: string,
  limit: number = 20,
  db: DbClient = prisma,
) {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  return db.$queryRaw<Array<{ id: string; code: string; name: string; specimenType: string | null; category: string | null }>>`
    SELECT id, code, name, "specimenType", category
    FROM "LabTest"
    WHERE name % ${trimmed}
       OR code % ${trimmed}
    ORDER BY similarity(name, ${trimmed}) DESC
    LIMIT ${limit}
  `;
}

export async function listLabTests(
  cursor: string | undefined,
  take: number,
  db: DbClient = prisma,
) {
  return db.labTest.findMany({
    orderBy: { name: 'asc' },
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

export async function findLabTestsByIds(ids: string[], db: DbClient = prisma) {
  if (ids.length === 0) return [];
  return db.labTest.findMany({
    where: { id: { in: ids } },
    include: { panelComponents: true },
  });
}

export async function findLabTestsByCodes(codes: string[], db: DbClient = prisma) {
  if (codes.length === 0) return [];
  return db.labTest.findMany({
    where: { code: { in: codes } },
  });
}