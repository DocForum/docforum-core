import type { Request, Response } from 'express';
import { auditActor } from '../../../middleware/request-id';
import { getParam } from '../../../request-params';
import * as adminServices from '../services/admin';
import { listDisputesQuerySchema, resolveDisputeSchema } from '../validation';

export async function listDisputes(req: Request, res: Response) {
  const { status } = listDisputesQuerySchema.parse(req.query);
  const disputes = await adminServices.listDisputes(status);
  res.status(200).json(disputes);
}

export async function resolveDispute(req: Request, res: Response) {
  const { resolutionNotes, outcome } = resolveDisputeSchema.parse(req.body);
  const actor = auditActor(req);
  const resolution = await adminServices.resolveDispute(
    getParam(req, 'id'),
    req.user!.id,
    { resolutionNotes, outcome },
    actor,
  );
  res.status(200).json(resolution);
}
