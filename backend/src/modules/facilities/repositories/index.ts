// facilities repositories — data access only. Other modules must not import
// from here directly; go through services/. Reads that the payments module
// needs inside its own transaction take a Prisma client so the price snapshot
// and the intent write commit (or roll back) together.
import { prisma } from '../../../db/prisma-client';
import type { CapabilityType, FacilityType, Prisma } from '@prisma/client';

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

/**
 * Facilities qualified for an order kind (issue #14): the facility's type
 * *and* a matching `FacilityCapability` row are both required — a facility
 * with no capability data is never returned (fail closed, PRD FR-13/§8.1.6).
 */
export function listQualifiedFacilityProfiles(type: FacilityType, capabilityType: CapabilityType, db: Db = prisma) {
  return db.facilityProfile.findMany({
    where: { type, capabilities: { some: { capabilityType } } },
    select: { id: true, name: true, type: true },
    orderBy: { name: 'asc' },
  });
}

// --- Account creation (issue #14, admin-only) -----------------------------
// These run on the caller's transaction client: a facility account is a
// User + FacilityProfile + its capabilities or nothing — a half-created
// account is a login that can never be matched to a profile.

export function createFacilityUser(
  db: Db,
  data: { email: string; passwordHash: string; emailVerifiedAt: Date },
) {
  return db.user.create({
    data: { email: data.email, passwordHash: data.passwordHash, role: 'facility', emailVerifiedAt: data.emailVerifiedAt },
  });
}

export function createFacilityProfile(
  db: Db,
  data: { userId: string; name: string; type: FacilityType },
) {
  return db.facilityProfile.create({ data });
}

/** Caps live here too: the DB unique index treats two NULL details as
 * distinct rows, so de-duplication is this module's job. */
export async function createFacilityCapabilities(
  db: Db,
  facilityProfileId: string,
  capabilities: { capabilityType: CapabilityType; detail: string | null }[],
) {
  const byKey = new Map<string, { capabilityType: CapabilityType; detail: string | null }>();
  for (const capability of capabilities) {
    byKey.set(`${capability.capabilityType}|${capability.detail ?? ''}`, capability);
  }
  if (byKey.size === 0) return [];
  await db.facilityCapability.createMany({
    data: [...byKey.values()].map((capability) => ({ facilityProfileId, ...capability })),
  });
  return db.facilityCapability.findMany({
    where: { facilityProfileId },
    orderBy: [{ capabilityType: 'asc' }, { detail: 'asc' }],
  });
}
