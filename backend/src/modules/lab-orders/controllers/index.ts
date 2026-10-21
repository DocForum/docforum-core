// lab-orders controllers
import type { Request, Response } from 'express';
import * as labOrdersService from '../services';
import { labOrderResultSchema } from '../validation';
import { auditActor } from '../../../middleware/request-id';

function serialize(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_key, field) => typeof field === 'bigint' ? field.toString() : field));
}

function getParam(req: Request, name: string): string {
  const val = req.params[name];
  if (Array.isArray(val)) return val[0];
  return val;
}

export async function getLabOrder(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const labOrder = await labOrdersService.getLabOrderById(id);
  if (!labOrder) {
    res.status(404).json({ message: 'Lab order not found' });
    return;
  }
  res.json(serialize(labOrder));
}

export async function listLabOrders(_req: Request, res: Response) {
  // For now, return empty - would filter by authenticated patient/doctor
  res.json(serialize({ labOrders: [], nextCursor: null }));
}

export async function attachLabResult(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const body = labOrderResultSchema.parse(req.body);
  const actor = auditActor(req);
  const result = await labOrdersService.attachLabResult({
    labOrderId: id,
    fulfillingFacilityId: actor.userId!, // Facility user ID - would need to map to facility profile
    resultFileUrl: body.resultFileUrl,
    summary: body.summary,
    abnormalityFlag: body.abnormalityFlag,
  });
  res.status(201).json(serialize(result));
}

export async function acknowledgeLabResult(req: Request, res: Response) {
  const id = getParam(req, 'id'); // labResultId
  const actor = auditActor(req);
  const acknowledgement = await labOrdersService.acknowledgeLabResult(actor, id);
  res.json(serialize(acknowledgement));
}

export async function getUnacknowledgedResults(req: Request, res: Response) {
  const actor = auditActor(req);
  if (actor.role !== 'doctor') {
    res.status(403).json({ message: 'Only doctors can view unacknowledged results' });
    return;
  }
  const results = await labOrdersService.getUnacknowledgedLabResults(actor.userId!);
  res.json(serialize({ acknowledgements: results }));
}