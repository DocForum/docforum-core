# ADR 0007: Notification providers and PHI-safe delivery

Status: Accepted

## Decision

DocForum uses Resend for transactional email and Twilio for SMS. Both are
behind the notifications module's provider interfaces; application modules do
not import either provider or its SDK. Local development and tests use the
console provider and never send real messages.

Templates accept only a validated login URL and contain no clinical detail.
Delivery webhooks use the shared `NOTIFICATION_WEBHOOK_SECRET` HMAC boundary,
and provider message IDs are stored so delivery status updates are idempotent.
SMS numbers must be E.164 and require persisted opt-in consent. `STOP` and
`START` callbacks update that consent, and SMS sends are capped per user per
UTC day by `SMS_DAILY_CAP` (default 3).

## Consequences

- `RESEND_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `EMAIL_FROM`,
  `SMS_FROM`, and `NOTIFICATION_WEBHOOK_SECRET` are deployment configuration;
  absent provider configuration safely falls back to console delivery locally.
- Provider-specific webhook payload parsing is isolated in `providers.ts`.
- Templates are versioned in source and checked by tests for PHI field leakage.
