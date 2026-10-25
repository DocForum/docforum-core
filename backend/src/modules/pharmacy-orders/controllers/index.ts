import type { Request, Response } from 'express';
import { auditActor } from '../../../middleware/request-id';
import * as services from '../services';

export async function createPharmacyOrder(req: Request, res: Response) {
  const { patientProfileId, prescribingDoctorId, details } = req.body || {};
  const order = await services.createPharmacyOrder({
    patientProfileId,
    prescribingDoctorId,
    details,
  });
  res.status(201).json(order);
}

export async function fulfillPharmacyOrder(req: Request, res: Response) {
  const id = req.params.id as string;
  const { referenceNumber, attachment, notes } = req.body || {};
  const actor = auditActor(req);

  const order = await services.fulfillPharmacyOrder(
    id,
    req.user!.id,
    { referenceNumber, attachment, notes },
    actor,
  );
  res.status(200).json(order);
}

export async function getPharmacyOrder(req: Request, res: Response) {
  const id = req.params.id as string;
  const order = await services.getPharmacyOrderById(id);
  res.status(200).json(order);
}
