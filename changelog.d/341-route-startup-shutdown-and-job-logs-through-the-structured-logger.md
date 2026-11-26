feat(logging): Route startup, shutdown and job logs through the structured logger

- Replaced `console.*` calls in `src/server.ts` with the structured pino
  logger (`logger.info`, `logger.error`).
- Replaced `console.*` calls in all job files under `src/jobs/` with the
  structured logger:
  - `referral-expiry.ts`
  - `auth-token-prune.ts`
  - `outbox-events.ts`
  - `payment-intents.ts`
  - `consultation-sign-off.ts`
  - `lab-result-escalation.ts`
  - `order-expiry.ts`
  - `patient-exports.ts`
  - `follow-up-expiry.ts`
  - `account-purge.ts`
- Replaced `console.*` call in `src/modules/auth/services/email-dispatcher.ts`
  with `logger.info`.
- Replaced `console.*` calls in other modules across `src/`:
  - `src/modules/audit/services/index.ts`
  - `src/modules/notifications/services/index.ts`
  - `src/modules/orders/services/lab-results.ts`
  - `src/modules/patients/services/index.ts`
  - `src/modules/payments/services/escrow-events.ts`
  - `src/modules/payments/services/index.ts`
- Added lint guard (via existing `npm run lint` pipeline) that will forbid
  `console.*` in `src/` outside `scripts/` in future PRs.
- No console calls remain in `src/`; all job logs carry error types, not
  messages, consistent with the structured logging rule.

Closes #341