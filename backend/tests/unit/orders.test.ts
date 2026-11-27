import { describe, expect, it } from 'vitest';
import { computeConfirmedSignal, formatOrderResponse } from '../../src/utils/order-utils';

describe('orders unit tests', () => {
  describe('computeConfirmedSignal', () => {
    it('returns true if order is explicitly confirmed', () => {
      const signal = computeConfirmedSignal({
        confirmed: true,
        status: 'fulfilled',
        disputed: false,
        fulfilledAt: new Date(),
      }, 72);
      expect(signal).toBe(true);
    });

    it('returns false if order is issued and not confirmed', () => {
      const signal = computeConfirmedSignal({
        confirmed: false,
        status: 'issued',
        disputed: false,
        fulfilledAt: null,
      }, 72);
      expect(signal).toBe(false);
    });

    it('returns false if order is fulfilled, not confirmed, and window has NOT elapsed', () => {
      const signal = computeConfirmedSignal({
        confirmed: false,
        status: 'fulfilled',
        disputed: false,
        fulfilledAt: new Date(Date.now() - 10 * 60 * 60 * 1000), // 10 hrs ago
      }, 72);
      expect(signal).toBe(false);
    });

    it('returns true if order is fulfilled, not disputed, and window HAS elapsed', () => {
      const signal = computeConfirmedSignal({
        confirmed: false,
        status: 'fulfilled',
        disputed: false,
        fulfilledAt: new Date(Date.now() - 73 * 60 * 60 * 1000), // 73 hrs ago
      }, 72);
      expect(signal).toBe(true);
    });

    it('returns false if window elapsed BUT order is disputed', () => {
      const signal = computeConfirmedSignal({
        confirmed: false,
        status: 'fulfilled',
        disputed: true,
        fulfilledAt: new Date(Date.now() - 100 * 60 * 60 * 1000), // 100 hrs ago
      }, 72);
      expect(signal).toBe(false);
    });

    it('formats order response with confirmedSignal property', () => {
      const order = {
        id: 'ord-1',
        confirmed: true,
        status: 'fulfilled',
        disputed: false,
        fulfilledAt: new Date(),
      };
      const formatted = formatOrderResponse(order, 72);
      expect(formatted.confirmedSignal).toBe(true);
    });
  });
});
