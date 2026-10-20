import { Router } from 'express';
import { requireAuth, requireRole } from '../../auth/middleware';
import { FacilityPriceController } from '../controllers/FacilityPriceController';

const router = Router();
const controller = new FacilityPriceController();

// Facility owners manage their price list
router.get('/:facilityId/prices', requireAuth, controller.list);
router.post('/:facilityId/prices', requireAuth, requireRole('facility_owner', 'admin'), controller.create);
router.patch('/:facilityId/prices/:priceId', requireAuth, requireRole('facility_owner', 'admin'), controller.update);

// Patient-facing: current price per eligible facility
router.get('/eligible', requireAuth, controller.eligible);

export default router;
