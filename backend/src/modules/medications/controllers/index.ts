// medications controllers
import type { Request, Response } from 'express';
import * as medicationsService from '../services';
import { medicationSearchSchema, medicationCreateSchema, medicationListSchema } from '../validation';

function serialize(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_key, field) => typeof field === 'bigint' ? field.toString() : field));
}

function getParam(req: Request, name: string): string {
  const val = req.params[name];
  if (Array.isArray(val)) return val[0];
  return val;
}

export async function searchMedications(req: Request, res: Response) {
  const input = medicationSearchSchema.parse(req.query);
  const results = await medicationsService.getMedicationAutocomplete(input.q, input.limit);
  res.json(serialize({ medications: results }));
}

export async function listMedications(req: Request, res: Response) {
  const input = medicationListSchema.parse(req.query);
  const { items, nextCursor } = await medicationsService.listMedicationsPaginated(input.cursor, input.limit);
  res.json(serialize({ medications: items, nextCursor }));
}

export async function createMedication(req: Request, res: Response) {
  const input = medicationCreateSchema.parse(req.body);
  const medication = await medicationsService.createMedicationRecord(input);
  res.status(201).json(serialize(medication));
}

export async function getMedication(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const medication = await medicationsService.getMedicationById(id);
  if (!medication) {
    res.status(404).json({ message: 'Medication not found' });
    return;
  }
  res.json(serialize(medication));
}