import type { NotificationType } from './services';

/** Notification copy is deliberately identifier-free: clinical context stays
 * behind the authenticated application, never in an inbox or lock screen. */
export const notificationTemplates: Record<NotificationType, { subject: string; text: string; html: string }> = {
  booking_confirmed: { subject: 'DocForum: appointment update', text: 'Your DocForum appointment was updated. Sign in to view details.', html: '<p>Your DocForum appointment was updated.</p><p>Sign in to view details.</p>' },
  new_booking: { subject: 'DocForum: appointment update', text: 'Your DocForum appointment list was updated. Sign in to view details.', html: '<p>Your DocForum appointment list was updated.</p><p>Sign in to view details.</p>' },
  referral_created: { subject: 'DocForum: care update', text: 'Your DocForum care thread was updated. Sign in to view details.', html: '<p>Your DocForum care thread was updated.</p><p>Sign in to view details.</p>' },
  referral_updated: { subject: 'DocForum: care update', text: 'Your DocForum care thread was updated. Sign in to view details.', html: '<p>Your DocForum care thread was updated.</p><p>Sign in to view details.</p>' },
  order_ready: { subject: 'DocForum: order update', text: 'A DocForum order is ready for your next step. Sign in to view details.', html: '<p>A DocForum order is ready for your next step.</p><p>Sign in to view details.</p>' },
  results_available: { subject: 'DocForum: results update', text: 'New DocForum results are available. Sign in to view details.', html: '<p>New DocForum results are available.</p><p>Sign in to view details.</p>' },
};

export function templateFor(type: NotificationType) {
  return notificationTemplates[type];
}
