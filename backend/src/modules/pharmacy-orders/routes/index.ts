import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import * as pharmacyOrdersController from '../controllers';

export const pharmacyOrdersRouter = Router();

// Patient (or admin) routes order items to a facility — one record per
// route; the partial-fulfillment split is the same call with only the
// remaining items. Verified email required (Phase 8, issue #34): routing
// drives payment release eligibility (ARCHITECTURE.md §5.3).
pharmacyOrdersRouter.post(
  '/fulfillments',
  authenticate,
  requireRole('patient', 'admin'),
  requireVerifiedEmail,
  pharmacyOrdersController.createFulfillment,
);

// Owning facility, admin, or the patient whose order the record belongs to
// (issue #323 — Phase 4 link now exists: Prescription/LabOrder.patientProfileId).
pharmacyOrdersRouter.get('/fulfillments/:id', authenticate, pharmacyOrdersController.getFulfillment);

// Facility-only writes to its own records (hard rule 5 — the ownership
// check lives in the service). `fulfilled` is never settable here: it is
// derived from the record's dispensed items (issue #73).
pharmacyOrdersRouter.patch(
  '/fulfillments/:id',
  authenticate,
  requireRole('facility'),
  requireVerifiedEmail,
  pharmacyOrdersController.updateFulfillmentRecord,
);
pharmacyOrdersRouter.patch(
  '/fulfillments/:id/items/:itemId',
  authenticate,
  requireRole('facility'),
  requireVerifiedEmail,
  pharmacyOrdersController.updateFulfillmentItem,
);

// Derived order-level fulfillment state (issued | partially_fulfilled |
// fulfilled) — computed from item rows, never a hand-set flag.
pharmacyOrdersRouter.get(
  '/orders/:orderId/fulfillment-status',
  authenticate,
  pharmacyOrdersController.getOrderFulfillmentStatus,
);

// Patient / facility / admin: list all fulfillment records for one order.
// orderType query param disambiguates prescription vs. lab_order (issue #323).
pharmacyOrdersRouter.get(
  '/orders/:orderId/fulfillments',
  authenticate,
  pharmacyOrdersController.listFulfillmentsForOrder,
);

// Generic pharmacy order (Order model) creation and fulfillment proof.
pharmacyOrdersRouter.post('/', authenticate, pharmacyOrdersController.createPharmacyOrder);
pharmacyOrdersRouter.get('/:id', authenticate, pharmacyOrdersController.getPharmacyOrder);
pharmacyOrdersRouter.post(
  '/:id/fulfill',
  authenticate,
  requireRole('facility'),
  pharmacyOrdersController.fulfillPharmacyOrder,
);
