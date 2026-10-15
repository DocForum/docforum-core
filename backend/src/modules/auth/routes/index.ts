import { Router } from 'express';
import * as authController from '../controllers';
import { authenticate, requireRole } from '../../../middleware/auth';

export const authRouter = Router();

authRouter.post('/signup', authController.signup);
authRouter.post('/login', authController.login);
authRouter.post('/refresh', authController.refresh);
authRouter.post('/logout', authController.logout);

// Session management (Phase 8 #38). Note the ordering: `DELETE /sessions`
// (revoke all others) is registered before `DELETE /sessions/:id` — Express
// matches in registration order, and `/sessions` must not be read as an id.
authRouter.get('/sessions', authenticate, authController.listSessions);
authRouter.delete('/sessions', authenticate, authController.revokeOtherSessions);
authRouter.delete('/sessions/:id', authenticate, authController.revokeSession);

/** Admin routes for the auth module, mounted at `/admin` in app.ts. Session
 * administration acts on *another* user, so it doesn't belong under
 * `/auth`. */
export const adminAuthRouter = Router();

adminAuthRouter.delete('/users/:id/sessions', authenticate, requireRole('admin'), authController.revokeUserSessions);
