import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import { PROOF_CONTENT_TYPES } from '../services/proof-files';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import { apiRateLimit } from '../../../middleware/rate-limit';
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

// Owning facility, admin, or the order's patient (and active guardian)
// may read a fulfillment record by id (issue #323).
pharmacyOrdersRouter.get('/fulfillments/:id', authenticate, pharmacyOrdersController.getFulfillment);

// Patient (or admin) lists all fulfillment records for one of their orders
// (issue #323). orderType query param is required.
pharmacyOrdersRouter.get(
  '/orders/:orderId/fulfillments',
  authenticate,
  requireRole('patient', 'admin'),
  pharmacyOrdersController.listOrderFulfillments,
);

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
  apiRateLimit,
  authenticate,
  pharmacyOrdersController.getOrderFulfillmentStatus,
);

// Issue #15: facility views its own assigned queue — all FulfillmentRecords
// for the caller's facility profile. `fulfilled` is NEVER directly settable
// via PATCH; it is derived from dispensed items only (§5.3 step 5 / issue
// #73), enforced at the validation layer (updateFulfillmentRecordSchema
// allows only 'in_progress' | 'rejected') and proven in the facility-queue
// integration test. `/facility/queue` before `/:id` to avoid id capture.
pharmacyOrdersRouter.get(
  '/facility/queue',
  apiRateLimit,
  authenticate,
  requireRole('facility'),
  pharmacyOrdersController.listFacilityQueue,
);

// Generic pharmacy order (Order model) creation and fulfillment proof.
// The proof's file is uploaded separately (issue #316, below).
// Legacy `Order` creation bypasses the consultation-scoped, verified-doctor
// issuance path (POST /orders/consultations/...), so it is admin-only.
pharmacyOrdersRouter.post('/', apiRateLimit, authenticate, requireRole('admin'), pharmacyOrdersController.createPharmacyOrder);
pharmacyOrdersRouter.get('/:id', apiRateLimit, authenticate, pharmacyOrdersController.getPharmacyOrder);
pharmacyOrdersRouter.post(
  '/:id/fulfill',
  apiRateLimit,
  authenticate,
  requireRole('facility'),
  pharmacyOrdersController.fulfillPharmacyOrder,
);

// Issue #316: fulfillment proof files, for both legacy pharmacy and lab
// orders (the proof row is shared), mounted at /fulfillment-proofs. The file
// is the raw request body, parsed only after authentication and the role
// check so an anonymous caller can't make the server buffer an upload; the
// parser's limit is the size cap and its errors map to clean 4xx answers.
export const fulfillmentProofsRouter = Router();

const parseProofBody = express.raw({ type: PROOF_CONTENT_TYPES, limit: config.orders.proofMaxBytes });
function proofBody(req: Request, res: Response, next: NextFunction) {
  parseProofBody(req, res, (err?: unknown) => {
    if (!err) return next();
    const status = (err as { status?: number }).status;
    if (status === 413) {
      return next(new HttpError(413, `Proof files may be at most ${config.orders.proofMaxBytes} bytes.`, 'PROOF_TOO_LARGE'));
    }
    return next(new HttpError(400, 'The proof file could not be read.'));
  });
}

fulfillmentProofsRouter.put(
  '/:proofId/attachment',
  apiRateLimit,
  authenticate,
  requireRole('facility'),
  requireVerifiedEmail,
  proofBody,
  pharmacyOrdersController.attachProofFile,
);

// Patient (or active guardian via ?patientProfileId=), the facility that
// recorded the proof, or an admin; anyone else gets 404.
fulfillmentProofsRouter.get(
  '/:proofId/attachment',
  apiRateLimit,
  authenticate,
  pharmacyOrdersController.downloadProofFile,
);
