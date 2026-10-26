import sendGrid from '@sendgrid/mail';
import type { NotificationChannel } from '../services/index';

export interface SendGridConfig {
  fromEmail?: string;
}

const defaultConfig: SendGridConfig = {
  fromEmail: 'noreply@docforum.local',
};

export const sendgridNotificationChannel: NotificationChannel = {
  async send(_message, _channel = 'email') {
    await sendGrid.send({
      to: _message.to as any,
      from: process.env.SENDGRID_FROM_EMAIL || defaultConfig.fromEmail,
      subject: _message.subject,
      text: _message.body,
    } as any);
  },
};