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
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import * as auditService from '../../audit/services';
import { hashPassword } from '../../auth/services';
import * as facilitiesRepo from '../repositories';
import type { Db } from '../repositories';
import {
  NATIVE_PRICE_ASSET,
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
    throw new HttpError(400, 'type must be "lab" or "pharmacy".');
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
  if (!requirement) throw new HttpError(400, `Unknown order kind: ${String(orderKind)}`);
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
    throw new HttpError(400, `The selected facility must be a ${facilityType} facility.`);
  }
  return { id: facility.id, type: facility.type };
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
export async function listEligibleFacilities(input: {
  type: 'lab' | 'pharmacy';
  catalogItemCode?: string;
  asset?: string;
  at?: Date;
}): Promise<EligibleFacility[]> {
  const at = input.at ?? new Date();
  const facilities = await facilitiesRepo.listQualifiedFacilityProfiles(
    input.type,
    capabilityForFacilityType(input.type),
  );
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
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');

  const email = (input.email ?? '').trim();
  if (!email) throw new HttpError(400, 'An email address is required.');
  const name = (input.name ?? '').trim();
  if (!name) throw new HttpError(400, 'A facility name is required.');
  if (typeof input.password !== 'string' || input.password.length < MIN_FACILITY_PASSWORD_LENGTH) {
    throw new HttpError(400, `password must be at least ${MIN_FACILITY_PASSWORD_LENGTH} characters.`);
  }
  const requiredCapability = capabilityForFacilityType(input.type);
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    throw new HttpError(400, 'A facility needs at least one capability — unqualified facilities are never eligible.');
  }

  const capabilities: { capabilityType: CapabilityType; detail: string | null }[] = [];
  for (const capability of input.capabilities) {
    if (!capability || typeof capability !== 'object') {
      throw new HttpError(400, 'Each capability must be an object.');
    }
    // Declared `string` on the input (callers may arrive from JSON); the
    // comparison against the facility type's capability is the real check.
    const capabilityType = capability.capabilityType as CapabilityType;
    if (capabilityType !== requiredCapability) {
      throw new HttpError(
        400,
        `A ${input.type} facility can only hold "${requiredCapability}" capabilities, not "${String(capability.capabilityType)}".`,
      );
    }
    const detail = capability.detail === null || capability.detail === undefined
      ? null
      : String(capability.detail).trim();
    if (detail !== null && detail.length > MAX_CAPABILITY_DETAIL_LENGTH) {
      throw new HttpError(400, `capability detail must be at most ${MAX_CAPABILITY_DETAIL_LENGTH} characters.`);
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
      throw new HttpError(409, 'An account with this email already exists.');
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';
}
