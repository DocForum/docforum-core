// Payee trustline check (issue #79). A facility's linked Stellar address
// must be able to hold the asset an escrow pays out in; for an issued asset
// (USDC) that means a trustline to the issuer. Native XLM needs none.
//
// Horizon is read here and nowhere else in this module — contract calls go
// through @docforum/escrow-sdk. The lookup is deliberately narrow: account
// existence + a matching, authorised balance line.
import { HttpError } from '../../../http-error';
import { config, type PaymentAsset } from '../../../config';

export type TrustlineChecker = (account: string, asset: PaymentAsset) => Promise<boolean>;

async function horizonTrustline(account: string, asset: PaymentAsset): Promise<boolean> {
  // Native asset: no trustline exists or is needed.
  if (!asset.issuer) return true;

  let response: Response;
  try {
    response = await fetch(`${config.payments.horizonUrl}/accounts/${encodeURIComponent(account)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Network/timeout — a transport failure, not "no trustline". Failing
    // closed with a distinct code keeps the two distinguishable.
    throw new HttpError(502, 'Could not reach Horizon to check the payee trustline.', 'HORIZON_UNAVAILABLE');
  }
  // A Stellar account that doesn't exist (or was merged) can't hold the
  // asset. That's a real "no trustline" answer, not an outage.
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new HttpError(502, `Horizon trustline check failed (${response.status}).`, 'HORIZON_UNAVAILABLE');
  }

  const body = (await response.json()) as {
    balances?: Array<{ asset_type?: string; asset_code?: string; asset_issuer?: string; is_authorized?: boolean }>;
  };
  return (body.balances ?? []).some(
    (balance) =>
      balance.asset_code === asset.code &&
      balance.asset_issuer === asset.issuer &&
      // An explicitly frozen/unauthorised line can't receive the payout.
      balance.is_authorized !== false,
  );
}

let checker: TrustlineChecker = horizonTrustline;

export function hasTrustline(account: string, asset: PaymentAsset): Promise<boolean> {
  return checker(account, asset);
}

/** Test seam, same convention as setEscrowSdkForTests. `undefined` restores
 * the Horizon-backed checker. Never called by application code. */
export function setTrustlineCheckerForTests(fn: TrustlineChecker | undefined): void {
  checker = fn ?? horizonTrustline;
}
