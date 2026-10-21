import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as medicationsController from '../controllers';

export const medicationsRouter = Router();

// Public autocomplete endpoint (no auth required for search)
medicationsRouter.get('/medications', medicationsController.searchMedications);

// Admin-only endpoints for managing the catalog
medicationsRouter.get('/admin/medications', authenticate, requireRole('admin'), medicationsController.listMedications);
medicationsRouter.post('/admin/medications', authenticate, requireRole('admin'), medicationsController.createMedication);
medicationsRouter.get('/admin/medications/:id', authenticate, requireRole('admin'), medicationsController.getMedication);