import crypto from 'node:crypto';
import { HttpError } from '../http-error';

const ORDER_TOKEN_SECRET = process.env.ORDER_TOKEN_SECRET ?? process.env.JWT_SECRET ?? 'docforum-order-token-dev-secret';

export interface OrderTokenPayload {
  orderId: string;
  kind: 'prescription' | 'lab_order';
  version: number;
  issuedAt: string;
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function issueOrderToken(payload: Omit<OrderTokenPayload, 'issuedAt'> & { issuedAt?: string }): string {
  const full: OrderTokenPayload = {
    orderId: payload.orderId,
    kind: payload.kind,
    version: payload.version,
    issuedAt: payload.issuedAt ?? new Date().toISOString(),
  };
  const body = b64url(JSON.stringify(full));
  const sig = b64url(crypto.createHmac('sha256', ORDER_TOKEN_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyOrderToken(token: string): OrderTokenPayload {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new HttpError('INVALID_ORDER_TOKEN', 'Invalid order token.');
  }
  const [body, sig] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', ORDER_TOKEN_SECRET).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new HttpError('INVALID_ORDER_TOKEN', 'Invalid order token signature.');
  }
  let payload: OrderTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OrderTokenPayload;
  } catch {
    throw new HttpError('INVALID_ORDER_TOKEN', 'Invalid order token payload.');
  }
  if (!payload.orderId || !payload.kind || typeof payload.version !== 'number') {
    throw new HttpError('INVALID_ORDER_TOKEN', 'Invalid order token payload.');
  }
  return payload;
}
