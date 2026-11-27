// facilities services — other modules must import pricing from here, never
// from repositories/ directly (AGENTS.md module-boundary rule).
//
// Three responsibilities:
//   1. facility owners manage a versioned price list (append-only);
//   2. the eligible-facility lookup and the order/ payments path resolve the
//      price in force *now*, and the intent stores that amount as a snapshot
//      so a later price change cannot re-price it;
//   3. admin-only facility account creation + FacilityCapability matching
//      (issue #14, PRD OQ-2 / FR-13): facilities are curated, never
//      self-serve, and a patient only ever sees facilities qualified for
//      their order type.
//   4. the eligible list can be distance-sorted from a patient-supplied
//      point (issue #74) — the point is a bind parameter and nothing else:
//      never stored, never logged, never echoed back.
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { versionConflict } from '../../../middleware/optimistic-concurrency';
import * as auditService from '../../audit/services';
import { hashPassword } from '../../auth/services';
import * as facilitiesRepo from '../repositories';
import type { Db } from '../repositories';
import {
  NATIVE_PRICE_ASSET,
  itemRetiredError,
  parseEffectiveFrom,
  priceOnRequestError,
  selectCurrentPrice,
} from '../pricing';
import { parseStroopsAmount } from '../../../utils/stroops';
import type { CapabilityType, FacilityType } from '@prisma/client';

const MAX_CATALOG_ITEM_CODE_LENGTH = 100;
const MAX_ASSET_ID_LENGTH = 120;
const MAX_CAPABILITY_DETAIL_LENGTH = 100;
/** Mirrors auth signup's minimum — an admin-set initial password must not
 * be weaker than a self-chosen one. */
const MIN_FACILITY_PASSWORD_LENGTH = 8;
/** Default search radius when `near` is given but `radiusKm` isn't — a
 * city-scale default rather than "sort everything in the country"
 * (issue #74). Only applies when a point was given at all. */
export const DEFAULT_RADIUS_KM = 50;
/** Row cap for the eligible query when the caller doesn't pick one. */
const DEFAULT_LIMIT = 50;

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
  if (trimmed.length === 0) throw new HttpError('INVALID_CATALOG_ITEM', 'catalogItemCode is required.');
  if (trimmed.length > MAX_CATALOG_ITEM_CODE_LENGTH) {
    throw new HttpError('INVALID_CATALOG_ITEM', `catalogItemCode must be at most ${MAX_CATALOG_ITEM_CODE_LENGTH} characters.`);
  }
  return trimmed;
}

function assertAsset(value: string | undefined): string {
  const asset = (value ?? NATIVE_PRICE_ASSET).trim();
  if (asset.length === 0) throw new HttpError('INVALID_CATALOG_ITEM', 'asset must not be empty.');
  if (asset.length > MAX_ASSET_ID_LENGTH) {
    throw new HttpError('INVALID_CATALOG_ITEM', `asset must be at most ${MAX_ASSET_ID_LENGTH} characters.`);
  }
  return asset;
}

/** The caller's own facility profile id — price management is always
 * "my" facility, never a client-supplied id (no IDOR surface). */
export async function getOwnFacilityProfileId(userId: string): Promise<string> {
  const facility = await facilitiesRepo.findFacilityProfileByUserId(userId);
  if (!facility) throw new HttpError('FACILITY_PROFILE_REQUIRED', 'No facility profile is linked to this account.');
  return facility.id;
}

/** GET /facilities/me — the signed-in facility owner's full profile (issue #319). */
export async function getOwnFacilityProfile(userId: string) {
  const facility = await facilitiesRepo.findFacilityProfileByUserId(userId);
  if (!facility) throw new HttpError(403, 'No facility profile is linked to this account.');
  return facility;
}

/** PATCH /facilities/me — optimistic-concurrency profile update (issue #319).
 * Uses the ETag/If-Match version from ARCHITECTURE.md §5.4. */
export async function updateOwnFacilityProfile(
  actor: auditService.AuditActor,
  version: number,
  input: { name?: string; address?: string; latitude?: number; longitude?: number },
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const current = await getOwnFacilityProfile(actor.userId);
  const updated = await prisma.$transaction(async (tx) => {
    const result = await facilitiesRepo.updateFacilityProfile(current.id, version, input, tx);
    if (!result) return null;
    const changed = Object.keys(input)
      .filter((k) => (input as Record<string, unknown>)[k] !== undefined)
      .join(',');
    await auditService.record(tx, actor, {
      entityType: 'FacilityProfile',
      entityId: current.id,
      action: 'facility.profile_updated',
      fromState: String(version),
      toState: String(version + 1),
      metadata: { fieldsChanged: changed },
    });
    return result;
  });
  if (!updated) throw versionConflict();
  return updated;
}

async function requireFacilityForWrite(actor: auditService.AuditActor, facilityId: string) {
  const facility = await facilitiesRepo.findFacilityProfileById(facilityId);
  if (!facility) throw new HttpError('FACILITY_NOT_FOUND', 'Facility not found.');
  if (actor.role !== 'admin' && (actor.userId === null || facility.userId !== actor.userId)) {
    throw new HttpError('NOT_FACILITY_OWNER', 'Only the facility owner can manage this price list.');
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
  if (!facility) throw new HttpError('FACILITY_NOT_FOUND', 'Facility not found.');
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
  if (!actor.userId) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
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
      throw new HttpError('PRICE_EFFECTIVE_FROM_CONFLICT', 'A price for this item and asset already exists with that effectiveFrom.');
    }
    throw error;
  }
}

/**
 * The price in force for one facility + catalog item (+ asset) at `at`, or
 * `null` when the facility has not published one — the caller renders that as
 * "price on request". Returns `{ retired: true }` when the current version
 * marks the item retired. Accepts a transaction client so the read and the
 * write it prices happen in one transaction.
 */
export async function resolveCurrentPrice(
  db: Db,
  input: { facilityProfileId: string; catalogItemCode: string; asset?: string; at?: Date },
): Promise<{ amount: bigint; effectiveFrom: Date; versionId: string } | { retired: true } | null> {
  const catalogItemCode = assertCatalogItemCode(input.catalogItemCode);
  const asset = assertAsset(input.asset);
  const at = input.at ?? new Date();
  const versions = await facilitiesRepo.findPriceVersions(input.facilityProfileId, catalogItemCode, asset, db);
  const current = selectCurrentPrice(versions, at);
  if (!current) return null;
  if (current.retired) return { retired: true };
  return { amount: current.amount, effectiveFrom: current.effectiveFrom, versionId: current.id! };
}

/**
 * Same as `resolveCurrentPrice`, but throws the documented 422
 * `PRICE_ON_REQUEST` or `ITEM_RETIRED` instead of returning null/retired.
 * Used where an amount is mandatory (pricing a new intent).
 */
export async function requireCurrentPrice(
  db: Db,
  input: { facilityProfileId: string; catalogItemCode: string; asset?: string; at?: Date },
): Promise<{ amount: bigint; effectiveFrom: Date; versionId: string }> {
  const price = await resolveCurrentPrice(db, input);
  if (!price) throw priceOnRequestError(input.catalogItemCode);
  if ('retired' in price) throw itemRetiredError(input.catalogItemCode);
  return price;
}

/**
 * Retires an item from the facility's price list from `effectiveFrom` onward.
 * Append-only: inserts a new retired row; existing rows and any intent priced
 * before the retirement are unaffected. Admin or the facility owner only.
 */
export async function retirePriceItem(
  actor: auditService.AuditActor,
  facilityId: string,
  input: { catalogItemCode: string; asset?: string; effectiveFrom?: string | Date },
): Promise<PriceView & { retired: boolean }> {
  if (!actor.userId) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  await requireFacilityForWrite(actor, facilityId);

  const catalogItemCode = assertCatalogItemCode(input.catalogItemCode);
  const asset = assertAsset(input.asset);
  const effectiveFrom = parseEffectiveFrom(input.effectiveFrom);

  try {
    return await prisma.$transaction(async (tx) => {
      const price = await facilitiesRepo.createPriceVersion(tx, {
        facilityId,
        catalogItemCode,
        asset,
        amount: BigInt(0),
        effectiveFrom,
        retired: true,
      });
      await auditService.record(tx, actor, {
        entityType: 'FacilityPrice',
        entityId: price.id,
        action: 'facility_price.retired',
        fromState: 'published',
        toState: 'retired',
        metadata: {
          facilityId,
          catalogItemCode,
          asset,
          effectiveFrom: effectiveFrom.toISOString(),
        },
      });
      return { ...price, retired: price.retired };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError('PRICE_EFFECTIVE_FROM_CONFLICT', 'A price (or retirement) for this item and asset already exists with that effectiveFrom.');
    }
    throw error;
  }
}

/** Non-throwing facility profile lookup by userId — for cross-module service calls. */
export function findFacilityProfileByUserId(userId: string) {
  return facilitiesRepo.findFacilityProfileByUserId(userId);
}

/** Non-throwing facility profile lookup by id — for cross-module service calls. */
export function findFacilityProfileById(id: string, db?: Db) {
  return facilitiesRepo.findFacilityProfileById(id, db);
}

/** Batch name lookup for many facility ids — for cross-module service calls. */
export function getFacilityNamesByIds(ids: string[]) {
  return facilitiesRepo.getFacilityNamesByIds(ids);
}

// --- Admin capability management (issue #320) ----------------------------

export interface CapabilityView {
  id: string;
  capabilityType: CapabilityType;
  detail: string | null;
}

/**
 * Admin-only: add a capability to a facility. Duplicate (facilityProfileId,
 * capabilityType, detail) rows are unique-constrained at the DB level; the
 * service reports a 409 instead of a 500. With audit event.
 */
export async function addFacilityCapability(
  actor: auditService.AuditActor,
  facilityId: string,
  input: FacilityCapabilityInput,
): Promise<CapabilityView> {
  if (!actor.userId) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const facility = await facilitiesRepo.findFacilityProfileById(facilityId);
  if (!facility) throw new HttpError('FACILITY_NOT_FOUND', 'Facility not found.');

  const capabilityType = input.capabilityType as CapabilityType;
  const detail = input.detail === null || input.detail === undefined
    ? null
    : String(input.detail).trim() || null;
  if (detail !== null && detail.length > MAX_CAPABILITY_DETAIL_LENGTH) {
    throw new HttpError('INVALID_CAPABILITY', `capability detail must be at most ${MAX_CAPABILITY_DETAIL_LENGTH} characters.`);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const row = await facilitiesRepo.addCapability(tx, facilityId, { capabilityType, detail });
      await auditService.record(tx, actor, {
        entityType: 'FacilityCapability',
        entityId: row.id,
        action: 'facility.capability_added',
        fromState: null,
        toState: 'active',
        metadata: { facilityId, capabilityType, detail },
      });
      return { id: row.id, capabilityType: row.capabilityType, detail: row.detail };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError('CAPABILITY_ALREADY_HELD', 'This facility already holds this capability.');
    }
    throw error;
  }
}

/**
 * Admin-only: remove a capability from a facility. Only affects future
 * eligibility matching — already-routed orders are unaffected (they carry
 * their own facilityId FK). With audit event.
 */
export async function removeFacilityCapability(
  actor: auditService.AuditActor,
  facilityId: string,
  capabilityId: string,
): Promise<void> {
  if (!actor.userId) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const facility = await facilitiesRepo.findFacilityProfileById(facilityId);
  if (!facility) throw new HttpError('FACILITY_NOT_FOUND', 'Facility not found.');
  const capability = await facilitiesRepo.findCapabilityById(capabilityId);
  if (!capability || capability.facilityProfileId !== facilityId) {
    throw new HttpError('CAPABILITY_NOT_FOUND', 'Capability not found for this facility.');
  }

  await prisma.$transaction(async (tx) => {
    await facilitiesRepo.removeCapability(tx, capabilityId);
    await auditService.record(tx, actor, {
      entityType: 'FacilityCapability',
      entityId: capabilityId,
      action: 'facility.capability_removed',
      fromState: 'active',
      toState: 'removed',
      metadata: { facilityId, capabilityType: capability.capabilityType, detail: capability.detail },
    });
  });
}

export interface EligibleFacility {
  facilityId: string;
  name: string;
  type: 'lab' | 'pharmacy';
  /** Registered street address, or null when the facility hasn't set one
   * (issue #74 — it still appears in the list). */
  address: string | null;
  /** Straight-line km from the caller's `near` point, or null when no
   * point was given or the facility registered no coordinates. Those rows
   * still appear, sorted last (issue #74 edge case). The patient's own
   * point is never part of the response — only per-facility distances. */
  distanceKm: number | null;
  /** Current price in smallest units, or null → "price on request". */
  price: { amount: bigint; effectiveFrom: Date } | null;
  priceOnRequest: boolean;
}

/**
 * Facility type → the capability that type exists to provide. Kept in one
 * map so the creation path (below) and the matching path cannot drift: a
 * `lab` profile that cannot run lab tests is a data error, not a candidate.
 */
const CAPABILITY_BY_FACILITY_TYPE: Record<FacilityType, CapabilityType> = {
  lab: 'lab_test',
  pharmacy: 'medication_dispense',
};

function capabilityForFacilityType(type: FacilityType): CapabilityType {
  // hasOwn, not a bare lookup: an inherited key (`constructor`) must not
  // pass as a capability.
  if (!Object.hasOwn(CAPABILITY_BY_FACILITY_TYPE, type)) {
    throw new HttpError('INVALID_FACILITY_TYPE', 'type must be "lab" or "pharmacy".');
  }
  return CAPABILITY_BY_FACILITY_TYPE[type];
}

/** What each fulfillable order kind (ADR 0012's discriminator: which typed
 * FK on the order is set) requires of a facility. */
export type FacilityOrderKind = 'lab_order' | 'prescription';

const REQUIREMENT_BY_ORDER_KIND: Record<FacilityOrderKind, { facilityType: FacilityType; capabilityType: CapabilityType }> = {
  lab_order: { facilityType: 'lab', capabilityType: 'lab_test' },
  prescription: { facilityType: 'pharmacy', capabilityType: 'medication_dispense' },
};

export function facilityRequirementForOrderKind(orderKind: FacilityOrderKind) {
  // hasOwn, not a bare lookup: an inherited key (`constructor`) must not
  // resolve to a requirement.
  const requirement = Object.hasOwn(REQUIREMENT_BY_ORDER_KIND, orderKind)
    ? REQUIREMENT_BY_ORDER_KIND[orderKind]
    : undefined;
  if (!requirement) throw new HttpError('INVALID_ORDER_KIND', `Unknown order kind: ${String(orderKind)}`);
  return { ...requirement };
}

/**
 * Issue #10: the facility an order is issued to must exist and be of the
 * order kind's type (pharmacy ↔ prescription, lab ↔ lab order). Checked
 * before the order row is written, so an unknown id is a 400 instead of a
 * foreign-key failure (500) and a wrong-type facility never gets an order
 * row at all. Same message as the payment-intent guard it front-runs.
 */
export async function requireFacilityForOrderKind(db: Db, facilityProfileId: string, orderKind: FacilityOrderKind) {
  const { facilityType } = facilityRequirementForOrderKind(orderKind);
  const facility = await facilitiesRepo.findFacilityProfileById(facilityProfileId, db);
  if (!facility || facility.type !== facilityType) {
    throw new HttpError('FACILITY_TYPE_MISMATCH', `The selected facility must be a ${facilityType} facility.`);
  }
  if (facility.user?.deactivatedAt) {
    throw new HttpError('FACILITY_DEACTIVATED', 'The selected facility has been deactivated.');
  }
  return { id: facility.id, type: facility.type };
}

/**
 * Asserts that a facility exists and its account is active (not deactivated).
 * Used by cross-module consumers like pharmacy-orders before routing fulfillment.
 */
export async function assertFacilityActive(facilityProfileId: string, db: Db = prisma) {
  const facility = await facilitiesRepo.findFacilityProfileById(facilityProfileId, db);
  if (!facility) {
    throw new HttpError('FACILITY_NOT_FOUND', 'Facility not found.');
  }
  if (facility.user?.deactivatedAt) {
    throw new HttpError('FACILITY_DEACTIVATED', 'The selected facility has been deactivated.');
  }
  return facility;
}

/**
 * Facilities of `type`, each with the price in force at `at` for the optional
 * `catalogItemCode` — the patient-facing comparison query (issue #127).
 *
 * Candidate selection is capability matching (issue #14, PRD FR-13): a
 * facility appears only if it is of `type` *and* holds a `FacilityCapability`
 * of the type's capability. **Fail closed** — a facility with no capability
 * rows, or only rows of the wrong capability type (malformed data), shows for
 * nothing. Showing every facility for every order type is the fraud/safety
 * concern PRD §8.1.6 names; hiding an under-documented one is merely an
 * operator fix.
 */
/**
 * Facilities qualified for a query — capability matching (issue #14, PRD
 * FR-13), optionally distance-sorted from the patient's point (issue #74),
 * each with the price in force at `at` for the optional `catalogItemCode`
 * (issue #127).
 *
 * Fail closed (PRD §8.1.6): a facility appears only if it matches the
 * qualification filter — of `type` *and* holding that type's capability, or
 * of the explicitly asked `capabilityType`. A facility with no capability
 * rows, or only rows of the wrong capability type (malformed data), shows
 * for nothing: hiding an under-documented facility is an operator fix,
 * showing an unqualified one is the fraud risk the PRD names.
 *
 * Privacy (issue #74): `near` lives on this call stack and nothing else.
 * It is never persisted, never written to a log line, and never echoed
 * back — the response carries per-facility `distanceKm` only.
 */
export async function listEligibleFacilities(input: {
  type?: 'lab' | 'pharmacy';
  capabilityType?: CapabilityType;
  detail?: string;
  near?: { lat: number; lng: number };
  radiusKm?: number;
  limit?: number;
  catalogItemCode?: string;
  asset?: string;
  at?: Date;
}): Promise<EligibleFacility[]> {
  const at = input.at ?? new Date();
  // A caller that names only the facility type gets the capability that
  // type exists to provide — one map, so creation and matching can't drift.
  const capabilityType =
    input.capabilityType ?? (input.type ? capabilityForFacilityType(input.type) : undefined);

  const facilities = await facilitiesRepo.listEligibleFacilityProfiles({
    type: input.type,
    capabilityType,
    detail: input.detail,
    near: input.near,
    radiusKm: input.near ? (input.radiusKm ?? DEFAULT_RADIUS_KM) : undefined,
    limit: input.limit ?? DEFAULT_LIMIT,
  });

  const located = facilities.map((facility) => ({
    facilityId: facility.id,
    name: facility.name,
    type: facility.type,
    address: facility.address,
    distanceKm: facility.distanceKm === null ? null : Number(facility.distanceKm.toFixed(2)),
    price: null as { amount: bigint; effectiveFrom: Date } | null,
    priceOnRequest: true,
  }));

  if (!input.catalogItemCode) return located;

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

  return located.map((facility) => {
    const row = byFacility.get(facility.facilityId);
    if (!row) return facility;
    return {
      ...facility,
      price: { amount: row.amount, effectiveFrom: row.effectiveFrom },
      priceOnRequest: false,
    };
  });
}
/**
 * The matching query in the issue's terms: *given an order's kind*, return
 * only the facilities qualified to fulfill it (PRD FR-13). Cross-module
 * callers (the order-selection path, #15's fulfillment work) go through this
 * — never through `FacilityCapability` directly (hard rule 4). Fails closed:
 * an order kind no facility is documented for yields the empty list.
 */
export async function listEligibleFacilitiesForOrderKind(
  orderKind: FacilityOrderKind,
  input: { catalogItemCode?: string; asset?: string; at?: Date } = {},
): Promise<EligibleFacility[]> {
  const { facilityType } = facilityRequirementForOrderKind(orderKind);
  return listEligibleFacilities({ type: facilityType, ...input });
}

// --- Account creation (issue #14, PRD OQ-2) --------------------------------

export interface FacilityCapabilityInput {
  capabilityType: string;
  detail?: string | null;
}

export interface CreateFacilityInput {
  email: string;
  /** Plaintext initial password set by the admin — hashed here, never
   * stored or logged. Same posture as the bootstrap admin CLI. */
  password: string;
  name: string;
  type: FacilityType;
  capabilities: FacilityCapabilityInput[];
}

export interface CreatedFacility {
  id: string;
  userId: string;
  name: string;
  type: FacilityType;
  capabilities: { id: string; capabilityType: CapabilityType; detail: string | null }[];
  createdAt: Date;
}

/**
 * Create a facility account: the `facility`-role login, its `FacilityProfile`
 * and its capabilities, in one transaction. Admin-only by route gating
 * (`requireRole('admin')`, mirroring the admin-gated doctor verification of
 * Phase 1) — there is deliberately no self-serve facility signup (PRD OQ-2:
 * a curated partner list is what protects FR-13 and §8.1.6; `POST /auth/signup`
 * accepts patient/doctor only).
 *
 * Capabilities are required at creation and must match the facility type:
 * matching then *cannot* fail open, because every account this path creates
 * carries its qualification data. `emailVerifiedAt` is set at creation — the
 * admin attests the address out of band, and until the email provider lands
 * (issue #17) an unverified curated partner could never publish prices
 * (`requireVerifiedEmail` gates `POST /facilities/me/prices`).
 *
 * The audit rule for account creation is #43's — `facility.created` records
 * the admin, the facility and the capability count; never the email or any
 * credential (`AuditEvent` carries no PHI or secrets, by construction).
 */
export async function createFacilityAccount(
  actor: auditService.AuditActor,
  input: CreateFacilityInput,
): Promise<CreatedFacility> {
  if (!actor.userId) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');

  const email = (input.email ?? '').trim();
  if (!email) throw new HttpError('EMAIL_REQUIRED', 'An email address is required.');
  const name = (input.name ?? '').trim();
  if (!name) throw new HttpError('FACILITY_NAME_REQUIRED', 'A facility name is required.');
  if (typeof input.password !== 'string' || input.password.length < MIN_FACILITY_PASSWORD_LENGTH) {
    throw new HttpError('PASSWORD_TOO_SHORT', `password must be at least ${MIN_FACILITY_PASSWORD_LENGTH} characters.`);
  }
  const requiredCapability = capabilityForFacilityType(input.type);
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    throw new HttpError('FACILITY_CAPABILITIES_REQUIRED', 'A facility needs at least one capability — unqualified facilities are never eligible.');
  }

  const capabilities: { capabilityType: CapabilityType; detail: string | null }[] = [];
  for (const capability of input.capabilities) {
    if (!capability || typeof capability !== 'object') {
      throw new HttpError('INVALID_CAPABILITY', 'Each capability must be an object.');
    }
    // Declared `string` on the input (callers may arrive from JSON); the
    // comparison against the facility type's capability is the real check.
    const capabilityType = capability.capabilityType as CapabilityType;
    if (capabilityType !== requiredCapability) {
      throw new HttpError(
        'CAPABILITY_TYPE_MISMATCH',
        `A ${input.type} facility can only hold "${requiredCapability}" capabilities, not "${String(capability.capabilityType)}".`);
    }
    const detail = capability.detail === null || capability.detail === undefined
      ? null
      : String(capability.detail).trim();
    if (detail !== null && detail.length > MAX_CAPABILITY_DETAIL_LENGTH) {
      throw new HttpError('INVALID_CAPABILITY', `capability detail must be at most ${MAX_CAPABILITY_DETAIL_LENGTH} characters.`);
    }
    capabilities.push({ capabilityType, detail: detail === '' ? null : detail });
  }

  const passwordHash = await hashPassword(input.password);

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await facilitiesRepo.createFacilityUser(tx, { email, passwordHash, emailVerifiedAt: new Date() });
      const facility = await facilitiesRepo.createFacilityProfile(tx, { userId: user.id, name, type: input.type });
      const rows = await facilitiesRepo.createFacilityCapabilities(tx, facility.id, capabilities);
      await auditService.record(tx, actor, {
        entityType: 'FacilityProfile',
        entityId: facility.id,
        action: 'facility.created',
        fromState: null,
        toState: 'created',
        metadata: {
          userId: user.id,
          facilityType: input.type,
          capabilityCount: rows.length,
        },
      });
      return {
        id: facility.id,
        userId: user.id,
        name: facility.name,
        type: facility.type,
        capabilities: rows.map((row) => ({
          id: row.id,
          capabilityType: row.capabilityType,
          detail: row.detail,
        })),
        createdAt: facility.createdAt,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError('EMAIL_TAKEN', 'An account with this email already exists.');
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';
}

// --- Order verification (issue #71) -------------------------------------
import { issueOrderToken, verifyOrderToken } from '../../../utils/order-token.js';
export { issueOrderToken, verifyOrderToken };

const verifyRateBuckets = new Map<string, { count: number; resetAt: number }>();
const VERIFY_RATE_LIMIT = 30;
const VERIFY_RATE_WINDOW_MS = 60 * 1000;

function checkVerifyRateLimit(facilityId: string): void {
  const now = Date.now();
  const bucket = verifyRateBuckets.get(facilityId);
  if (!bucket || now > bucket.resetAt) {
    verifyRateBuckets.set(facilityId, { count: 1, resetAt: now + VERIFY_RATE_WINDOW_MS });
    return;
  }
  if (bucket.count >= VERIFY_RATE_LIMIT) {
    throw new HttpError('VERIFY_RATE_LIMITED', 'Too many verification attempts.');
  }
  bucket.count += 1;
}

export async function verifyOrder(actor: auditService.AuditActor, token: string) {
  if (!actor.userId) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const facility = await findFacilityProfileByUserId(actor.userId);
  if (!facility) throw new HttpError('FACILITY_PROFILE_REQUIRED', 'No facility profile is linked to this account.');
  checkVerifyRateLimit(facility.id);

  const payload = verifyOrderToken(token);

  if (payload.kind === 'prescription') {
    const { getPrescription } = await import('../../prescriptions/services/index.js');
    const order = await getPrescription(payload.orderId);
    if (facility.type !== 'pharmacy') {
      return { valid: false, reason: 'ineligible_facility' };
    }
    const valid = order.status === 'issued';
    const reason = valid ? null : order.status === 'superseded' ? 'superseded' : order.status === 'fulfilled' ? 'fulfilled' : order.status === 'expired' ? 'expired' : order.status;
    return {
      valid,
      reason,
      order: valid
        ? { id: order.id, type: 'prescription', status: order.status, createdAt: order.createdAt }
        : { id: order.id, type: 'prescription', status: order.status },
    };
  }

  const { getLabOrder } = await import('../../lab-orders/services/index.js');
  const order = await getLabOrder(payload.orderId);
  if (facility.type !== 'lab') {
    return { valid: false, reason: 'ineligible_facility' };
  }
  const valid = order.status === 'issued';
  const reason = valid ? null : order.status === 'superseded' ? 'superseded' : order.status === 'fulfilled' ? 'fulfilled' : order.status === 'expired' ? 'expired' : order.status;
  return {
    valid,
    reason,
    order: valid
      ? { id: order.id, type: 'lab_order', status: order.status, createdAt: order.createdAt }
      : { id: order.id, type: 'lab_order', status: order.status },
  };
}
