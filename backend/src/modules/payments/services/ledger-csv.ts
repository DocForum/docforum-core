// CSV export of the facility payout ledger (issue #329). Same owner scope,
// same filters (`status`, `from`, `to`) and same ordering as
// GET /payments/facility/ledger, so the CSV rows are exactly the JSON rows.
//
// Never buffered: rows are read in keyset pages of LEDGER_CSV_PAGE_SIZE
// through the same repository query as the JSON endpoint and yielded one
// page at a time, so memory stays bounded however wide the date range is.
import type { PaymentIntent, PaymentIntentStatus } from '@prisma/client';
import { config } from '../../../config';
import { csvRow, formatSmallestUnit } from '../../../utils/csv';
import * as paymentsRepo from '../repositories';

export const LEDGER_CSV_PAGE_SIZE = 500;

export const LEDGER_CSV_HEADER = [
  'date',
  'intent_id',
  'status',
  'asset',
  'amount_smallest_unit',
  'amount',
  'transaction_hash',
] as const;

export interface LedgerCsvFilters {
  status?: PaymentIntentStatus;
  from?: Date;
  to?: Date;
}

function decimalsFor(assetCode: string): number | undefined {
  return config.payments.assets.find((asset) => asset.code === assetCode)?.decimals;
}

function ledgerCsvLine(payment: PaymentIntent): string {
  const decimals = decimalsFor(payment.assetCode);
  return csvRow([
    payment.createdAt.toISOString(),
    payment.id,
    payment.status,
    payment.assetCode,
    payment.amount.toString(),
    // An asset no longer in this environment's allowlist has no known
    // scale; leave the decimal column empty rather than guess one.
    decimals === undefined ? null : formatSmallestUnit(payment.amount, decimals),
    payment.stellarTxHash,
  ]);
}

/** Yields the header, then one CSV chunk per page of ledger rows. The
 * caller has already resolved (and therefore authorised) `facilityId`. */
export async function* facilityLedgerCsvChunks(
  facilityId: string,
  filters: LedgerCsvFilters,
  pageSize = LEDGER_CSV_PAGE_SIZE,
): AsyncGenerator<string> {
  yield csvRow(LEDGER_CSV_HEADER);
  let before: { createdAt: Date; id: string } | undefined;
  for (;;) {
    const rows = await paymentsRepo.findPaymentHistoryPage(
      { facilityId },
      { status: filters.status, from: filters.from, to: filters.to, before, take: pageSize },
    );
    if (rows.length === 0) return;
    yield rows.map(ledgerCsvLine).join('');
    if (rows.length < pageSize) return;
    const last = rows[rows.length - 1]!;
    before = { createdAt: last.createdAt, id: last.id };
  }
}
