// notifications routes. Mounted at `/notifications` in app.ts.
import { Router } from 'express';
import { authenticate } from '../../../middleware/auth';
import * as notificationsController from '../controllers';

export const notificationsRouter = Router();

// Server-Sent Events stream for the caller's own notifications (issue #97).
notificationsRouter.get('/stream', authenticate, notificationsController.stream);
