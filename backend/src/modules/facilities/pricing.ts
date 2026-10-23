// Pure pricing helpers for the facilities module — no database, no HTTP.
// Everything that decides *which* price applies lives here so it can be
// unit-tested without Postgres and reused by the payments snapshot path.
import { HttpError } from '../../http-error';

/**
 * Asset identifier for native XLM quotes. Stellar's native asset has no
 * issuer; v1 PaymentIntents are native-XLM only (see ARCHITECTURE.md §4), so
 * a facility price without an explicit asset is quoted in native XLM.
 */
export const NATIVE_PRICE_ASSET = 'native';

/** A stored price version, narrowed to what selection needs. */
export interface PriceVersion {
  effectiveFrom: Date;
  amount: bigint;
}

/**
 * The version in force at `at`: the latest row whose `effectiveFrom` is not
 * after it. Rows are expected newest-first (as the repositories order them),
 * but this does not depend on that.
 *
 * A price effective exactly at `at` counts — a facility that publishes a new
 * price at 12:00 charges it from 12:00, not from the next instant.
 */
export function selectCurrentPrice<T extends PriceVersion>(versions: readonly T[], at: Date): T | undefined {
  let current: T | undefined;
  for (const version of versions) {
    if (version.effectiveFrom.getTime() > at.getTime()) continue;
    if (!current || version.effectiveFrom.getTime() > current.effectiveFrom.getTime()) {
      current = version;
    }
  }
  return current;
}

/** Parses an `effectiveFrom` body value; defaults to "now". */
export function parseEffectiveFrom(value: string | Date | undefined, now = new Date()): Date {
  if (value === undefined) return now;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, 'effectiveFrom must be a valid ISO-8601 timestamp.');
  }
  return date;
}

/**
 * The error for "this facility has not published a price for that item".
 * 422 with a stable `PRICE_ON_REQUEST` code so clients can render the
 * documented "price on request" state instead of treating it as a failure to
 * charge.
 */
export function priceOnRequestError(catalogItemCode: string): HttpError {
  return new HttpError(
    422,
    `This facility has no price for '${catalogItemCode}' yet — price on request.`,
    'PRICE_ON_REQUEST',
  );
}
