import type { Request, Response } from 'express';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import * as prescriptionsService from '../services';

/** `GET /prescriptions/:id` (issue #314). */
export async function getPrescription(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const prescription = await prescriptionsService.getPrescriptionForViewer(
    getParam(req, 'id'),
    { userId: req.user.id, role: req.user.role },
    req.originalUrl,
  );
  res.status(200).json(prescription);
}
