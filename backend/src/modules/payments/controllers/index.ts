import type { Request, Response } from 'express';
import * as paymentsService from '../services';
import { walletLinkSchema, createPaymentIntentSchema } from '../validation';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import { auditActor } from '../../../middleware/request-id';

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
  // strict schema: rejects any raw-address field outright.
  const { transaction } = walletLinkSchema.parse(req.body);
  const link = await paymentsService.linkWalletViaSep10(req.user.id, req.user.role, transaction);
  // Patient links always carry the ADR 0005 on-chain privacy notice,
  // verbatim, in the response body — a client cannot render success
  // without it (issue #78 requirement 3). Facility links (payout
  // addresses) don't have a patient privacy dimension.
  res.status(200).json(
    link.ownerType === 'patient'
      ? { ...link, privacyNotice: paymentsService.PATIENT_WALLET_LINK_PRIVACY_NOTICE }
      : link,
  );
}

export async function getOwnWallet(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const link = await paymentsService.getOwnWalletLink(req.user.id, req.user.role);
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
  const intent = await paymentsService.fundPaymentIntent(auditActor(req), id);
  res.status(200).json(serializeIntent(intent));
}

export async function releaseIntent(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const intent = await paymentsService.releasePaymentIntent(auditActor(req), id);
  res.status(200).json(serializeIntent(intent));
}

export async function refundIntent(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const intent = await paymentsService.refundPaymentIntent(auditActor(req), id);
  res.status(200).json(serializeIntent(intent));
}

// SEP-10 Stellar Web Authentication (issue #77) — see ./sep10.ts.
export { sep10Challenge, sep10Verify } from './sep10';
