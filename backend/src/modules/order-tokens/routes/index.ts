import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as orderTokensController from '../controllers';

export const orderTokensRouter = Router();

// Facility verifies an order token (rate limited)
orderTokensRouter.post('/facilities/me/verify-order', authenticate, requireRole('facility'), orderTokensController.verifyOrderToken);

// Doctor/admin issues an order token (for the order they just created)
orderTokensRouter.post('/order-tokens', authenticate, requireRole('doctor', 'admin'), orderTokensController.issueOrderToken);