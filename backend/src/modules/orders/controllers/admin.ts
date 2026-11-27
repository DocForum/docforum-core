import type { Request, Response } from 'express';
import { auditActor } from '../../../middleware/request-id';
import * as adminServices from '../services/admin';
import { listDisputesQuerySchema, resolveDisputeSchema } from '../validation';
import type { DisputeOutcome } from '@prisma/client';

export async function listDisputes(req: Request, res: Response) {
  const query = listDisputesQuerySchema.parse(req.query);
  const result = await adminServices.listDisputes({
    status: query.status,
    cursor: query.cursor,
    limit: query.limit,
  });
  res.status(200).json(result);
}

export async function resolveDispute(req: Request, res: Response) {
  const disputeId = req.params.id as string;
  const body = resolveDisputeSchema.parse(req.body ?? {});
  const actor = auditActor(req);
  const resolution = await adminServices.resolveDispute(
    disputeId,
    req.user!.id,
    { resolutionNotes: body.resolutionNotes, outcome: body.outcome as DisputeOutcome },
    actor,
  );
  res.status(200).json(resolution);
}
