// users routes — admin account lifecycle (Phase 8, issue #39). Mounted at
// `/admin` in app.ts; every route is admin-only.
import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as usersController from '../controllers';

export const adminRouter = Router();

adminRouter.use(authenticate, requireRole('admin'));

// Invite a new admin. Returns the invite token once — only its hash is
// stored. Redemption happens at `POST /auth/signup-with-invite` (auth's
// module: it owns sessions), which calls this module's service to do the
// invite part.
adminRouter.post('/invites', usersController.createInvite);

// Soft deactivation: refuses only for the last active admin, and never
// deletes clinical or payment records (nothing is keyed to this flag).
adminRouter.patch('/users/:id/deactivate', usersController.deactivate);
adminRouter.patch('/users/:id/reactivate', usersController.reactivate);
