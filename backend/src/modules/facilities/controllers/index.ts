import type { Request, Response } from 'express';
import * as facilitiesService from '../services';
import { eligibleFacilitiesQuerySchema } from '../validation';

export async function listEligibleFacilities(req: Request, res: Response) {
  const query = eligibleFacilitiesQuerySchema.parse(req.query);
  const facilities = await facilitiesService.listEligibleFacilities(query);
  res.status(200).json(facilities);
}
