// facilities repositories — FacilityProfile / FacilityCapability data
// access. The distance query lives here; the patient's `near` coordinates
// are used as bind parameters and nothing else — never stored, never
// echoed back (issue #74).
import { prisma } from '../../../db/prisma-client';
import { Prisma } from '@prisma/client';

export interface EligibleFacilityRow {
  id: string;
  name: string;
  type: string;
  address: string | null;
  distanceKm: number | null;
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

export interface EligibleFacilityFilters {
  capabilityType?: 'lab_test' | 'medication_dispense';
  detail?: string;
  near?: { lat: number; lng: number };
  radiusKm?: number;
  limit: number;
}

/**
 * Eligible facilities, optionally sorted by distance from `near`
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
export function listEligibleFacilities(filters: EligibleFacilityFilters): Promise<EligibleFacilityRow[]> {
  const capabilityType = filters.capabilityType ?? null;
  const detail = filters.detail ?? null;

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
      WHERE ${capabilityFilter}
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
      WHERE ${capabilityFilter}
      ${boxFilter}
    )
    SELECT * FROM scored
    ${radiusFilter}
    ORDER BY "distanceKm" ASC NULLS LAST, "name" ASC
    LIMIT ${filters.limit}
  `);
}
