// facilities repositories — data access only. Other modules must not import
// from here directly; go through services/. Reads that the payments module
// needs inside its own transaction take a Prisma client so the price snapshot
// and the intent write commit (or roll back) together.
import { prisma } from '../../../db/prisma-client';
import type { FacilityType, Prisma } from '@prisma/client';

/** Any Prisma client: the shared one, or a transaction's. */
export type Db = Prisma.TransactionClient | typeof prisma;

export function findFacilityProfileByUserId(userId: string) {
  return prisma.facilityProfile.findUnique({ where: { userId } });
}

export function findFacilityProfileById(id: string, db: Db = prisma) {
  return db.facilityProfile.findUnique({ where: { id } });
}

/** Every version of the facility's price list, newest first. Optionally
 * narrowed to one catalog item and/or asset. */
export function listPriceHistory(
  facilityId: string,
  filters: { catalogItemCode?: string; asset?: string } = {},
  db: Db = prisma,
) {
  return db.facilityPrice.findMany({
    where: {
      facilityId,
      ...(filters.catalogItemCode ? { catalogItemCode: filters.catalogItemCode } : {}),
      ...(filters.asset ? { asset: filters.asset } : {}),
    },
    orderBy: [{ catalogItemCode: 'asc' }, { asset: 'asc' }, { effectiveFrom: 'desc' }],
  });
}

/** Every version of one catalog item/asset for a facility, newest first —
 * `selectCurrentPrice` narrows it to the version in force at a timestamp. */
export function findPriceVersions(
  facilityId: string,
  catalogItemCode: string,
  asset: string,
  db: Db = prisma,
) {
  return db.facilityPrice.findMany({
    where: { facilityId, catalogItemCode, asset },
    orderBy: { effectiveFrom: 'desc' },
  });
}

/** Current price rows ("effectiveFrom <= at") for many facilities at once,
 * newest first, so the eligible-facility query is one round trip. */
export function findPriceVersionsForFacilities(
  facilityIds: string[],
  catalogItemCode: string,
  asset: string,
  at: Date,
  db: Db = prisma,
) {
  if (facilityIds.length === 0) return Promise.resolve([]);
  return db.facilityPrice.findMany({
    where: {
      facilityId: { in: facilityIds },
      catalogItemCode,
      asset,
      effectiveFrom: { lte: at },
    },
    orderBy: { effectiveFrom: 'desc' },
  });
}

/** Appends a price version. Never updates an existing row — history stays. */
export function createPriceVersion(
  db: Db,
  data: {
    facilityId: string;
    catalogItemCode: string;
    asset: string;
    amount: bigint;
    effectiveFrom: Date;
  },
) {
  return db.facilityPrice.create({ data });
}

/** Facilities of a given type, for the eligible-facility lookup. */
export function listFacilityProfilesByType(type: FacilityType, db: Db = prisma) {
  return db.facilityProfile.findMany({
    where: { type },
    select: { id: true, name: true, type: true },
    orderBy: { name: 'asc' },
  });
}
