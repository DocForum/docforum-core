import { Router } from 'express';
import { authenticate } from '../../../middleware/auth';
import * as medicationsController from '../controllers';

export const medicationsRouter = Router();

// Authenticated, any role: a doctor picks a drug when prescribing, but a
// patient and a facility also need the same vocabulary when reading an
// order. The catalog is public reference data, not PHI, so there is no
// role restriction — and no unauthenticated listing either.
medicationsRouter.get('/', authenticate, medicationsController.searchMedications);
