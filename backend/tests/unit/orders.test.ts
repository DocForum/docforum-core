import { describe, it, expect, beforeEach, vi } from 'vitest';
import { calculateConfirmedSignal, formatOrderResponse } from '../../src/utils/order-utils';
import { confirmOrderReceipt, disputeOrder } from '../../src/modules/orders/services';
import { prisma } from '../../src/db/prisma-client';
import { HttpError } from '../../src/http-error';

vi.mock('../../src/db/prisma-client', () => ({
  prisma: {
    order: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    orderDispute: {
      create: vi.fn(),
    },
    $transaction: vi.fn((cb) => cb(prisma)),
  },
}));

vi.mock('../../src/modules/audit/services', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

describe('Order Utils', () => {
  const windowHours = 72;

  it('calculates confirmed signal correctly when patient explicitly confirmed', () => {
    const order = {
      id: 'ord-1',
      confirmed: true,
      disputed: false,
      fulfilledAt: new Date(),
    };
    expect(calculateConfirmedSignal(order, windowHours)).toBe(true);
  });

  it('calculates confirmed signal correctly when window elapsed with no dispute', () => {
    const pastDate = new Date(Date.now() - 73 * 3600 * 1000);
    const order = {
      id: 'ord-1',
      confirmed: false,
      disputed: false,
      fulfilledAt: pastDate,
    };
    expect(calculateConfirmedSignal(order, windowHours)).toBe(true);
  });

  it('returns false if window has not elapsed and not confirmed', () => {
    const recentDate = new Date(Date.now() - 10 * 3600 * 1000);
    const order = {
      id: 'ord-1',
      confirmed: false,
      disputed: false,
      fulfilledAt: recentDate,
    };
    expect(calculateConfirmedSignal(order, windowHours)).toBe(false);
  });

  it('returns false if order is disputed even if window elapsed', () => {
    const pastDate = new Date(Date.now() - 100 * 3600 * 1000);
    const order = {
      id: 'ord-1',
      confirmed: false,
      disputed: true,
      fulfilledAt: pastDate,
    };
    expect(calculateConfirmedSignal(order, windowHours)).toBe(false);
  });

  it('formats order response with confirmedSignal property', () => {
    const order = {
      id: 'ord-1',
      confirmed: true,
      disputed: false,
      fulfilledAt: new Date(),
    };
    const formatted = formatOrderResponse(order, windowHours);
    expect(formatted.confirmedSignal).toBe(true);
  });
});

describe('Order Service Confirmation & Dispute Mutual Exclusion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws HttpError(404) if order does not exist or does not belong to patient', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue(null);
    await expect(confirmOrderReceipt('ord-999', 'p-1', { userId: 'p-1', role: 'patient' }))
      .rejects.toThrow(HttpError);
  });

  it('throws HttpError(409) if order was already confirmed or disputed when confirming', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: 'ord-1',
      patientId: 'p-1',
      status: 'FULFILLED',
      confirmed: true,
      disputed: false,
    } as any);

    vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 0 });

    await expect(confirmOrderReceipt('ord-1', 'p-1', { userId: 'p-1', role: 'patient' }))
      .rejects.toThrow(HttpError);
  });

  it('throws HttpError(400) if disputing without reason', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: 'ord-1',
      patientId: 'p-1',
      status: 'FULFILLED',
      confirmed: false,
      disputed: false,
    } as any);

    await expect(disputeOrder('ord-1', 'p-1', '  ', { userId: 'p-1', role: 'patient' }))
      .rejects.toThrow(HttpError);
  });
});
