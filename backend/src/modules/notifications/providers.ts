import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config';

export interface ProviderMessage {
  to: string;
  subject?: string;
  text: string;
  html?: string;
}

export interface ProviderResult { providerMessageId: string; }
export interface DeliveryEvent {
  providerMessageId?: string;
  status: 'sent' | 'delivered' | 'failed';
  recipient?: string;
}

export interface EmailProvider { send(message: ProviderMessage): Promise<ProviderResult>; verifyWebhook(body: string, signature: string | undefined): boolean; parseWebhook(body: string): DeliveryEvent[]; }
export interface SmsProvider { send(message: ProviderMessage): Promise<ProviderResult>; verifyWebhook(body: string, signature: string | undefined): boolean; parseWebhook(body: string): DeliveryEvent[]; }

function verifyHmac(body: string, signature: string | undefined, secret: string | undefined): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const actual = signature.replace(/^sha256=/, '');
  return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

class ConsoleProvider implements EmailProvider, SmsProvider {
  async send(message: ProviderMessage): Promise<ProviderResult> {
    console.info(`[notification] local delivery to ${message.to}`);
    return { providerMessageId: `local-${Date.now()}-${Math.random().toString(36).slice(2)}` };
  }
  verifyWebhook(): boolean { return true; }
  parseWebhook(): DeliveryEvent[] { return []; }
}

class ResendProvider implements EmailProvider {
  async send(message: ProviderMessage): Promise<ProviderResult> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${config.notifications.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.notifications.emailFrom, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
    });
    if (!response.ok) throw new Error(`Resend rejected email (${response.status}).`);
    const result = (await response.json()) as { id?: string };
    if (!result.id) throw new Error('Resend returned no message id.');
    return { providerMessageId: result.id };
  }
  verifyWebhook(body: string, signature: string | undefined): boolean { return verifyHmac(body, signature, config.notifications.webhookSecret); }
  parseWebhook(body: string): DeliveryEvent[] {
    const event = JSON.parse(body) as { type?: string; data?: { email_id?: string; to?: string[] } };
    const status = event.type?.includes('delivered') ? 'delivered' : event.type?.includes('failed') ? 'failed' : 'sent';
    return event.data?.email_id ? [{ providerMessageId: event.data.email_id, status, recipient: event.data.to?.[0] }] : [];
  }
}

class TwilioProvider implements SmsProvider {
  async send(message: ProviderMessage): Promise<ProviderResult> {
    const auth = Buffer.from(`${config.notifications.twilioAccountSid}:${config.notifications.twilioAuthToken}`).toString('base64');
    const body = new URLSearchParams({ To: message.to, From: config.notifications.smsFrom, Body: message.text });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.notifications.twilioAccountSid}/Messages.json`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!response.ok) throw new Error(`Twilio rejected SMS (${response.status}).`);
    const result = (await response.json()) as { sid?: string };
    if (!result.sid) throw new Error('Twilio returned no message id.');
    return { providerMessageId: result.sid };
  }
  verifyWebhook(body: string, signature: string | undefined): boolean { return verifyHmac(body, signature, config.notifications.webhookSecret); }
  parseWebhook(body: string): DeliveryEvent[] {
    const event = JSON.parse(body) as { MessageSid?: string; MessageStatus?: string; To?: string; Body?: string };
    const status = event.MessageStatus === 'delivered' ? 'delivered' : ['failed', 'undelivered'].includes(event.MessageStatus ?? '') ? 'failed' : 'sent';
    return event.MessageSid ? [{ providerMessageId: event.MessageSid, status, recipient: event.To }] : [];
  }
}

export const emailProvider: EmailProvider = config.notifications.emailProvider === 'resend' ? new ResendProvider() : new ConsoleProvider();
export const smsProvider: SmsProvider = config.notifications.smsProvider === 'twilio' ? new TwilioProvider() : new ConsoleProvider();
