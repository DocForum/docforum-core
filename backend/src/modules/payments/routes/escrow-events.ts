import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import { listEscrowEventsController } from '../controllers/escrow-events';

export const escrowEventsRouter = Router();
escrowEventsRouter.get('/escrow-events', authenticate, requireRole('admin'), listEscrowEventsController);
