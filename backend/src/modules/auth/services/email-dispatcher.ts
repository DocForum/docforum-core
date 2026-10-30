// Provider-agnostic outbound email seam (ARCHITECTURE.md §2: email/SMS is
// "third-party, behind an interface — never build custom").
//
// The default sender delegates to the notifications module's configured
// provider. Tests inject their own sender to capture verification links.
import { emailProvider } from '../../notifications/providers';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export type EmailSender = (message: EmailMessage) => Promise<void>;

async function defaultEmailSender(message: EmailMessage): Promise<void> {
  await emailProvider.send(message);
  return;
}

let currentSender: EmailSender = defaultEmailSender;

/** Swap the sender (tests; and the Phase 6 provider integration). */
export function setEmailSender(sender: EmailSender): void {
  currentSender = sender;
}

export function resetEmailSender(): void {
  currentSender = defaultEmailSender;
}

export function sendEmail(message: EmailMessage): Promise<void> {
  return currentSender(message);
}
