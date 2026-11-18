// facilities repositories — data access only. Other modules must not import
// from here directly; go through services/. Reads that the payments module
// needs inside its own transaction take a Prisma client so the price snapshot
// and the intent write commit (or roll back) together.
//
// The distance query (issue #74) lives here: the patient's `near`
// coordinates are used as bind parameters and nothing else — never stored,
// never echoed back.
import { prisma } from '../../../db/prisma-client';
import { Prisma } from '@prisma/client';
import type { CapabilityType, FacilityType } from '@prisma/client';

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

// --- Eligible-facility query (issues #14 + #74) ---------------------------

export interface EligibleFacilityRow {
  id: string;
  name: string;
  type: FacilityType;
  address: string | null;
  distanceKm: number | null;
}

export interface EligibleFacilityFilters {
  /** Facility kind (issue #14) — omit to search every kind. */
  type?: FacilityType;
  /** Capability the facility must hold (fail closed: no capability row,
   * no result). The service derives it from `type` when only that is given. */
  capabilityType?: CapabilityType;
  detail?: string;
  /** Patient's query point — bind parameters only, never stored (issue #74). */
  near?: { lat: number; lng: number };
  radiusKm?: number;
  limit: number;
}

/** Mean km per degree of latitude — slightly less than the equatorial
 * 110.574 so the bounding box is always a superset of the true radius
 * circle. */
const KM_PER_DEG_LAT = 110.574;
/** Max km per degree of longitude (at the equator) — using the maximum
 * makes the longitude box a superset at every latitude. */
const KM_PER_DEG_LNG = 111.32;
/** Earth radius, km. Same value the SQL haversine below uses. */
const EARTH_RADIUS_KM = 6371;

/**
 * Qualified facilities, optionally sorted by distance from `near`
 * (PRD FR-13 / issue #74).
 *
 * Why an indexed bounding box + in-SQL haversine and not PostGIS:
 * Postgres without the PostGIS extension (the Render free-tier preview,
 * any bare local DB, `prisma migrate deploy` on CI) can't rely on
 * geometry types, and adding an extension to every deployment for one
 * ORDER BY is exactly the kind of infra ceremony ARCHITECTURE.md §6.3
 * warns against. The composite index on (latitude, longitude) bounds the
 * scan to the ~box rows; haversine over those rows is exact, so the
 * result is identical to a true-radius query — the box only has to be a
 * superset of the circle, which the constants above guarantee.
 *
 * Facilities WITHOUT coordinates are never excluded by the spatial
 * filter — they appear, sorted last (issue #74 edge case). NULL sorts
 * last via `NULLS LAST`.
 */
export function listEligibleFacilityProfiles(
  filters: EligibleFacilityFilters,
): Promise<EligibleFacilityRow[]> {
  const type = filters.type ?? null;
  const capabilityType = filters.capabilityType ?? null;
  const detail = filters.detail ?? null;

  const typeFilter = Prisma.sql`(
    ${type}::text IS NULL
    OR fp."type"::text = ${type}::text
  )`;

  const capabilityFilter = Prisma.sql`(
    ${capabilityType}::text IS NULL
    OR EXISTS (
      SELECT 1 FROM "FacilityCapability" fc
      WHERE fc."facilityProfileId" = fp."id"
        AND fc."capabilityType"::text = ${capabilityType}
        AND (${detail}::text IS NULL OR lower(fc."detail") = lower(${detail}::text))
    )
  )`;

  if (!filters.near) {
    return prisma.$queryRaw<EligibleFacilityRow[]>(Prisma.sql`
      SELECT
        fp."id", fp."name", fp."type"::text AS "type", fp."address",
        NULL::float8 AS "distanceKm"
      FROM "FacilityProfile" fp
      WHERE ${typeFilter} AND ${capabilityFilter}
      ORDER BY fp."name" ASC
      LIMIT ${filters.limit}
    `);
  }

  const { lat, lng } = filters.near;
  const radiusKm = filters.radiusKm ?? null;
  // NOTE (Prisma 7 / driver adapters): bound params travel with an
  // unspecified type OID, so Postgres does the type inference. Expressions
  // like `${lat} - ${boxLat}` are `unknown - unknown` — an operator Postgres
  // refuses as ambiguous (42725). So: the box bounds are arithmetically
  // precomputed here in JS, and every numeric param that reaches the SQL
  // carries an explicit `::float8`.
  // Bounding-box half-extents in degrees. Guarded against division by
  // ~0 near the poles (box just becomes enormous — still a superset).
  const boxLat = (radiusKm ?? 0) / KM_PER_DEG_LAT;
  const boxLng = (radiusKm ?? 0) / Math.max(Math.abs(Math.cos((lat * Math.PI) / 180)), 1e-9) / KM_PER_DEG_LNG;

  // When no radius is given the box can't be prefiltered either — the
  // full scan still computes exact distances and sorts, which is fine at
  // the scale this v1 targets (thousands of facilities, measured in the
  // integration test).
  const boxFilter =
    radiusKm === null
      ? Prisma.empty
      : Prisma.sql`AND (
          fp."latitude" IS NULL OR fp."longitude" IS NULL
          OR (
            fp."latitude" BETWEEN ${lat - boxLat}::float8 AND ${lat + boxLat}::float8
            AND fp."longitude" BETWEEN ${lng - boxLng}::float8 AND ${lng + boxLng}::float8
          )
        )`;

  const radiusFilter =
    radiusKm === null ? Prisma.empty : Prisma.sql`WHERE "distanceKm" IS NULL OR "distanceKm" <= ${radiusKm}::float8`;

  return prisma.$queryRaw<EligibleFacilityRow[]>(Prisma.sql`
    WITH scored AS (
      SELECT
        fp."id", fp."name", fp."type"::text AS "type", fp."address",
        CASE
          WHEN fp."latitude" IS NULL OR fp."longitude" IS NULL THEN NULL
          ELSE 2 * ${EARTH_RADIUS_KM}::float8 * asin(least(1.0, sqrt(
            power(sin(radians(fp."latitude" - ${lat}::float8) / 2), 2)
            + cos(radians(${lat}::float8)) * cos(radians(fp."latitude"))
              * power(sin(radians(fp."longitude" - ${lng}::float8) / 2), 2)
          )))
        END AS "distanceKm"
      FROM "FacilityProfile" fp
      WHERE ${typeFilter} AND ${capabilityFilter}
      ${boxFilter}
    )
    SELECT * FROM scored
    ${radiusFilter}
    ORDER BY "distanceKm" ASC NULLS LAST, "name" ASC
    LIMIT ${filters.limit}
  `);
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
