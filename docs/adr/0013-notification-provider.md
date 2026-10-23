# ADR 0013: Notification provider (email/SMS)

- **Status:** Accepted
- **Phase:** 6 — Notifications
- **Issue:** [Phase 6] ADR: pick notification provider (email/SMS)

## Context

ARCHITECTURE.md §8 listed the notification provider (email/SMS) as an open question. The rest of Phase 6 (trigger points for booking, referral, and order events) should not be blocked on an undecided provider choice. The codebase already routes all outbound delivery through the provider-agnostic `NotificationChannel` interface in `backend/src/modules/notifications/services/index.ts`, with a console adapter as the default. Business logic depends only on `send(message)` and never on a provider SDK.

Requirements:

- A concrete, named provider must be chosen for email (and SMS where needed), not deferred again.
- Provider-specific code must live behind the `NotificationChannel` interface and must not leak into other modules.
- Other modules keep importing only from the notifications `services` surface.

## Decision

1. **Email provider: Amazon SES (Simple Email Service).** SES is chosen for transactional email because it is low cost at our expected volume, has a mature Node SDK, supports DKIM/SPF/DMARC configuration on our own domain, and has no per-contract minimums.
2. **SMS provider: Twilio Programmable Messaging.** Twilio is chosen as the SMS adapter because it has broad coverage, a stable API, and straightforward delivery-status webhooks. SMS is not required for the first Phase 6 slice and is adopted only when an SMS-bearing trigger is built.
3. **Adapter placement.** Each provider is implemented as a `NotificationChannel` adapter (e.g. `sesNotificationChannel`, `twilioNotificationChannel`) inside `backend/src/modules/notifications/`. Selection is made at composition time through `setNotificationChannel`. The console adapter remains the default for local development and tests.
4. **Provider-agnostic boundary.** The `Notification` model and dispatch interface stay provider-neutral. No provider SDK types, identifiers, or error codes may appear outside the adapter files. Callers only construct a `NotificationMessage` and call `send`.
5. **Credentials.** Provider credentials are read from configuration/environment only and are never committed.

## Consequences

- Phase 6 trigger work can proceed immediately by calling the notifications service; no provider decision is pending.
- Switching providers later requires only a new adapter and a configuration change, with no edits to business logic.
- We take on the operational setup of SES domain verification and Twilio sender registration when the adapters are built.
- The console adapter continues to serve local development until real adapters are wired in.

## Alternatives considered

- **SendGrid (email):** comparable capability and pricing; rejected in favor of SES for cost and existing AWS alignment.
- **Postmark (email):** excellent deliverability for transactional mail; rejected for higher per-message cost at scale.
- **Vonage / AWS SNS (SMS):** viable; Twilio chosen for its API maturity and webhook tooling.

## Follow-ups

- Implement the SES `NotificationChannel` adapter and its configuration.
- Implement the Twilio `NotificationChannel` adapter when the first SMS trigger ships.
- Update ARCHITECTURE.md §8 and the ROADMAP.md Phase 6 checklist to reflect this decision.
