import type { PaymentIntentStatus } from '@prisma/client';

const transitions: Record<PaymentIntentStatus, readonly PaymentIntentStatus[]> = {
  created: ['escrowed'],
  escrowed: ['released', 'refunded'],
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
