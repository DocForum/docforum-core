import type { Request, Response } from 'express';
import * as patientsService from '../services';
import { deleteAccountSchema } from '../validation';
import { HttpError } from '../../../http-error';
import { LoginThrottledError } from '../../auth/services';

/** Phase 8, issue #41 — account deletion (docs/adr/0007). 204 whether this
 * call anonymised the account or it was already deleted (idempotent). */
export async function deleteMe(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { password } = deleteAccountSchema.parse(req.body ?? {});
  try {
    await patientsService.deleteMyAccount(req.user.id, password, req.ip);
  } catch (err) {
    // Password re-confirmation shares the login throttle (issue #35).
    if (err instanceof LoginThrottledError) res.set('Retry-After', String(err.retryAfterSeconds));
    throw err;
  }
  res.status(204).send();
}
