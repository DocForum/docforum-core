import { Router } from 'express';
import * as authController from '../controllers';

export const authRouter = Router();

authRouter.post('/signup', authController.signup);
// Phase 8, issue #39: admin invite redemption (the admin invite itself is
// issued by `POST /admin/invites` in the users module).
authRouter.post('/signup-with-invite', authController.signupWithInvite);
authRouter.post('/login', authController.login);
authRouter.post('/refresh', authController.refresh);
authRouter.post('/logout', authController.logout);
