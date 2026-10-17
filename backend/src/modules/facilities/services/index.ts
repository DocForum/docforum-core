// facilities services — eligible-facility discovery. Other modules must
// only import from here, never from repositories/ directly (AGENTS.md
// hard rule 4).
import * as facilitiesRepo from '../repositories';
import type { EligibleFacilitiesQuery } from '../validation';

/** Default search radius when `near` is given but `radiusKm` isn't — a
 * city-scale default rather than "sort everything in the country". */
export const DEFAULT_RADIUS_KM = 50;
const DEFAULT_LIMIT = 50;

export interface EligibleFacility {
  id: string;
  name: string;
  type: string;
  address: string | null;
  /** Straight-line km from the patient's query point, or null for a
   * facility that hasn't registered coordinates (it still appears in the
   * list — issue #74 edge case — just sorted last). */
  distanceKm: number | null;
}

/**
 * Patient-facing list of facilities qualified for an order type, sorted
 * by distance from the patient's point when one is provided (issue #74).
 *
 * Privacy: the `near` point lives on the call stack of this request and
 * nothing else. It is never persisted, never written to a log line, and
 * never echoed back in the response (the response carries only per-
 * facility distances). No caller in this module stores it — enforced by
 * it being a plain function argument here and bind parameters in
 * repositories/.
 */
export async function listEligibleFacilities(query: EligibleFacilitiesQuery): Promise<EligibleFacility[]> {
  const rows = await facilitiesRepo.listEligibleFacilities({
    capabilityType: query.capabilityType,
    detail: query.detail,
    near: query.near,
    radiusKm: query.radiusKm ?? (query.near ? DEFAULT_RADIUS_KM : undefined),
    limit: query.limit ?? DEFAULT_LIMIT,
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    address: row.address,
    distanceKm: row.distanceKm === null ? null : Number(row.distanceKm.toFixed(2)),
  }));
}
