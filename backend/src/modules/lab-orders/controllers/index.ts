import type { Request, Response } from 'express';
import { auditActor } from '../../../middleware/request-id';
import { getParam } from '../../../request-params';
import * as services from '../services';
import { createLabOrderSchema, fulfillLabOrderSchema } from '../validation';
import { HttpError } from '../../../http-error';

export async function createLabOrder(req: Request, res: Response) {
  const input = createLabOrderSchema.parse(req.body);
  const order = await services.createLabOrder(input);
  res.status(201).json(order);
}

export async function fulfillLabOrder(req: Request, res: Response) {
  const input = fulfillLabOrderSchema.parse(req.body);
  const actor = auditActor(req);
  const order = await services.fulfillLabOrder(
    getParam(req, 'id'),
    req.user!.id,
    input,
    actor,
  );
  res.status(200).json(order);
}

/** `GET /lab-orders/:id` (issue #314). */
export async function getLabOrder(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const order = await services.getLabOrderForViewer(
    getParam(req, 'id'),
    { userId: req.user.id, role: req.user.role },
    req.originalUrl,
  );
  res.status(200).json(order);
}
