// SEP-10 controllers (issue #77) — thin HTTP layer over services/sep10.
// Route-level `authenticate`/`requireVerifiedEmail` middleware runs first
// (see routes/index.ts); these handlers only parse input, call the
// service, and shape the response.
import type { Request, Response } from 'express';
import * as paymentsService from '../services';
import { sep10ChallengeQuerySchema, sep10VerifySchema } from '../validation';
import { HttpError } from '../../../http-error';

export async function sep10Challenge(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { account } = sep10ChallengeQuerySchema.parse(req.query);
  const challenge = await paymentsService.createSep10Challenge(req.user.id, account);
  res.status(200).json(challenge);
}

export async function sep10Verify(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { transaction } = sep10VerifySchema.parse(req.body);
  const result = await paymentsService.verifySep10Challenge(req.user.id, transaction);
  res.status(200).json({ ...result, userId: req.user.id });
}
