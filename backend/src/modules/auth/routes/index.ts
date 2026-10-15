import { Router } from 'express';
import * as authController from '../controllers';

export const authRouter = Router();

authRouter.post('/signup', authController.signup);
authRouter.post('/login', authController.login);
authRouter.post('/refresh', authController.refresh);
authRouter.post('/logout', authController.logout);

// Password reset (Phase 8 #33) — both unauthenticated; possession of the
// emailed single-use token is the credential for the confirm step.
authRouter.post('/password-reset/request', authController.requestPasswordReset);
authRouter.post('/password-reset/confirm', authController.confirmPasswordReset);
