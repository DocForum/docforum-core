// users controllers — admin account lifecycle (Phase 8, issue #39).
import type { Request, Response } from 'express';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import { auditActor } from '../../../middleware/request-id';
import * as usersService from '../services';
import { createAdminInviteSchema, listAdminInvitesQuerySchema, listAdminUsersQuerySchema } from '../validation';
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
  const invite = await usersService.createAdminInvite({ email, invitedByUserId: req.user.id }, auditActor(req));
  res.status(201).json(invite);
}

/**
 * Deactivates an account. Records an AuditEvent in the deactivation transaction.
 */
export async function deactivate(req: Request, res: Response) {
  const userId = getParam(req, 'id');
  const user = await usersService.deactivateUser({ userId }, auditActor(req));
  res.status(200).json(user);
}

export async function reactivate(req: Request, res: Response) {
  const userId = getParam(req, 'id');
  const user = await usersService.reactivateUser({ userId }, auditActor(req));
  res.status(200).json(user);
}

/** Lists outstanding (or redeemed/expired/revoked) invites. Never returns
 * the token hash — only the row-level facts needed to decide what to
 * revoke (issue #277). */
export async function listInvites(req: Request, res: Response) {
  const query = listAdminInvitesQuerySchema.parse(req.query);
  res.status(200).json(await usersService.listAdminInvites(query));
}

/** Revokes an invite. `409` if it was already redeemed; revoking an
 * already-revoked invite is idempotent (`200`, `alreadyRevoked: true`). */
export async function revokeInvite(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const inviteId = getParam(req, 'id');
  const result = await usersService.revokeAdminInvite(auditActor(req), inviteId);
  // eslint-disable-next-line no-console
   logger.info(`[users] admin ${req.user.id} revoked invite ${inviteId} (alreadyRevoked=${result.alreadyRevoked})`);
  res.status(200).json(result);
}

/** Read-only admin account directory (issue #275). Account-level fields
 * only; deleted accounts are returned with `deleted: true` and a null
 * email rather than their tombstone address. */
export async function listUsers(req: Request, res: Response) {
  const query = listAdminUsersQuerySchema.parse(req.query);
  res.status(200).json(await usersService.listAdminUsers(query));
}

export async function overview(_req: Request, res: Response) {
  res.status(200).json(await getAdminOverview());
}
