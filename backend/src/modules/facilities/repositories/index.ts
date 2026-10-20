// facilities repositories — Data access only. Not to be imported
// by other modules directly — go through services/ instead.
import { prisma } from '../../../db/prisma-client';

export async function findFacilityProfileByUserId(userId: string) {
  return prisma.facilityProfile.findFirst({ where: { userId } });
}

export async function findFacilityProfileById(id: string) {
  return prisma.facilityProfile.findUnique({ where: { id } });
}

export async function listPricesForFacility(facilityId: string) {
  return prisma.facilityPrice.findMany({
    where: { facilityId },
    orderBy: [{ catalogItemCode: 'asc' }, { effectiveFrom: 'desc' }],
  });
}

export async function findCurrentPrice(facilityId: string, catalogItemCode: string, at: Date = new Date()) {
  return prisma.facilityPrice.findFirst({
    where: {
      facilityId,
      catalogItemCode,
      effectiveFrom: { lte: at },
    },
    orderBy: { effectiveFrom: 'desc' },
  });
}

export async function findCurrentPricesForFacilities(facilityIds: string[], catalogItemCode: string, at: Date = new Date()) {
  const prices = await prisma.facilityPrice.findMany({
    where: {
      facilityId: { in: facilityIds },
      catalogItemCode: catalogItemCode,
      effectiveFrom: { lte: at },
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  const byFacility = new Map<string, (typeof prices)[0]>();
  for (const p of prices) {
    if (!byFacility.has(p.facilityId)) byFacility.set(p.facilityId, p);
  }
  return byFacility;
}

export async function createPrice(data: {
  facilityId: string;
  catalogItemCode: string;
  asset: string;
  amount: bigint;
  effectiveFrom: Date;
}) {
  return prisma.facilityPrice.create({ data });
}
