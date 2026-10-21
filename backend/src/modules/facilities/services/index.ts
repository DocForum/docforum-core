// facilities services — other modules must import pricing from here, never
// from repositories/ directly (AGENTS.md module-boundary rule).
//
// Two responsibilities:
//   1. facility owners manage a versioned price list (append-only);
//   2. the eligible-facility lookup and the order/ payments path resolve the
//      price in force *now*, and the intent stores that amount as a snapshot
//      so a later price change cannot re-price it.
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import * as auditService from '../../audit/services';
import * as facilitiesRepo from '../repositories';
import type { Db } from '../repositories';
import {
  NATIVE_PRICE_ASSET,
  parseEffectiveFrom,
  priceOnRequestError,
  selectCurrentPrice,
} from '../pricing';
import { parseStroopsAmount } from '../../../utils/stroops';

const MAX_CATALOG_ITEM_CODE_LENGTH = 100;
const MAX_ASSET_ID_LENGTH = 120;

export const DEFAULT_PRICE_ASSET = NATIVE_PRICE_ASSET;

export interface PriceVersionInput {
  catalogItemCode: string;
  /** Smallest units (stroops), as a string from JSON or a bigint internally. */
  amount: string | bigint | number;
  /** Defaults to native XLM. */
  asset?: string;
  /** Defaults to "now"; a later timestamp schedules the version. */
  effectiveFrom?: string | Date;
}

export interface PriceView {
  id: string;
  facilityId: string;
  catalogItemCode: string;
  asset: string;
  amount: bigint;
  effectiveFrom: Date;
  createdAt: Date;
}

function assertCatalogItemCode(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new HttpError(400, 'catalogItemCode is required.');
  if (trimmed.length > MAX_CATALOG_ITEM_CODE_LENGTH) {
    throw new HttpError(400, `catalogItemCode must be at most ${MAX_CATALOG_ITEM_CODE_LENGTH} characters.`);
  }
  return trimmed;
}

function assertAsset(value: string | undefined): string {
  const asset = (value ?? NATIVE_PRICE_ASSET).trim();
  if (asset.length === 0) throw new HttpError(400, 'asset must not be empty.');
  if (asset.length > MAX_ASSET_ID_LENGTH) {
    throw new HttpError(400, `asset must be at most ${MAX_ASSET_ID_LENGTH} characters.`);
  }
  return asset;
}

/** The caller's own facility profile id — price management is always
 * "my" facility, never a client-supplied id (no IDOR surface). */
export async function getOwnFacilityProfileId(userId: string): Promise<string> {
  const facility = await facilitiesRepo.findFacilityProfileByUserId(userId);
  if (!facility) throw new HttpError(403, 'No facility profile is linked to this account.');
  return facility.id;
}

async function requireFacilityForWrite(actor: auditService.AuditActor, facilityId: string) {
  const facility = await facilitiesRepo.findFacilityProfileById(facilityId);
  if (!facility) throw new HttpError(404, 'Facility not found.');
  if (actor.role !== 'admin' && (actor.userId === null || facility.userId !== actor.userId)) {
    throw new HttpError(403, 'Only the facility owner can manage this price list.');
  }
  return facility;
}

/**
 * The facility's price list, newest version first. Public: published prices
 * are what patients compare, so reading them needs no ownership. Writing
 * (below) does.
 */
export async function listPrices(
  facilityId: string,
  filters: { catalogItemCode?: string; asset?: string } = {},
): Promise<PriceView[]> {
  const facility = await facilitiesRepo.findFacilityProfileById(facilityId);
  if (!facility) throw new HttpError(404, 'Facility not found.');
  return facilitiesRepo.listPriceHistory(facilityId, filters);
}

/**
 * Publishes a new price version. Append-only by design: publishing the same
 * item/asset at a new `effectiveFrom` supersedes the old row for future
 * pricing while leaving the old row (and any intent priced from it) intact.
 */
export async function createPriceVersion(
  actor: auditService.AuditActor,
  facilityId: string,
  input: PriceVersionInput,
): Promise<PriceView> {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  await requireFacilityForWrite(actor, facilityId);

  const catalogItemCode = assertCatalogItemCode(input.catalogItemCode);
  const asset = assertAsset(input.asset);
  const amount = parseStroopsAmount(input.amount);
  const effectiveFrom = parseEffectiveFrom(input.effectiveFrom);

  try {
    return await prisma.$transaction(async (tx) => {
      const price = await facilitiesRepo.createPriceVersion(tx, {
        facilityId,
        catalogItemCode,
        asset,
        amount,
        effectiveFrom,
      });
      await auditService.record(tx, actor, {
        entityType: 'FacilityPrice',
        entityId: price.id,
        action: 'facility_price.created',
        fromState: null,
        toState: 'published',
        metadata: {
          facilityId,
          catalogItemCode,
          asset,
          amountStroops: amount.toString(),
          effectiveFrom: effectiveFrom.toISOString(),
        },
      });
      return price;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'A price for this item and asset already exists with that effectiveFrom.');
    }
    throw error;
  }
}

/**
 * The price in force for one facility + catalog item (+ asset) at `at`, or
 * `null` when the facility has not published one — the caller renders that as
 * "price on request". Accepts a transaction client so the read and the write
 * it prices happen in one transaction.
 */
export async function resolveCurrentPrice(
  db: Db,
  input: { facilityProfileId: string; catalogItemCode: string; asset?: string; at?: Date },
): Promise<{ amount: bigint; effectiveFrom: Date; versionId: string } | null> {
  const catalogItemCode = assertCatalogItemCode(input.catalogItemCode);
  const asset = assertAsset(input.asset);
  const at = input.at ?? new Date();
  const versions = await facilitiesRepo.findPriceVersions(input.facilityProfileId, catalogItemCode, asset, db);
  const current = selectCurrentPrice(versions, at);
  if (!current) return null;
  return { amount: current.amount, effectiveFrom: current.effectiveFrom, versionId: current.id };
}

/**
 * Same as `resolveCurrentPrice`, but throws the documented 422
 * `PRICE_ON_REQUEST` instead of returning null. Used where an amount is
 * mandatory (pricing a new intent).
 */
export async function requireCurrentPrice(
  db: Db,
  input: { facilityProfileId: string; catalogItemCode: string; asset?: string; at?: Date },
): Promise<{ amount: bigint; effectiveFrom: Date; versionId: string }> {
  const price = await resolveCurrentPrice(db, input);
  if (!price) throw priceOnRequestError(input.catalogItemCode);
  return price;
}

export interface EligibleFacility {
  facilityId: string;
  name: string;
  type: 'lab' | 'pharmacy';
  /** Current price in smallest units, or null → "price on request". */
  price: { amount: bigint; effectiveFrom: Date } | null;
  priceOnRequest: boolean;
}

/**
 * Facilities of `type`, each with the price in force at `at` for the optional
 * `catalogItemCode` — the patient-facing comparison query (issue #127).
 *
 * Candidate selection is by facility type only: capability matching is issue
 * #14's scope and the capability model is still placeholder. When that lands,
 * the candidate set narrows without changing this response shape.
 */
export async function listEligibleFacilities(input: {
  type: 'lab' | 'pharmacy';
  catalogItemCode?: string;
  asset?: string;
  at?: Date;
}): Promise<EligibleFacility[]> {
  const at = input.at ?? new Date();
  const facilities = await facilitiesRepo.listFacilityProfilesByType(input.type);
  if (!input.catalogItemCode) {
    return facilities.map((facility) => ({
      facilityId: facility.id,
      name: facility.name,
      type: facility.type,
      price: null,
      priceOnRequest: true,
    }));
  }

  const catalogItemCode = assertCatalogItemCode(input.catalogItemCode);
  const asset = assertAsset(input.asset);
  const rows = await facilitiesRepo.findPriceVersionsForFacilities(
    facilities.map((facility) => facility.id),
    catalogItemCode,
    asset,
    at,
  );
  const byFacility = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    // Rows arrive newest-first; keep the first in-force version per facility.
    if (!byFacility.has(row.facilityId)) byFacility.set(row.facilityId, row);
  }

  return facilities.map((facility) => {
    const row = byFacility.get(facility.id);
    return {
      facilityId: facility.id,
      name: facility.name,
      type: facility.type,
      price: row ? { amount: row.amount, effectiveFrom: row.effectiveFrom } : null,
      priceOnRequest: !row,
    };
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';
}
