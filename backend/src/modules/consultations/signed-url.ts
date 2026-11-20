import crypto from 'node:crypto';
import { config } from '../../config';

/**
 * Short-lived signed URLs for consultation attachments (issue #62).
 *
 * The token is an HMAC over the attachment id and its expiry. Minting one
 * requires an authenticated, authorised request against the thread; the
 * signed endpoint itself only checks the signature and the clock, so a
 * forwarded URL works until it expires and never longer. This is deliberately
 * not an S3 presigned URL: the storage interface has no presign operation, and
 * keeping the byte read behind this API means the object key is never exposed.
 */
export function signAttachmentToken(attachmentId: string, expiresAtMs: number): string {
  return crypto
    .createHmac('sha256', config.consultations.attachmentUrlSecret)
    .update(`${attachmentId}.${expiresAtMs}`)
    .digest('base64url');
}

export function verifyAttachmentToken(
  attachmentId: string,
  expiresAtMs: number,
  signature: string,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(expiresAtMs) || now > expiresAtMs) return false;
  const expected = signAttachmentToken(attachmentId, expiresAtMs);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
