import { Router } from 'express';
import * as controller from '../controllers';

export const notificationsRouter = Router();
notificationsRouter.post('/webhooks/:channel', controller.webhook);
