import { Router } from 'express';
import * as authController from '../controllers';
import { authenticate } from '../../../middleware/auth';

export const authRouter = Router();

authRouter.post('/signup', authController.signup);
authRouter.post('/login', authController.login);
authRouter.post('/refresh', authController.refresh);
authRouter.post('/logout', authController.logout);

// TOTP two-factor auth (Phase 8 #36).
// Setup/enable/status/disable all require a full session; `/verify` is the
// second step of login and takes the mfa_pending token in its *body*, not
// an Authorization header — it is the only route that accepts one.
authRouter.get('/2fa', authenticate, authController.getTwoFactorStatus);
authRouter.post('/2fa/setup', authenticate, authController.setupTwoFactor);
authRouter.post('/2fa/enable', authenticate, authController.enableTwoFactor);
authRouter.post('/2fa/verify', authController.verifyTwoFactor);
authRouter.post('/2fa/disable', authenticate, authController.disableTwoFactor);
