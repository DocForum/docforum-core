import type { Request, Response } from 'express';
import { auditActor } from '../../../middleware/request-id';
import * as adminServices from '../services/admin';

export async function listDisputes(req: Request, res: Response) {
  const disputes = await adminServices.listDisputes();
  res.status(200).json(disputes);
}

export async function resolveDispute(req: Request, res: Response) {
  const disputeId = req.params.id as string;
  const { resolutionNotes, status } = req.body;
  const actor = auditActor(req);
  const resolution = await adminServices.resolveDispute(
    disputeId,
    req.user!.id,
    resolutionNotes,
    status,
    actor
  );
  res.status(200).json(resolution);
}
