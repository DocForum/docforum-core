import { z } from 'zod';

export const notificationTypes = [
  'booking_confirmed',
  'new_booking',
  'referral_created',
  'referral_decision',
  'order_ready',
  'results_available',
] as const;

export type NotificationType = (typeof notificationTypes)[number];

const payloadSchema = z.object({ loginUrl: z.string().url() }).strict();

export type NotificationPayload = z.infer<typeof payloadSchema>;

export interface RenderedTemplate {
  type: NotificationType;
  version: 1;
  subject: string;
  text: string;
  html: string;
  sms: string;
}

const labels: Record<NotificationType, string> = {
  booking_confirmed: 'Your DocForum appointment is confirmed.',
  new_booking: 'You have a new DocForum appointment.',
  referral_created: 'A DocForum referral is ready for you.',
  referral_decision: 'Your DocForum referral was updated.',
  order_ready: 'Your DocForum order is ready.',
  results_available: 'Your DocForum results are available.',
};

export function renderNotification(type: NotificationType, rawPayload: unknown): RenderedTemplate {
  const payload = payloadSchema.parse(rawPayload);
  const label = labels[type];
  return {
    type,
    version: 1,
    subject: label,
    text: `${label} Sign in to DocForum to view it: ${payload.loginUrl}`,
    html: `<p>${label}</p><p><a href="${payload.loginUrl}">Sign in to DocForum</a> to view it.</p>`,
    sms: `${label} Sign in: ${payload.loginUrl}`,
  };
}

/** PHI keys are deliberately not accepted by the validated template payload. */
export const phiFieldNames = [
  'name', 'email', 'phone', 'dob', 'address', 'notes', 'symptoms', 'diagnosis',
  'medication', 'prescription', 'labResult', 'intake', 'patientId',
] as const;
