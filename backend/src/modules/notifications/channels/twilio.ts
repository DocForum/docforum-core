import { config, normalizedPhone } from '../../../config';
import { templateFor } from '../templates';
import type { NotificationChannelAdapter, NotificationDispatch } from '../services';
import * as notificationsRepo from '../repositories';

export function createTwilioAdapter(resolvePhone: (userId: string) => Promise<string | null>): NotificationChannelAdapter {
  return {
    channel: 'sms',
    async send(notification: NotificationDispatch) {
      const sms = config.notifications.sms;
      if (!sms.enabled || !sms.accountSid || !sms.authToken || !sms.from) return;
      const to = await resolvePhone(notification.userId);
      if (!to) return;
      if (!(await notificationsRepo.hasSmsConsent(to)) || (await notificationsRepo.smsSentToday(to)) >= sms.dailyCap) return;
      const body = new URLSearchParams({ To: normalizedPhone(to), From: sms.from, Body: templateFor(notification.type).text });
      const auth = Buffer.from(`${sms.accountSid}:${sms.authToken}`).toString('base64');
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sms.accountSid}/Messages.json`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (!response.ok) throw new Error(`Twilio returned ${response.status}`);
      const result = await response.json() as { sid?: string };
      await notificationsRepo.recordDelivery({ notificationId: notification.notificationId, channel: 'sms', destination: normalizedPhone(to), status: 'sent', providerMessageId: result.sid });
    },
  };
}
