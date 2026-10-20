import type { Request, Response } from 'express';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import { auditActor } from '../../../middleware/request-id';
import * as facilitiesService from '../services';
import {
  createPriceVersionSchema,
  eligibleFacilitiesQuerySchema,
  priceFiltersSchema,
} from '../validation';

/** BigInt does not serialize through JSON.stringify — every price response
 * crosses the boundary as a digit string, matching the payments API. */
function serializePrice(price: {
  id: string;
  facilityId: string;
  catalogItemCode: string;
  asset: string;
  amount: bigint;
  effectiveFrom: Date;
  createdAt: Date;
}) {
  return {
    id: price.id,
    facilityId: price.facilityId,
    catalogItemCode: price.catalogItemCode,
    asset: price.asset,
    amountStroops: price.amount.toString(),
    effectiveFrom: price.effectiveFrom.toISOString(),
    createdAt: price.createdAt.toISOString(),
  };
}

function serializeEligible(facility: facilitiesService.EligibleFacility) {
  return {
    facilityId: facility.facilityId,
    name: facility.name,
    type: facility.type,
    priceOnRequest: facility.priceOnRequest,
    price: facility.price
      ? {
          amountStroops: facility.price.amount.toString(),
          effectiveFrom: facility.price.effectiveFrom.toISOString(),
        }
      : null,
  };
}

/** GET /facilities/me/prices — the signed-in facility owner's price list. */
export async function listOwnPrices(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const filters = priceFiltersSchema.parse(req.query);
  const facilityId = await facilitiesService.getOwnFacilityProfileId(req.user.id);
  const prices = await facilitiesService.listPrices(facilityId, filters);
  res.status(200).json({ prices: prices.map(serializePrice) });
}

/** POST /facilities/me/prices — publish a new version of a price. */
export async function createOwnPrice(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const body = createPriceVersionSchema.parse(req.body);
  const facilityId = await facilitiesService.getOwnFacilityProfileId(req.user.id);
  const price = await facilitiesService.createPriceVersion(auditActor(req), facilityId, body);
  res.status(201).json(serializePrice(price));
}

/** GET /facilities/:facilityId/prices — any facility's price list (public). */
export async function listFacilityPrices(req: Request, res: Response) {
  const facilityId = getParam(req, 'facilityId');
  const filters = priceFiltersSchema.parse(req.query);
  const prices = await facilitiesService.listPrices(facilityId, filters);
  res.status(200).json({ prices: prices.map(serializePrice) });
}

/** GET /facilities/eligible — facilities of a type with their current price. */
export async function eligibleFacilities(req: Request, res: Response) {
  const query = eligibleFacilitiesQuerySchema.parse(req.query);
  const at = query.at === undefined ? undefined : new Date(query.at);
  if (at !== undefined && Number.isNaN(at.getTime())) {
    throw new HttpError(400, 'at must be a valid ISO-8601 timestamp.');
  }
  const facilities = await facilitiesService.listEligibleFacilities({ ...query, at });
  res.status(200).json({ facilities: facilities.map(serializeEligible) });
}
