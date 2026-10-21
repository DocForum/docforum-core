// prescriptions controllers
import type { Request, Response } from 'express';
import * as prescriptionsService from '../services';

function serialize(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_key, field) => typeof field === 'bigint' ? field.toString() : field));
}

function getParam(req: Request, name: string): string {
  const val = req.params[name];
  if (Array.isArray(val)) return val[0];
  return val;
}

export async function getPrescription(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const prescription = await prescriptionsService.getPrescriptionById(id);
  if (!prescription) {
    res.status(404).json({ message: 'Prescription not found' });
    return;
  }
  res.json(serialize(prescription));
}

export async function listPrescriptions(_req: Request, res: Response) {
  // For now, we'll return all prescriptions for the patient
  // In a real implementation, we'd filter by the authenticated patient
  res.json(serialize({ prescriptions: [], nextCursor: null }));
}