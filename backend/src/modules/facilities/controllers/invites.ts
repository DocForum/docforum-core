import type { Request, Response } from 'express';
import { HttpError } from '../../../http-error';
import { InviteService } from '../services';

const inviteService = new InviteService();

export async function createInvite(req: Request, res: Response) {
  const facilityId = (req as any).facility!.id;
  const { email, role } = req.body;

  try {
    const { token, tokenHash } = await inviteService.createInvite({ facilityId, email, role });
    res.status(201).json({ token, tokenHash });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ message: err.message, code: err.code });
    }
    throw err;
  }
}

export async function listInvites(req: Request, res: Response) {
  const facilityId = (req as any).facility!.id;
  const invites = await inviteService.listInvites(facilityId);
  res.status(200).json({ invites });
}

export async function revokeInvite(req: Request, res: Response) {
  const facilityId = (req as any).facility!.id;
  const tokenHash = String(req.params.tokenHash);

  try {
    await inviteService.revokeInvite(facilityId, tokenHash);
    res.status(204).send();
  } catch (err: any) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ message: err.message });
    }
    throw err;
  }
}

export async function acceptInvite(req: Request, res: Response) {
  const { token, password } = req.body;

  try {
    const result = await inviteService.acceptInvite(token, password);
    res.status(200).json(result);
  } catch (err: any) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ message: err.message, code: err.code });
    }
    throw err;
  }
}
