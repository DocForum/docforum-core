// users controllers — admin account lifecycle (Phase 8, issue #39).
import type { Request, Response } from 'express';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import * as usersService from '../services';
import { createAdminInviteSchema } from '../validation';
import { getAdminOverview } from '../../../admin-overview-sections';

/**
 * Creates a single-use, expiring admin invite.
 *
 * The raw token is returned in this response **once** — only its hash is
 * stored, so it can't be fetched again — and is never logged. The inviting
 * admin is responsible for passing the link to the invitee out of band;
 * there is no email provider yet (Phase 6, issue #17).
 */
export async function createInvite(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { email } = createAdminInviteSchema.parse(req.body);
  const invite = await usersService.createAdminInvite({ email, invitedByUserId: req.user.id });
  // Logged without the token: the invite link is a credential.
  // eslint-disable-next-line no-console
  console.info(`[users] admin ${req.user.id} created an invite for ${invite.email} (expires ${invite.expiresAt.toISOString()})`);
  res.status(201).json(invite);
}

/**
 * Deactivates an account. There is no `AuditEvent` table yet (see
 * ARCHITECTURE_ESSENTIALS.md known gaps), so — like the login-throttle clear
 * endpoint — the console line is the interim record of who did this.
 */
export async function deactivate(req: Request, res: Response) {
  const userId = getParam(req, 'id');
  const user = await usersService.deactivateUser({ userId });
  // eslint-disable-next-line no-console
  console.info(`[users] admin ${req.user?.id ?? 'unknown'} deactivated user ${userId}`);
  res.status(200).json(user);
}

export async function reactivate(req: Request, res: Response) {
  const userId = getParam(req, 'id');
  const user = await usersService.reactivateUser({ userId });
  // eslint-disable-next-line no-console
  console.info(`[users] admin ${req.user?.id ?? 'unknown'} reactivated user ${userId}`);
  res.status(200).json(user);
}

export async function overview(_req: Request, res: Response) {
  res.status(200).json(await getAdminOverview());
}
