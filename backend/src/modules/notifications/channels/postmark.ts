import { config } from '../../../config';
import { templateFor } from '../templates';
import type { NotificationChannelAdapter, NotificationDispatch } from '../services';
import * as notificationsRepo from '../repositories';

export function createPostmarkAdapter(resolveEmail: (userId: string) => Promise<string | null>): NotificationChannelAdapter {
  return {
    channel: 'email',
    async send(notification: NotificationDispatch) {
      if (!config.notifications.email.enabled || !config.notifications.email.postmarkToken) return;
      const to = await resolveEmail(notification.userId);
      if (!to) return;
      const template = templateFor(notification.type);
      const response = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': config.notifications.email.postmarkToken },
        body: JSON.stringify({ From: config.notifications.email.from, To: to, Subject: template.subject, TextBody: template.text, HtmlBody: template.html, MessageStream: 'outbound' }),
      });
      if (!response.ok) throw new Error(`Postmark returned ${response.status}`);
      const result = await response.json() as { MessageID?: string };
      await notificationsRepo.recordDelivery({ notificationId: notification.notificationId, channel: 'email', destination: to, status: 'sent', providerMessageId: result.MessageID });
    },
  };
}
