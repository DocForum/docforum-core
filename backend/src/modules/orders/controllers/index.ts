import type { Request, Response } from 'express';
import * as ordersService from '../services';
import * as labResultsService from '../services/lab-results';
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

export async function confirmReceipt(req: Request, res: Response) {
  const id = req.params.id as string;
  const actor = auditActor(req);
  const order = await ordersService.confirmOrderReceipt(id, req.user!.id, actor);
  res.status(200).json(serialize(order));
}

export async function disputeOrder(req: Request, res: Response) {
  const id = req.params.id as string;
  const { reason } = req.body || {};
  const actor = auditActor(req);
  const order = await ordersService.disputeOrder(id, req.user!.id, reason, actor);
  res.status(200).json(serialize(order));
}

export async function attachLabResult(req: Request, res: Response) {
  const result = await labResultsService.attachLabResult(auditActor(req), getParam(req, 'labOrderId'), {
    body: req.body, contentType: req.headers['content-type'],
  });
  res.status(201).json(result);
}

export async function downloadLabResult(req: Request, res: Response) {
  const file = await labResultsService.openLabResultFile(req.user!, getParam(req, 'labOrderId'), req.originalUrl);
  res.set({
    'Content-Type': file.contentType,
    'Content-Length': String(file.body.length),
    'Content-Disposition': `attachment; filename="${file.filename}"`,
    // Medical data: never cached by a browser or shared proxy, never sniffed
    // into something renderable.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.status(200).send(file.body);
}

export async function getOrder(req: Request, res: Response) {
  const id = req.params.id as string;
  const order = await ordersService.getOrderById(id);
  res.status(200).json(serialize(order));
}
