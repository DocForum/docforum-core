// notifications routes. Mounted at `/notifications` in app.ts.
import { Router } from 'express';
import { authenticate } from '../../../middleware/auth';
import * as notificationsController from '../controllers';

export const notificationsRouter = Router();

notificationsRouter.use(authenticate);
notificationsRouter.get('/', notificationsController.list);
notificationsRouter.get('/unread-count', notificationsController.unreadCount);
notificationsRouter.post('/read-all', notificationsController.markAllRead);
notificationsRouter.post('/:id/read', notificationsController.markRead);
// Server-Sent Events stream for the caller's own notifications (issue #97).
notificationsRouter.get('/stream', authenticate, notificationsController.stream);
