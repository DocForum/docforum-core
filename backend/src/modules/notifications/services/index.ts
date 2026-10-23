import { config } from '../../../config';
import { formatMessage, resolveLocale } from '../../../i18n';
import { HttpError } from '../../../http-error';
import { config } from '../../../config';
import * as repo from '../repositories';
import { emailProvider, smsProvider } from '../providers';
import { renderNotification, type NotificationPayload, type NotificationType } from '../templates';

export { renderNotification } from '../templates';
export type { NotificationPayload, NotificationType } from '../templates';

export interface NotificationMessage { to: string; subject: string; body: string; }
export interface NotificationChannel { send(message: NotificationMessage): Promise<void>; }
export const consoleNotificationChannel: NotificationChannel = {
  async send(message) { console.log(`[notifications] ${message.to}\n${message.subject}\n${message.body}`); },
};
let channel: NotificationChannel = consoleNotificationChannel;
export function setNotificationChannel(next: NotificationChannel): NotificationChannel { const previous = channel; channel = next; return previous; }
export async function send(message: NotificationMessage): Promise<void> { await channel.send(message); }
export async function sendPasswordResetLink(input: { email: string; token: string; expiresAt: Date; locale?: string }): Promise<void> {
  const link = `${config.appBaseUrl}/reset-password?token=${encodeURIComponent(input.token)}`;
  const minutes = Math.round((input.expiresAt.getTime() - Date.now()) / 60_000);
  const locale = resolveLocale(input.locale);
  await send({ to: input.email, subject: formatMessage(locale, 'notifications.passwordReset.subject'), body: formatMessage(locale, 'notifications.passwordReset.body', { minutes, link }) });
}

function startOfUtcDay(): Date { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); }
function normalizePhone(phone: string): string {
  const normalized = phone.trim().replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new HttpError(400, 'Phone numbers must be in E.164 format.');
  return normalized;
}

export async function sendNotification(input: { userId: string; channel: 'email' | 'sms'; type: NotificationType; recipient: string; payload: NotificationPayload }) {
  const template = renderNotification(input.type, input.payload);
  const recipient = input.channel === 'sms' ? normalizePhone(input.recipient) : input.recipient.trim().toLowerCase();
  if (input.channel === 'sms') {
    const consent = await repo.findSmsConsent(recipient);
    if (!consent || consent.status === 'opted_out') throw new HttpError(409, 'SMS consent is not active.', 'SMS_NOT_CONSENTED');
    if (await repo.countSmsForUserSince(input.userId, startOfUtcDay()) >= config.notifications.smsDailyCap) throw new HttpError(429, 'The daily SMS notification limit has been reached.', 'SMS_DAILY_LIMIT');
  }
  const record = await repo.createNotification({ userId: input.userId, channel: input.channel, type: input.type, recipient, subject: input.channel === 'email' ? template.subject : null, textBody: input.channel === 'email' ? template.text : template.sms, htmlBody: input.channel === 'email' ? template.html : null });
  try {
    const result = input.channel === 'email' ? await emailProvider.send({ to: recipient, subject: template.subject, text: template.text, html: template.html }) : await smsProvider.send({ to: recipient, text: template.sms });
    await repo.updateNotification(record.id, { status: 'sent', providerMessageId: result.providerMessageId, sentAt: new Date() });
    return { ...record, providerMessageId: result.providerMessageId, status: 'sent' };
  } catch (error) {
    await repo.updateNotification(record.id, { status: 'failed', failedAt: new Date() });
    throw error;
  }
}

export async function recordDelivery(channel: 'email' | 'sms', rawBody: string, signature: string | undefined) {
  const provider = channel === 'email' ? emailProvider : smsProvider;
  if (!provider.verifyWebhook(rawBody, signature)) throw new HttpError(401, 'Invalid notification webhook signature.');
  if (channel === 'sms') {
    const inbound = JSON.parse(rawBody) as { Body?: string; From?: string };
    const keyword = inbound.Body?.trim().toUpperCase();
    if (inbound.From && (keyword === 'STOP' || keyword === 'START')) {
      await updateSmsConsent(inbound.From, keyword === 'STOP' ? 'opted_out' : 'opted_in', 'provider_keyword');
    }
  }
  const events = provider.parseWebhook(rawBody);
  for (const event of events) if (event.providerMessageId) await repo.updateByProviderMessageId(event.providerMessageId, { status: event.status, ...(event.status === 'delivered' ? { deliveredAt: new Date() } : {}), ...(event.status === 'failed' ? { failedAt: new Date() } : {}) });
  return { processed: events.length };
}

export async function updateSmsConsent(phone: string, status: 'opted_in' | 'opted_out', source: string) { return repo.upsertSmsConsent(normalizePhone(phone), status, source); }
