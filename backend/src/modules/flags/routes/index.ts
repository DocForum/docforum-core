import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as flagsController from '../controllers';

// Mounted at /me: the caller's own evaluated flags (any authenticated role).
export const meFlagsRouter = Router();
meFlagsRouter.get('/flags', authenticate, flagsController.myFlags);

// Mounted at /admin: list and change flags. Every change is audited.
export const adminFlagsRouter = Router();
adminFlagsRouter.use(authenticate, requireRole('admin'));
adminFlagsRouter.get('/feature-flags', flagsController.listFlags);
adminFlagsRouter.patch('/feature-flags/:key', flagsController.updateFlag);
