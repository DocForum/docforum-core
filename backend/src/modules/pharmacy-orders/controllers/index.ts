import type { Request, Response } from 'express';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import { auditActor } from '../../../middleware/request-id';
import * as pharmacyOrdersService from '../services';
import * as proofsService from '../services/proofs';
import {
  createFulfillmentSchema,
  createPharmacyOrderSchema,
  fulfillPharmacyOrderSchema,
  listOrderFulfillmentsQuerySchema,
  orderFulfillmentStatusQuerySchema,
  proofDownloadQuerySchema,
  updateFulfillmentItemSchema,
  updateFulfillmentRecordSchema,
} from '../validation';

function requireUser(req: Request): pharmacyOrdersService.Requester {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  return { userId: req.user.id, role: req.user.role };
}

// --- Issue #73: item-level (partial) fulfillment -------------------------

export async function createFulfillment(req: Request, res: Response) {
  const input = createFulfillmentSchema.parse(req.body);
  const record = await pharmacyOrdersService.createFulfillment(input, requireUser(req));
  res.status(201).json(record);
}

export async function getFulfillment(req: Request, res: Response) {
  const record = await pharmacyOrdersService.getFulfillment(getParam(req, 'id'), requireUser(req));
  res.status(200).json(record);
}

export async function updateFulfillmentRecord(req: Request, res: Response) {
  const input = updateFulfillmentRecordSchema.parse(req.body);
  const record = await pharmacyOrdersService.updateFulfillmentRecord(
    getParam(req, 'id'),
    input,
    requireUser(req),
  );
  res.status(200).json(record);
}

export async function updateFulfillmentItem(req: Request, res: Response) {
  const input = updateFulfillmentItemSchema.parse(req.body);
  const result = await pharmacyOrdersService.updateFulfillmentItem(
    getParam(req, 'id'),
    getParam(req, 'itemId'),
    input,
    requireUser(req),
  );
  res.status(200).json(result);
}

export async function getOrderFulfillmentStatus(req: Request, res: Response) {
  const { orderType } = orderFulfillmentStatusQuerySchema.parse(req.query);
  const summary = await pharmacyOrdersService.getOrderFulfillmentSummary(
    orderType,
    getParam(req, 'orderId'),
  );
  res.status(200).json(summary);
}

/** GET /pharmacy-orders/orders/:orderId/fulfillments — patient lists
 * all fulfillment records for their own order (issue #323). */
export async function listOrderFulfillments(req: Request, res: Response) {
  const { orderType } = listOrderFulfillmentsQuerySchema.parse(req.query);
  const records = await pharmacyOrdersService.listFulfillmentRecordsForOrder(
    orderType,
    getParam(req, 'orderId'),
    requireUser(req),
  );
  res.status(200).json({ records });
}

// --- Pharmacy order creation / fulfillment proof ------------------------

export async function createPharmacyOrder(req: Request, res: Response) {
  const input = createPharmacyOrderSchema.parse(req.body);
  const order = await pharmacyOrdersService.createPharmacyOrder(input);
  res.status(201).json(order);
}

export async function fulfillPharmacyOrder(req: Request, res: Response) {
  const input = fulfillPharmacyOrderSchema.parse(req.body);
  const actor = auditActor(req);
  const order = await pharmacyOrdersService.fulfillPharmacyOrder(
    getParam(req, 'id'),
    req.user!.id,
    input,
    actor,
  );
  res.status(200).json(order);
}

export async function getPharmacyOrder(req: Request, res: Response) {
  const order = await pharmacyOrdersService.getPharmacyOrderById(getParam(req, 'id'));
  res.status(200).json(order);
}

/** GET /pharmacy-orders/facility/queue — the facility's own assigned queue.
 * Hard rule 5: only the facility's own records; fulfilled is never directly
 * settable (issue #15). */
export async function listFacilityQueue(req: Request, res: Response) {
  const records = await pharmacyOrdersService.listFacilityQueue(requireUser(req));
  res.status(200).json({ records });
}

// --- Fulfillment proof files (issue #316) --------------------------------

/** PUT /fulfillment-proofs/:proofId/attachment — raw-body upload by the
 * facility that recorded the proof. */
export async function attachProofFile(req: Request, res: Response) {
  const attachment = await proofsService.attachProofFile(auditActor(req), getParam(req, 'proofId'), {
    body: req.body,
    contentType: req.headers['content-type'],
  });
  res.status(201).json(attachment);
}

/** GET /fulfillment-proofs/:proofId/attachment — access-checked download. */
export async function downloadProofFile(req: Request, res: Response) {
  const { patientProfileId } = proofDownloadQuerySchema.parse(req.query);
  const file = await proofsService.openProofFile(
    { id: requireUser(req).userId, role: requireUser(req).role },
    getParam(req, 'proofId'),
    'GET /fulfillment-proofs/:proofId/attachment',
    patientProfileId,
  );
  res.set({
    'Content-Type': file.contentType,
    'Content-Length': String(file.body.length),
    'Content-Disposition': `attachment; filename="${file.filename}"`,
    // Never cached by a browser or shared proxy, never sniffed into
    // something renderable.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.status(200).send(file.body);
}
