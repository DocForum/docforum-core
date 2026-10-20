import type { Request, Response } from 'express';
import { auditActor } from '../../../middleware/request-id';
import * as services from '../services';

export async function confirmReceipt(req: Request, res: Response) {
  const id = req.params.id as string;
  const actor = auditActor(req);
  const order = await services.confirmOrderReceipt(id, req.user!.id, actor);
  res.status(200).json(order);
}

export async function disputeOrder(req: Request, res: Response) {
  const id = req.params.id as string;
  const { reason } = req.body;
  const actor = auditActor(req);
  const order = await services.disputeOrder(id, req.user!.id, reason, actor);
  res.status(200).json(order);
}

export async function getOrder(req: Request, res: Response) {
  const id = req.params.id as string;
  const order = await services.getOrderById(id);
  res.status(200).json(order);
}
