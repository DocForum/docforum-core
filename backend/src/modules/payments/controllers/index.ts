import type { Request, Response } from 'express';
import * as paymentsService from '../services';
import { linkWalletSchema, paymentHistoryQuerySchema } from '../validation';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import { auditActor } from '../../../middleware/request-id';

// BigInt doesn't serialize via JSON.stringify by default — every response
// here that carries one converts to a string explicitly. The prepared XDR
// is deliberately not part of the general intent shape: it's returned by
// the prepare call itself and can be large.
function serializeIntent(intent: {
  id: string;
  prescriptionId: string | null;
  labOrderId: string | null;
  status: string;
  patientProfileId: string;
  facilityId: string;
  amount: bigint;
  assetCode: string;
  tokenContractId: string | null;
  escrowId: bigint | null;
  stellarTxHash: string | null;
  sorobanContractId: string | null;
  preparedTxHash: string | null;
  preparedExpiryLedger: number | null;
  preparedExpiresAt: Date | null;
  refundAfter: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...intent,
    amount: intent.amount.toString(),
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
  res.status(200).json(serializeIntent(intent));
}

export async function prepareIntent(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const prepared = await paymentsService.preparePaymentIntent(auditActor(req), id);
  res.status(200).json({
    ...serializeIntent(prepared.intent),
    // ADR 0005 step 2: unsigned XDR + the ledger after which the
    // transaction/auth entries are no longer valid.
    xdr: prepared.xdr,
    txHash: prepared.txHash,
    expiryLedger: prepared.expiryLedger,
  });
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

// SEP-10 Stellar Web Authentication (issue #77) — see ./sep10.ts.
export { sep10Challenge, sep10Verify } from './sep10';
