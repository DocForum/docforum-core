import { once } from 'node:events';
import type { Request, Response } from 'express';
import * as paymentsService from '../services';
import { walletLinkSchema, paymentHistoryQuerySchema, ledgerCsvQuerySchema, adminIntentListQuerySchema } from '../validation';
import { logger as rootLogger } from '../../../logger';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import { auditActor } from '../../../middleware/request-id';
import { setVersionEtag } from '../../../middleware/optimistic-concurrency';

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
  version: number;
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
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  // strict schema: rejects any raw-address field outright.
  const { transaction } = walletLinkSchema.parse(req.body);
  const link = await paymentsService.linkWalletViaSep10(req.user.id, req.user.role, transaction, auditActor(req));
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
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const link = await paymentsService.getOwnWalletLink(req.user.id, req.user.role);
  if (!link) throw new HttpError('WALLET_LINK_NOT_FOUND', 'No wallet linked yet.');
  res.status(200).json(link);
}

/** GET /admin/payments/wallet-links/pending (issue #328): facility payout
 * changes still inside their cool-down, with the address each replaces. */
export async function listPendingWalletLinks(_req: Request, res: Response) {
  res.status(200).json({ items: await paymentsService.listPendingFacilityWalletLinks() });
}

/** GET /admin/payments/fee-sponsor (issue #82): sponsor balance, spend per
 * window and top consumers. */
export async function getFeeSponsorStatus(_req: Request, res: Response) {
  res.status(200).json({
    sponsorPublicKey: process.env.PLATFORM_FEE_SPONSOR_PUBLIC_KEY ?? process.env.PLATFORM_PAYER_PUBLIC_KEY ?? null,
    ...paymentsService.feeSponsorshipSnapshot(),
  });
}

export async function getIntent(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const intent = await paymentsService.getPaymentIntent(id);
  setVersionEtag(res, intent.version);
  res.status(200).json(serializeIntent(intent));
}

// Issue #326: owner-scoped read — patient (payer) or facility (payee).
// Same shape as their history rows plus on-chain references; no admin fields.
function serializeOwnerIntent(intent: Parameters<typeof serializeIntent>[0]) {
  const {
    preparedTxHash: _preparedTxHash,
    preparedExpiryLedger: _preparedExpiryLedger,
    preparedExpiresAt: _preparedExpiresAt,
    ...rest
  } = serializeIntent(intent);
  return rest;
}

export async function getOwnIntent(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const id = getParam(req, 'id');
  const role = req.user.role as 'patient' | 'facility';
  const intent = await paymentsService.getPaymentIntentForOwner(id, req.user.id, role);
  if (!intent) throw new HttpError('PAYMENT_INTENT_NOT_FOUND', 'PaymentIntent not found.');
  setVersionEtag(res, intent.version);
  res.status(200).json(serializeOwnerIntent(intent));
}

// Issue #325: admin list of all payment intents with filters.
export async function listIntents(req: Request, res: Response) {
  const filters = adminIntentListQuerySchema.parse(req.query);
  res.status(200).json(await paymentsService.listAdminPaymentIntents(filters));
}

export async function prepareIntent(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const prepared = await paymentsService.preparePaymentIntent(auditActor(req), id);
  setVersionEtag(res, prepared.intent.version);
  res.status(200).json({
    ...serializeIntent(prepared.intent),
    // ADR 0005 step 2: unsigned XDR + the ledger after which the
    // transaction/auth entries are no longer valid.
    xdr: prepared.xdr,
    txHash: prepared.txHash,
    expiryLedger: prepared.expiryLedger,
  });
}

export async function submitIntent(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const signedXdr = String((req.body as { signedXdr?: unknown })?.signedXdr ?? '');
  if (!signedXdr) throw new HttpError('INVALID_XDR', 'signedXdr is required.');
  const result = await paymentsService.submitPaymentIntent(auditActor(req), id, signedXdr);
  setVersionEtag(res, result.intent.version);
  res.status(200).json({
    ...serializeIntent(result.intent),
    escrowId: result.escrowId?.toString() ?? null,
    stellarTxHash: result.stellarTxHash,
  });
}

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
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const filters = paymentHistoryQuerySchema.parse(req.query);
  res.status(200).json(await paymentsService.listMyPayments(req.user.id, filters));
}

export async function listFacilityLedger(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const filters = paymentHistoryQuerySchema.parse(req.query);
  res.status(200).json(await paymentsService.listFacilityPaymentLedger(req.user.id, filters));
}

/** GET /payments/facility/ledger.csv (issue #329). Streamed: each page is
 * written as it is read, honouring backpressure, and the read loop stops
 * as soon as the client disconnects. */
export async function exportFacilityLedgerCsv(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const filters = ledgerCsvQuerySchema.parse(req.query);
  // Authorises (403 for a non-facility caller) before any CSV header goes out.
  const chunks = await paymentsService.openFacilityLedgerCsv(req.user.id, filters);

  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="facility-ledger.csv"');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    for await (const chunk of chunks) {
      if (res.destroyed) break;
      if (!res.write(chunk)) await once(res, 'drain');
    }
    res.end();
  } catch (err) {
    // Headers are already sent, so the JSON error envelope is impossible.
    // Abort the connection: a truncated download must not look complete.
    (req.log ?? rootLogger).error({ err }, 'Facility ledger CSV export failed mid-stream');
    res.destroy();
  }
}

// SEP-10 Stellar Web Authentication (issue #77) — see ./sep10.ts.
export { sep10Challenge, sep10Verify } from './sep10';

