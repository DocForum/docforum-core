// order-tokens services — other modules must only import from here,
// never from repositories/ directly. See AGENTS.md "Non-negotiable rules".
import { prisma } from '../../../db/prisma-client';
import * as orderTokensRepo from '../repositories';
import crypto from 'crypto';

const TOKEN_SECRET = process.env.ORDER_TOKEN_SECRET;
if (!TOKEN_SECRET) {
  throw new Error('ORDER_TOKEN_SECRET environment variable is required');
}

const TOKEN_EXPIRY_DAYS = parseInt(process.env.ORDER_TOKEN_EXPIRY_DAYS || '365', 10);

export interface OrderTokenPayload {
  orderType: 'prescription' | 'lab_order';
  orderId: string;
  version: number;
  facilityId: string; // The facility the order is assigned to
}

export interface VerificationResult {
  valid: boolean;
  orderType?: 'prescription' | 'lab_order';
  orderId?: string;
  facilityId?: string;
  version?: number;
  status?: string;
  superseded?: boolean;
  fulfilled?: boolean;
  expired?: boolean;
  error?: string;
}

function generateToken(payload: OrderTokenPayload): string {
  const data = `${payload.orderType}|${payload.orderId}|${payload.version}|${payload.facilityId}|${Date.now()}`;
  const hmac = crypto.createHmac('sha256', getTokenSecret());
  hmac.update(data);
  return hmac.digest('hex');
}

function getTokenSecret(): crypto.KeyLike {
  if (!TOKEN_SECRET) {
    throw new Error('ORDER_TOKEN_SECRET environment variable is required');
  }
  return TOKEN_SECRET;
}

export async function issueOrderToken(input: {
  orderType: 'prescription' | 'lab_order';
  orderId: string;
  facilityId: string;
}): Promise<{ token: string; version: number; expiresAt: Date }> {
  // Get the latest version for this order
  const existing = await orderTokensRepo.findOrderTokenByOrder(input.orderType, input.orderId);
  const version = (existing?.version ?? 0) + 1;
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const payload: OrderTokenPayload = {
    orderType: input.orderType,
    orderId: input.orderId,
    version,
    facilityId: input.facilityId,
  };

  const token = generateToken(payload);

  await orderTokensRepo.createOrderToken(prisma, {
    orderType: input.orderType,
    orderId: input.orderId,
    token,
    version,
    expiresAt,
  });

  return { token, version, expiresAt };
}

export async function verifyOrderToken(
  token: string,
  verifyingFacilityId: string,
): Promise<VerificationResult> {
  // Look up the token
  const orderToken = await orderTokensRepo.findOrderTokenByToken(token);
  if (!orderToken) {
    return { valid: false, error: 'Invalid token' };
  }

  // Check expiry
  if (orderToken.expiresAt && orderToken.expiresAt < new Date()) {
    return { valid: false, error: 'Token expired' };
  }

  // Check if the facility is eligible (matches the order's facility)
  if (orderToken.orderType === 'prescription') {
    const prescription = await prisma.prescription.findUnique({
      where: { id: orderToken.orderId },
      select: { facilityProfileId: true, status: true, supersedesPrescriptionId: true },
    });
    if (!prescription) {
      return { valid: false, error: 'Order not found' };
    }
    if (prescription.facilityProfileId !== verifyingFacilityId) {
      return { valid: false, error: 'Facility not eligible for this order' };
    }
    if (prescription.status === 'superseded') {
      return { valid: false, error: 'Order has been superseded', superseded: true };
    }
    if (prescription.status === 'fulfilled') {
      return { valid: false, error: 'Order already fulfilled', fulfilled: true };
    }
    if (prescription.status === 'expired') {
      return { valid: false, error: 'Order expired', expired: true };
    }

    return {
      valid: true,
      orderType: 'prescription',
      orderId: orderToken.orderId,
      facilityId: prescription.facilityProfileId,
      version: orderToken.version,
      status: prescription.status,
    };
  } else if (orderToken.orderType === 'lab_order') {
    const labOrder = await prisma.labOrder.findUnique({
      where: { id: orderToken.orderId },
      select: { facilityProfileId: true, status: true, supersedesLabOrderId: true },
    });
    if (!labOrder) {
      return { valid: false, error: 'Order not found' };
    }
    if (labOrder.facilityProfileId !== verifyingFacilityId) {
      return { valid: false, error: 'Facility not eligible for this order' };
    }
    if (labOrder.status === 'superseded') {
      return { valid: false, error: 'Order has been superseded', superseded: true };
    }
    if (labOrder.status === 'fulfilled') {
      return { valid: false, error: 'Order already fulfilled', fulfilled: true };
    }
    if (labOrder.status === 'expired') {
      return { valid: false, error: 'Order expired', expired: true };
    }

    return {
      valid: true,
      orderType: 'lab_order',
      orderId: orderToken.orderId,
      facilityId: labOrder.facilityProfileId,
      version: orderToken.version,
      status: labOrder.status,
    };
  }

  return { valid: false, error: 'Unknown order type' };
}

export async function revokeOrderToken(_orderType: 'prescription' | 'lab_order', _orderId: string) {
  // When an order is superseded, we don't delete the token but the verification
  // will fail because the order status will be 'superseded'
  // Optionally, we could mark tokens as revoked
  return true;
}

export async function getOrderTokenByOrder(orderType: 'prescription' | 'lab_order', orderId: string) {
  return orderTokensRepo.findOrderTokenByOrder(orderType, orderId);
}