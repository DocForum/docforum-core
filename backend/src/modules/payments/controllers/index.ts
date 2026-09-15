import type { Request, Response } from 'express';
import * as paymentsService from '../services';
import { linkWalletSchema, createPaymentIntentSchema } from '../validation';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';

// BigInt doesn't serialize via JSON.stringify by default — every response
// here that carries one converts to a string explicitly.
function serializeIntent(intent: {
  id: string;
  orderType: string;
  orderId: string;
  status: string;
  patientProfileId: string;
  facilityId: string;
  amountStroops: bigint;
  escrowId: bigint | null;
  stellarTxHash: string | null;
  sorobanContractId: string | null;
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

export async function createIntent(req: Request, res: Response) {
  const input = createPaymentIntentSchema.parse(req.body);
  const intent = await paymentsService.createPaymentIntent(input);
  res.status(201).json(serializeIntent(intent));
}

export async function getIntent(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const intent = await paymentsService.getPaymentIntent(id);
  res.status(200).json(serializeIntent(intent));
}

export async function fundIntent(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const intent = await paymentsService.fundPaymentIntent(id);
  res.status(200).json(serializeIntent(intent));
}

export async function releaseIntent(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const intent = await paymentsService.releasePaymentIntent(id);
  res.status(200).json(serializeIntent(intent));
}

export async function refundIntent(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const intent = await paymentsService.refundPaymentIntent(id);
  res.status(200).json(serializeIntent(intent));
}
