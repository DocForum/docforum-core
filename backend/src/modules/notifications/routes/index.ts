import { Router } from 'express';
import { authenticate } from '../../../middleware/auth';
import * as notificationsController from '../controllers';

export const notificationsRouter = Router();

notificationsRouter.use(authenticate);
notificationsRouter.get('/', notificationsController.list);
notificationsRouter.get('/unread-count', notificationsController.unreadCount);
notificationsRouter.post('/read-all', notificationsController.markAllRead);
notificationsRouter.post('/:id/read', notificationsController.markRead);
