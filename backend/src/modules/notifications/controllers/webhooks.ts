import type { Request, Response } from 'express';
import { timingSafeEqual, createHmac } from 'node:crypto';
import { config } from '../../../config';
import { normalizedPhone } from '../../../config/sections/notifications';
import * as notificationsRepo from '../repositories';

function validSignature(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const supplied = String(req.header('x-docforum-signature') ?? '');
  const timestamp = String(req.header('x-docforum-timestamp') ?? '');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${JSON.stringify(req.body)}`).digest('hex');
  return supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) && Math.abs(Date.now() - Number(timestamp)) < 300_000;
}

export async function postmark(req: Request, res: Response) {
  if (!validSignature(req, config.notifications.email.webhookSecret)) return res.status(401).json({ message: 'Invalid webhook signature.' });
  const body = req.body as { RecordType?: string; MessageID?: string; Email?: string; Description?: string };
  const status = body.RecordType === 'Bounce' ? 'bounced' : 'complained';
  if (body.MessageID) await notificationsRepo.updateDeliveryByProviderId(body.MessageID, status, body.Description);
  return res.status(204).send();
}

export async function twilio(req: Request, res: Response) {
  if (!validSignature(req, config.notifications.sms.webhookSecret)) return res.status(401).json({ message: 'Invalid webhook signature.' });
  const body = req.body as { MessageSid?: string; MessageStatus?: string; From?: string; Body?: string };
  const message = body.Body?.trim().toUpperCase();
  if (body.From && ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(message ?? '')) await notificationsRepo.setSmsConsentForPhone(normalizedPhone(body.From), 'opted_out');
  if (body.From && ['START', 'UNSTOP'].includes(message ?? '')) await notificationsRepo.setSmsConsentForPhone(normalizedPhone(body.From), 'opted_in');
  if (body.MessageSid && body.MessageStatus) {
    const status = body.MessageStatus === 'delivered' ? 'delivered' : body.MessageStatus === 'failed' ? 'failed' : 'sent';
    await notificationsRepo.updateDeliveryByProviderId(body.MessageSid, status);
  }
  return res.status(204).send();
}
