// Provider-agnostic outbound email seam (ARCHITECTURE.md §2: email/SMS is
// "third-party, behind an interface — never build custom").
//
// No provider is integrated yet — choosing one is Phase 6, tracked as
// issue #17, and is deliberately not decided here. Until then the default
// sender drops the message and logs only the *subject* and recipient:
// never the body, because for verification mail the body contains the
// one-time token (same rule the admin bootstrap CLI follows for
// passwords — see issue #39). Tests inject their own sender to capture
// the link.
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export type EmailSender = (message: EmailMessage) => Promise<void>;

async function defaultEmailSender(message: EmailMessage): Promise<void> {
  // eslint-disable-next-line no-console
  console.info(`[email] no provider configured yet (Phase 6 / issue #17) — "${message.subject}" to ${message.to} was not sent.`);
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
