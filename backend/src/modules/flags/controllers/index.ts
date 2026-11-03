import type { Request, Response } from 'express';
import { HttpError } from '../../../http-error';
import { auditActor } from '../../../middleware/request-id';
import * as flagsService from '../services';
import { flagKeySchema, updateFlagSchema } from '../validation';

/** `GET /me/flags` — the caller's evaluated flags, for the frontend. */
export async function myFlags(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const flags = await flagsService.evaluateAllFor({ id: req.user.id, role: req.user.role });
  res.status(200).json({ flags });
}

export async function listFlags(_req: Request, res: Response) {
  res.status(200).json({ items: await flagsService.listFlagsForAdmin() });
}

export async function updateFlag(req: Request, res: Response) {
  const key = flagKeySchema.parse(req.params.key);
  const patch = updateFlagSchema.parse(req.body);
  const flag = await flagsService.updateFlag(auditActor(req), key, patch);
  res.status(200).json(flag);
}
