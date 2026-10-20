import type { Request, Response } from 'express';
import * as ordersService from '../services';
import { consultationSchema, labOrderSchema, prescriptionSchema } from '../validation';
import { getParam } from '../../../request-params';
import { auditActor } from '../../../middleware/request-id';

function serialize(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_key, field) => typeof field === 'bigint' ? field.toString() : field));
}

export async function createConsultation(req: Request, res: Response) {
  const input = consultationSchema.parse(req.body);
  res.status(201).json(serialize(await ordersService.createConsultation(auditActor(req), {
    appointmentId: input.appointmentId, outcome: input.outcome ?? null, notes: input.notes ?? null,
  })));
}
export async function issuePrescription(req: Request, res: Response) {
  const input = prescriptionSchema.parse(req.body);
  const order = await ordersService.issuePrescription(auditActor(req), { ...input, consultationId: getParam(req, 'consultationId') });
  res.status(201).json(serialize(order));
}
export async function issueLabOrder(req: Request, res: Response) {
  const input = labOrderSchema.parse(req.body);
  const order = await ordersService.issueLabOrder(auditActor(req), { ...input, consultationId: getParam(req, 'consultationId') });
  res.status(201).json(serialize(order));
}