import type { Request, Response } from 'express';
import * as medicationsService from '../services';
import { searchMedicationsQuerySchema } from '../validation';

/**
 * `GET /medications?q=` — autocomplete for the controlled vocabulary
 * (issue #69). Returns the exact variant fields (strength/form/route) plus
 * the display name an issued prescription item would snapshot.
 */
export async function searchMedications(req: Request, res: Response) {
  const query = searchMedicationsQuerySchema.parse(req.query);
  const medications = await medicationsService.searchMedications(query);
  res.status(200).json({ medications });
}
