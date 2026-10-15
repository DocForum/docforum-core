import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as authController from '../controllers';

export const authRouter = Router();

authRouter.post('/signup', authController.signup);
// Phase 8, issue #39: admin invite redemption (the admin invite itself is
// issued by `POST /admin/invites` in the users module).
authRouter.post('/signup-with-invite', authController.signupWithInvite);
authRouter.post('/login', authController.login);
authRouter.post('/refresh', authController.refresh);
authRouter.post('/logout', authController.logout);

// Phase 8, issue #34 — email verification.
authRouter.post('/verify-email', authController.verifyEmail);
authRouter.post('/verify-email/resend', authenticate, authController.resendVerificationEmail);

// Phase 8, issue #35 — admin escape hatch for a lock a legitimate user is
// stuck behind (a documented script would do too, but an endpoint is easier
// to use from the ops console and easier to test).
authRouter.post('/login-attempts/clear', authenticate, requireRole('admin'), authController.clearLoginAttempts);
