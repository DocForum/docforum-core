// lab-tests controllers
import type { Request, Response } from 'express';
import * as labTestsService from '../services';
import { labTestSearchSchema, labTestCreateSchema, labTestListSchema } from '../validation';

function serialize(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_key, field) => typeof field === 'bigint' ? field.toString() : field));
}

function getParam(req: Request, name: string): string {
  const val = req.params[name];
  if (Array.isArray(val)) return val[0];
  return val;
}

export async function searchLabTests(req: Request, res: Response) {
  const input = labTestSearchSchema.parse(req.query);
  const results = await labTestsService.getLabTestAutocomplete(input.q, input.limit);
  res.json(serialize({ labTests: results }));
}

export async function listLabTests(req: Request, res: Response) {
  const input = labTestListSchema.parse(req.query);
  const { items, nextCursor } = await labTestsService.listLabTestsPaginated(input.cursor, input.limit);
  res.json(serialize({ labTests: items, nextCursor }));
}

export async function createLabTest(req: Request, res: Response) {
  const input = labTestCreateSchema.parse(req.body);
  const test = await labTestsService.createLabTestRecord(input);
  res.status(201).json(serialize(test));
}

export async function getLabTest(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const test = await labTestsService.getLabTestById(id);
  if (!test) {
    res.status(404).json({ message: 'Lab test not found' });
    return;
  }
  res.json(serialize(test));
}