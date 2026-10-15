import { Router } from 'express';
import { authenticate } from '../../../middleware/auth';
import * as authController from '../controllers';

export const authRouter = Router();

authRouter.post('/signup', authController.signup);
authRouter.post('/login', authController.login);
authRouter.post('/refresh', authController.refresh);
authRouter.post('/logout', authController.logout);

// Phase 8, issue #34 — email verification.
authRouter.post('/verify-email', authController.verifyEmail);
authRouter.post('/verify-email/resend', authenticate, authController.resendVerificationEmail);
