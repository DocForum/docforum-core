import type { Request, Response } from 'express';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import * as pharmacyOrdersService from '../services';
import {
  createFulfillmentSchema,
  orderFulfillmentStatusQuerySchema,
  updateFulfillmentItemSchema,
  updateFulfillmentRecordSchema,
} from '../validation';

function requireUser(req: Request): pharmacyOrdersService.Requester {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  return { userId: req.user.id, role: req.user.role };
}

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
