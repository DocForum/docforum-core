// notifications services — the only exported surface other modules may
// call. Other modules must only import from here, never from
// repositories/ directly. See AGENTS.md "Non-negotiable rules".
//
// Provider-agnostic by design (ARCHITECTURE.md §1.5 / §2, PRD OQ / issue
// #17): outbound delivery goes through a `NotificationChannel` interface,
// and the default implementation is a console adapter. Picking a real
// email/SMS provider is issue #17 and deliberately does NOT block the
// features that need to send a message — only the adapter changes.
import { config } from '../../../config';

export interface NotificationMessage {
  /** Destination address — an email for now (the only channel interface we need). */
  to: string;
  subject: string;
  body: string;
}

export interface NotificationChannel {
  send(message: NotificationMessage): Promise<void>;
}

/** Dev/default adapter. Writes the message to stdout instead of sending
 * it anywhere — the only way to read a reset link in local dev until a
 * real provider is wired in (#17). Never logs a password, only the
 * single-use link (whose token is useless once used/expired). */
export const consoleNotificationChannel: NotificationChannel = {
  async send(message: NotificationMessage) {
    // eslint-disable-next-line no-console
    console.log(`[notifications] → ${message.to}\n${message.subject}\n${message.body}`);
  },
};

let channel: NotificationChannel = consoleNotificationChannel;

/** Swap the delivery adapter (real provider in prod, a spy in tests).
 * Returns the previous channel so callers can restore it. */
export function setNotificationChannel(next: NotificationChannel): NotificationChannel {
  const previous = channel;
  channel = next;
  return previous;
}

export async function send(message: NotificationMessage): Promise<void> {
  await channel.send(message);
}

/** Single-use, expiring reset link. The raw token is passed through to
 * the channel and never stored — only its hash is (auth module's
 * repository). */
export async function sendPasswordResetLink(input: {
  email: string;
  token: string;
  expiresAt: Date;
}): Promise<void> {
  const link = `${config.appBaseUrl}/reset-password?token=${encodeURIComponent(input.token)}`;
  const minutes = Math.round((input.expiresAt.getTime() - Date.now()) / 60_000);
  await send({
    to: input.email,
    subject: 'Reset your DocForum password',
    body: [
      'A password reset was requested for this account.',
      `Open this single-use link within ${minutes} minutes to choose a new password:`,
      link,
      'If you did not request this, you can ignore this message — your password is unchanged.',
    ].join('\n'),
  });
}
