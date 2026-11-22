import type { Request, Response } from 'express';
import * as prescriptionsService from '../services';

export async function getPrescription(req: Request, res: Response) {
  const id = req.params.id as string;
  const viewer = { userId: req.user!.id, role: req.user!.role as string };
  const { prescription } = await prescriptionsService.getPrescriptionForViewer(id, viewer, req.path);
  res.status(200).json(prescription);
}
