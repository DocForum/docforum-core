import type { Request, Response } from 'express';
import * as labTestsService from '../services';

export async function searchLabTests(req: Request, res: Response) {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
  res.status(200).json({ labTests: await labTestsService.searchLabTests({ q, limit }) });
}