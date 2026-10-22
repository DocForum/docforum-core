import { config } from '../config';

export function computeConfirmedSignal(
  order: {
    confirmed: boolean;
    status: string;
    disputed: boolean;
    fulfilledAt: Date | null;
  },
  windowHours: number = config.orders.confirmationWindowHours,
): boolean {
  if (order.confirmed) return true;
  if (order.status === 'fulfilled' && !order.disputed && order.fulfilledAt) {
    const elapsedMs = Date.now() - new Date(order.fulfilledAt).getTime();
    const windowMs = windowHours * 60 * 60 * 1000;
    if (elapsedMs >= windowMs) {
      return true;
    }
  }
  return false;
}

export const calculateConfirmedSignal = computeConfirmedSignal;

export function formatOrderResponse<T extends {
  confirmed: boolean;
  status: string;
  disputed: boolean;
  fulfilledAt: Date | null;
}>(order: T, windowHours?: number) {
  return {
    ...order,
    confirmedSignal: computeConfirmedSignal(order, windowHours),
  };
}
