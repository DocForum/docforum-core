import { HttpError } from '../../../http-error';

export function resolveEscrowPayee(input: {
  facilityAddress: string;
  mode: 'facility' | 'pooled';
  poolAddress?: string;
  production: boolean;
}): string {
  if (input.mode === 'facility') return input.facilityAddress;
  if (input.production) {
    throw new HttpError(503, 'Pooled payout privacy is a testnet prototype and is disabled in production.');
  }
  if (!input.poolAddress || !/^G[A-Z2-7]{55}$/.test(input.poolAddress)) {
    throw new HttpError(503, 'Pooled payout privacy requires a valid PAYOUT_PRIVACY_POOL_ADDRESS.');
  }
  return input.poolAddress;
}