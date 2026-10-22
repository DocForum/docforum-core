import type { Request, Response } from 'express';
import { auditActor } from '../../../middleware/request-id';
import * as adminServices from '../services/admin';
import type { DisputeStatus } from '@prisma/client';

export async function listDisputes(req: Request, res: Response) {
  const statusParam = req.query.status as DisputeStatus | undefined;
  const disputes = await adminServices.listDisputes(statusParam);
  res.status(200).json(disputes);
}

export async function resolveDispute(req: Request, res: Response) {
  const disputeId = req.params.id as string;
  const { resolutionNotes, outcome, status } = req.body || {};
  const actor = auditActor(req);
  const resolvedOutcome = (outcome || status || 'resolved') as string;
  const resolution = await adminServices.resolveDispute(
    disputeId,
    req.user!.id,
    { resolutionNotes, outcome: resolvedOutcome },
    actor,
  );
  res.status(200).json(resolution);
}
