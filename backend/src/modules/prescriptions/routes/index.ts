import { Router } from 'express';
import { authenticate } from '../../../middleware/auth';
import * as controllers from '../controllers';

export const prescriptionsRouter = Router();

// Issue #314: detail read with RBAC inside the service (prescriber, patient/guardian, facilities, admin).
prescriptionsRouter.get('/:id', authenticate, controllers.getPrescription);
