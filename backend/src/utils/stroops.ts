// Stroop (smallest-unit) amount parsing shared by the facilities price list
// and the payments module. One implementation so "what counts as a valid
// amount" cannot drift between a price row and the intent priced from it.
//
// Amounts are integers in an asset's smallest unit — for Stellar's 7-decimal
// assets that is stroops. The contract's `amount` is an `i128`, so the upper
// bound here is `i128::MAX`; anything above it could never be escrowed.
import { HttpError } from '../http-error';

/** Number of decimal places for a Stellar payment asset (7 → stroops). */
export const PAYMENT_ASSET_DECIMALS = 7;

/** `i128::MAX` — the contract stores `amount: i128`, so no amount above this
 * can be funded even if it fits in a Postgres BIGINT. */
export const MAX_STROOPS = (1n << 127n) - 1n;

/**
 * Parses a positive integer stroop amount from an API body (string) or an
 * internal value (bigint/number), rejecting decimals, zero, negatives and
 * values the contract could not escrow.
 *
 * Strings are required to be plain digits: `"1.5"`, `"1e7"`, `"-1"` and
 * `" 1"` are all rejected rather than silently coerced, so a client cannot
 * lose precision by sending a decimal string.
 */
export function parseStroopsAmount(
  value: bigint | string | number,
  field = 'amount',
): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'string') {
    if (!/^[0-9]+$/.test(value)) {
      throw new HttpError(400, `${field} must be a positive integer string of smallest units.`);
    }
    parsed = BigInt(value);
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new HttpError(400, `${field} must be a safe integer; send it as a string instead.`);
    }
    parsed = BigInt(value);
  } else {
    throw new HttpError(400, `${field} is required.`);
  }

  if (parsed <= 0n) {
    throw new HttpError(400, `${field} must be positive.`);
  }
  if (parsed > MAX_STROOPS) {
    // The asset has 7 decimals; an amount is already in those smallest units,
    // so "validating against the asset's decimals" here means refusing
    // fractional input above and an amount the contract cannot hold here.
    throw new HttpError(400, `${field} exceeds the representable range for a ${PAYMENT_ASSET_DECIMALS}-decimal asset.`);
  }
  return parsed;
}
