import { createHash } from 'node:crypto';

const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined ? fallback : value.toLowerCase() === 'true';

export const notifications = {
  environment: process.env.NODE_ENV ?? 'development',
  email: {
    enabled: bool(process.env.EMAIL_ENABLED, false),
    postmarkToken: process.env.POSTMARK_SERVER_TOKEN,
    from: process.env.EMAIL_FROM ?? 'DocForum <noreply@docforum.local>',
    webhookSecret: process.env.POSTMARK_WEBHOOK_SECRET,
  },
  sms: {
    enabled: bool(process.env.SMS_ENABLED, false),
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM_NUMBER,
    webhookSecret: process.env.TWILIO_WEBHOOK_SECRET,
    dailyCap: Math.max(1, Number(process.env.SMS_DAILY_CAP ?? 5)),
  },
  openapi: {
    expose: bool(process.env.EXPOSE_OPENAPI, process.env.NODE_ENV !== 'production'),
  },
} as const;

export function normalizedPhone(value: string): string {
  return value.replace(/[\s().-]/g, '').replace(/^00/, '+');
}

export function webhookDigest(secret: string, timestamp: string, body: string): string {
  return createHash('sha256').update(`${secret}:${timestamp}:${body}`).digest('hex');
}
