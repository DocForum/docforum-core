import type { PaymentIntentStatus } from '@prisma/client';

const transitions: Record<PaymentIntentStatus, readonly PaymentIntentStatus[]> = {
  // ADR 0005 steps 2-4: a created intent can either be funded from the
  // platform payer (custodial v1) or prepared for the patient's signature.
  // Expiry rolls a prepared transaction back to `created`.
  created: ['awaiting_signature', 'escrowed', 'funding'],
  // Issue #24: `funding` is claimed by one request before the on-chain
  // call, so a crash or a failed call can never leave two requests
  // creating escrows. A failed call is released back to `created`; a
  // successful one commits `escrowed`. A crash in between is resolved by
  // reconcile-escrows.ts, not by retrying the call.
  funding: ['escrowed', 'created'],
  awaiting_signature: ['created', 'submitting'],
  // The submit half of ADR 0005 is not built yet (issue #80 covers prepare),
  // so `submitting` is reserved but never written by this service today.
  submitting: ['escrowed'],
  // `failed` is the terminal reconcile state (issue #83): the contract says
  // the escrow is not funded (already released/refunded elsewhere, e.g. the
  // timeout-refund path), so retrying release can never succeed. The intent
  // stays visible for an admin to reconcile against the chain.
  escrowed: ['released', 'refunded', 'failed'],
  released: [],
  refunded: [],
  failed: [],
};

/** Returns the next state or null when a requested lifecycle transition is illegal. */
export function transitionPaymentIntentStatus(
  current: PaymentIntentStatus,
  requested: PaymentIntentStatus,
): PaymentIntentStatus | null {
  return transitions[current].includes(requested) ? requested : null;
}
