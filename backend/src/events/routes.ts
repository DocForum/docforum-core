import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth';
import { listDeadLetterEvents } from './index';

export const outboxAdminRouter = Router();

outboxAdminRouter.get('/dead-letters', authenticate, requireRole('admin'), async (req, res) => {
	const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(req.query);
	const items = await listDeadLetterEvents(query.limit);
	res.status(200).json({ items });
});