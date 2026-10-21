import type { Request, Response } from 'express';
import * as paymentsService from '../services';
import { linkWalletSchema, paymentHistoryQuerySchema } from '../validation';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import { auditActor } from '../../../middleware/request-id';
import { setVersionEtag } from '../../../middleware/optimistic-concurrency';

// BigInt doesn't serialize via JSON.stringify by default — every response
// here that carries one converts to a string explicitly.
function serializeIntent(intent: {
  id: string;
  prescriptionId: string | null;
  labOrderId: string | null;
  status: string;
  patientProfileId: string;
  facilityId: string;
  amountStroops: bigint;
  escrowId: bigint | null;
  stellarTxHash: string | null;
  sorobanContractId: string | null;
  // Phase 8, issue #49: optimistic-concurrency version, surfaced in the body
  // and as the ETag so a client can precondition its next write.
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...intent,
    amountStroops: intent.amountStroops.toString(),
    escrowId: intent.escrowId?.toString() ?? null,
  };
}

export async function linkWallet(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const facilityId = await paymentsService.getOwnFacilityProfileId(req.user.id);
  const { stellarPublicKey } = linkWalletSchema.parse(req.body);
  const link = await paymentsService.linkWallet(facilityId, stellarPublicKey);
  res.status(200).json(link);
}

export async function getOwnWallet(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const facilityId = await paymentsService.getOwnFacilityProfileId(req.user.id);
  const link = await paymentsService.getWalletLink(facilityId);
  if (!link) throw new HttpError(404, 'No wallet linked yet.');
  res.status(200).json(link);
}

export async function getIntent(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const intent = await paymentsService.getPaymentIntent(id);
  setVersionEtag(res, intent.version);
  res.status(200).json(serializeIntent(intent));
}

/** fund/release/refund keep their own conditional status guard (issue #43) —
 * they are deliberately NOT additionally If-Match-gated (§5.4.4) — but they
 * still publish the resulting version so a client can precondition whatever
 * it does next. */
export async function fundIntent(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const intent = await paymentsService.fundPaymentIntent(auditActor(req), id);
  setVersionEtag(res, intent.version);
  res.status(200).json(serializeIntent(intent));
}

export async function releaseIntent(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const intent = await paymentsService.releasePaymentIntent(auditActor(req), id);
  setVersionEtag(res, intent.version);
  res.status(200).json(serializeIntent(intent));
}

export async function refundIntent(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const intent = await paymentsService.refundPaymentIntent(auditActor(req), id);
  setVersionEtag(res, intent.version);
  res.status(200).json(serializeIntent(intent));
}

export async function listMyPayments(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const filters = paymentHistoryQuerySchema.parse(req.query);
  res.status(200).json(await paymentsService.listMyPayments(req.user.id, filters));
}

export async function listFacilityLedger(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const filters = paymentHistoryQuerySchema.parse(req.query);
  res.status(200).json(await paymentsService.listFacilityPaymentLedger(req.user.id, filters));
}
