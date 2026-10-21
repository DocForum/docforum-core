import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as labTestsController from '../controllers';

export const labTestsRouter = Router();

// Public autocomplete endpoint (no auth required for search)
labTestsRouter.get('/lab-tests', labTestsController.searchLabTests);

// Admin-only endpoints for managing the catalog
labTestsRouter.get('/admin/lab-tests', authenticate, requireRole('admin'), labTestsController.listLabTests);
labTestsRouter.post('/admin/lab-tests', authenticate, requireRole('admin'), labTestsController.createLabTest);
labTestsRouter.get('/admin/lab-tests/:id', authenticate, requireRole('admin'), labTestsController.getLabTest);