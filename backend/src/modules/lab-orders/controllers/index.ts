import type { Request, Response } from 'express';
import { auditActor } from '../../../middleware/request-id';
import * as services from '../services';

export async function createLabOrder(req: Request, res: Response) {
  const { patientProfileId, orderingDoctorId, details } = req.body || {};
  const order = await services.createLabOrder({
    patientProfileId,
    orderingDoctorId,
    details,
  });
  res.status(201).json(order);
}

export async function fulfillLabOrder(req: Request, res: Response) {
  const id = req.params.id as string;
  const { referenceNumber, attachment, notes } = req.body || {};
  const actor = auditActor(req);

  const order = await services.fulfillLabOrder(
    id,
    req.user!.id,
    { referenceNumber, attachment, notes },
    actor,
  );
  res.status(200).json(order);
}

export async function getLabOrder(req: Request, res: Response) {
  const id = req.params.id as string;
  const order = await services.getLabOrderById(id);
  res.status(200).json(order);
}
