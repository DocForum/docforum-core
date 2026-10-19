import type { Request, Response } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import { requireFacility, requireFacilityOwner } from '../../../middleware/facility-guard';
import { FacilityService } from '../services';
import { HttpError } from '../../../http-error';

const facilityService = new FacilityService();

export async function listMembers(req: Request, res: Response) {
  const facilityId = (req as any).facility!.id;
  const members = await facilityService.getMembers(facilityId);
  res.status(200).json({ members });
}

export async function removeMember(req: Request, res: Response) {
  const facilityId = (req as any).facility!.id;
  const { userId } = req.params;
  const removerId = req.user!.id;

  try {
    await facilityService.removeMember(facilityId, userId, removerId);
    res.status(204).send();
  } catch (err: any) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ message: err.message });
    }
    throw err;
  }
}