import type { Request, Response } from 'express';
import { auditActor } from '../../../middleware/request-id';
import { getParam } from '../../../request-params';
import * as services from '../services';
import { createLabOrderSchema, fulfillLabOrderSchema } from '../validation';

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

export async function getLabOrder(req: Request, res: Response) {
  const order = await services.getLabOrderById(getParam(req, 'id'));
  res.status(200).json(order);
}
