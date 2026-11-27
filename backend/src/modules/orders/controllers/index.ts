import type { Request, Response } from 'express';
import * as ordersService from '../services';
import * as labResultsService from '../services/lab-results';
import * as labResultAcknowledgementsService from '../services/lab-result-acknowledgements';
import {
  attachLabResultQuerySchema,
  consultationSchema,
  labResultDownloadQuerySchema,
  labOrderSchema,
  prescriptionSchema,
  unacknowledgedResultsQuerySchema,
} from '../validation';
import { getParam } from '../../../request-params';
import { HttpError } from '../../../http-error';
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
  const { abnormality } = attachLabResultQuerySchema.parse(req.query);
  const result = await labResultsService.attachLabResult(
    auditActor(req),
    getParam(req, 'labOrderId'),
    { body: req.body, contentType: req.headers['content-type'] },
    abnormality,
  );
  res.status(201).json(result);
}

export async function acknowledgeLabResult(req: Request, res: Response) {
  const acknowledgement = await labResultAcknowledgementsService.acknowledgeLabResult(
    auditActor(req),
    getParam(req, 'labResultId'),
  );
  res.status(200).json(serialize(acknowledgement));
}

export async function listUnacknowledgedLabResults(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { limit } = unacknowledgedResultsQuerySchema.parse(req.query);
  const items = await labResultAcknowledgementsService.listUnacknowledgedResults(
    { ...auditActor(req), role: req.user.role },
    { take: limit },
  );
  res.status(200).json({ items: serialize(items) });
}

export async function downloadLabResult(req: Request, res: Response) {
  const { patientProfileId } = labResultDownloadQuerySchema.parse(req.query);
  const file = await labResultsService.openLabResultFile(
    req.user!,
    getParam(req, 'labOrderId'),
    'GET /orders/lab-orders/:labOrderId/result',
    patientProfileId,
  );
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
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const order = await ordersService.getOrderById(
    getParam(req, 'id'),
    { userId: req.user.id, role: req.user.role },
    req.originalUrl,
  );
  res.status(200).json(serialize(order));
}

export async function listMineOrders(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const result = await ordersService.listMineOrders(req.user.id);
  res.status(200).json(serialize(result));
}
