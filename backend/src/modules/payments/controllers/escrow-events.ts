import type { Request, Response } from 'express';
import { z } from 'zod';
import { listEscrowEvents } from '../services/escrow-events';

const querySchema = z.object({
  state: z.enum(['pending', 'matched', 'unmatched']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export async function listEscrowEventsController(req: Request, res: Response) {
  const query = querySchema.parse(req.query);
  res.status(200).json(await listEscrowEvents(query.limit, query.state));
}
