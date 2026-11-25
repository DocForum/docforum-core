import { Router } from 'express';
import { authenticate } from '../../../middleware/auth';
import * as controllers from '../controllers';

export const labTestsRouter = Router();
labTestsRouter.get('/', authenticate, controllers.searchLabTests);