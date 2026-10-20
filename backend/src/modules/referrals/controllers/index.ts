import type { Request, Response } from 'express';
import * as referralsService from '../services';
import {
  acceptReferralSchema,
  adminCancelSchema,
  adminQueueQuerySchema,
  adminReassignSchema,
  createReferralBatchSchema,
  createReferralSchema,
} from '../validation';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import { auditActor } from '../../../middleware/request-id';

export async function create(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const input = createReferralSchema.parse(req.body);
  const referral = await referralsService.createReferral(req.user.id, input);
  res.status(201).json(referral);
}

export async function createBatch(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const sourceConsultationId = getParam(req, 'consultationId');
  const { targets } = createReferralBatchSchema.parse(req.body);
  const referrals = await referralsService.createReferralBatch(req.user.id, sourceConsultationId, targets);
  res.status(201).json(referrals);
}

export async function accept(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { availabilitySlotId } = acceptReferralSchema.parse(req.body);
  const referral = await referralsService.acceptReferral(
    auditActor(req),
    getParam(req, 'referralId'),
    availabilitySlotId,
  );
  res.status(200).json(referral);
}

export async function decline(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const referral = await referralsService.declineReferral(auditActor(req), getParam(req, 'referralId'));
  res.status(200).json(referral);
}

export async function listMine(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const referrals = await referralsService.listMine(req.user.id);
  // Grouped by source consultation for the patient's "one visit, several
  // referrals" view (issue #66): independent lifecycles, presented as the
  // bundle they were born as.
  const grouped = referrals.reduce<Record<string, typeof referrals>>((acc, referral) => {
    (acc[referral.sourceConsultationId] ??= []).push(referral);
    return acc;
  }, {});
  res.status(200).json({ referrals, groupedByConsultation: grouped });
}

export async function listCreated(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const referrals = await referralsService.listCreated(req.user.id);
  res.status(200).json(referrals);
}

export async function adminQueue(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const filters = adminQueueQuerySchema.parse(req.query);
  const rows = await referralsService.adminListReferrals(req.user.id, filters);
  res.status(200).json(rows);
}

export async function adminReassign(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const input = adminReassignSchema.parse(req.body);
  const referral = await referralsService.adminReassign(
    auditActor(req),
    getParam(req, 'referralId'),
    input,
  );
  res.status(200).json(referral);
}

export async function adminCancel(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const input = adminCancelSchema.parse(req.body);
  const referral = await referralsService.adminCancel(auditActor(req), getParam(req, 'referralId'), input);
  res.status(200).json(referral);
}

export async function auditTrail(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const events = await referralsService.listAuditEvents(getParam(req, 'referralId'));
  res.status(200).json(events);
}
