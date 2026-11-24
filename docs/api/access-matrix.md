# Endpoint access matrix

<!-- GENERATED FILE — do not edit.

Built from the live app by `backend/scripts/gen-access-matrix.ts`
(`npm run docs:access-matrix` in `backend/`). CI runs
`npm run docs:access-matrix:check` and fails when this file no longer
matches the routers, so a route and its documentation cannot drift apart.
-->

Which role gets past which route, read off the middleware chains in
`backend/src/modules/*/routes` and the routers listed in
`backend/src/mounts.ts`. Endpoint-level guards only — see the limits at
the bottom before treating a row as a grant of access.

`Roles` is the set `requireRole` admits (`_none_` = no `requireRole` in
the chain, so any authenticated caller reaches the handler). `Verified
email` and `Idempotency` are the two guards the write paths gate on
(`requireVerifiedEmail`, `idempotencyMiddleware`). `Other guards` names
anything else in the chain that is not a controller, including inline
handlers Express cannot name, which appear as `(anonymous)`.

Every route also passes the application middleware, in order:

`requestId`, `(anonymous)`, `corsMiddleware`, `jsonParser`, `cookieParser`, `(anonymous)`, `(anonymous)`, `errorHandler`


## Application routes

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /health/live` | _none_ | — | — | — | — |
| `GET /health/ready` | _none_ | — | — | — | — |
| `GET /health` | _none_ | — | — | — | — |

## `/admin`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /admin/audit-events` | `admin` | `authenticate` | — | — | — |
| `GET /admin/access-logs/stats` | `admin` | `authenticate` | — | — | — |
| `GET /admin/access-logs` | `admin` | `authenticate` | — | — | — |
| `GET /admin/access-logs/user` | `admin` | `authenticate` | — | — | — |
| `DELETE /admin/users/:id/sessions` | `admin` | `authenticate` | — | — | — |
| `GET /admin/doctors/verification-queue` | `admin` | `authenticate` | — | — | — |
| `GET /admin/symptoms` | `admin` | `authenticate` | — | — | — |
| `POST /admin/symptoms` | `admin` | `authenticate` | — | — | — |
| `PATCH /admin/symptoms/:id` | `admin` | `authenticate` | — | — | — |
| `PUT /admin/symptoms/:id/specialties` | `admin` | `authenticate` | — | — | — |
| `GET /admin/specialties` | `admin` | `authenticate` | — | — | — |
| `POST /admin/specialties` | `admin` | `authenticate` | — | — | — |
| `PATCH /admin/specialties/:id` | `admin` | `authenticate` | — | — | — |
| `POST /admin/specialties/:id/retire` | `admin` | `authenticate` | — | — | — |
| `GET /admin/feature-flags` | `admin` | `authenticate` | — | — | — |
| `PATCH /admin/feature-flags/:key` | `admin` | `authenticate` | — | — | — |
| `GET /admin/metrics` | `admin` | `authenticate` | — | — | — |
| `GET /admin/orders/disputes` | `admin` | `authenticate` | — | — | — |
| `POST /admin/orders/disputes/:id/resolve` | `admin` | `authenticate` | — | — | — |
| `POST /admin/invites` | `admin` | `authenticate` | — | — | — |
| `GET /admin/invites` | `admin` | `authenticate` | — | — | — |
| `DELETE /admin/invites/:id` | `admin` | `authenticate` | — | — | — |
| `GET /admin/users` | `admin` | `authenticate` | — | — | — |
| `GET /admin/overview` | `admin` | `authenticate` | — | — | — |
| `PATCH /admin/users/:id/deactivate` | `admin` | `authenticate` | — | — | — |
| `PATCH /admin/users/:id/reactivate` | `admin` | `authenticate` | — | — | — |

## `/admin/outbox`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /admin/outbox/dead-letters` | `admin` | `authenticate` | — | — | — |

## `/admin/payments`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /admin/payments/escrow-events` | `admin` | `authenticate` | — | — | — |
| `GET /admin/payments/wallet-links/pending` | `admin` | `authenticate` | — | — | — |

## `/appointments`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `POST /appointments` | `patient` | `authenticate` | yes | yes | — |
| `GET /appointments/mine` | `patient` | `authenticate` | — | — | — |
| `GET /appointments/doctor/today` | `doctor` | `authenticate` | — | — | — |
| `GET /appointments/doctor` | `doctor` | `authenticate` | — | — | — |
| `POST /appointments/:appointmentId/check-in` | `patient` | `authenticate` | — | — | — |
| `GET /appointments/:appointmentId/queue` | _none_ | `authenticate` | — | — | — |
| `POST /appointments/:id/reschedule` | `patient` | `authenticate` | yes | — | — |
| `POST /appointments/:id/cancel` | `patient` | `authenticate` | yes | — | — |
| `POST /appointments/waitlist/join` | `patient` | `authenticate` | yes | — | — |
| `POST /appointments/waitlist/leave` | `patient` | `authenticate` | yes | — | — |
| `GET /appointments/waitlist/list` | `patient` | `authenticate` | — | — | — |
| `POST /appointments/waitlist/accept` | `patient` | `authenticate` | yes | — | — |
| `PATCH /appointments/:appointmentId/status` | `doctor` | `authenticate` | — | — | — |
| `PATCH /appointments/:appointmentId/cancel` | `patient` | `authenticate` | — | — | — |
| `GET /appointments/:id` | _none_ | `authenticate` | — | — | — |
| `POST /appointments/:appointmentId/consultation` | `doctor` | `authenticate` | yes | — | — |

## `/auth`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `POST /auth/signup` | _none_ | — | — | — | — |
| `POST /auth/signup-with-invite` | _none_ | — | — | — | — |
| `POST /auth/login` | _none_ | — | — | — | — |
| `POST /auth/2fa/setup` | _none_ | `authenticateMfaEnrollmentOrAccess` | — | — | — |
| `POST /auth/2fa/enable` | _none_ | `authenticateMfaEnrollmentOrAccess` | — | — | — |
| `POST /auth/2fa/verify` | _none_ | — | — | — | — |
| `GET /auth/2fa/status` | _none_ | `authenticate` | — | — | — |
| `POST /auth/2fa/disable` | _none_ | `authenticate` | — | — | — |
| `POST /auth/verify-email` | _none_ | — | — | — | — |
| `POST /auth/verify-email/resend` | _none_ | `authenticate` | — | — | — |
| `POST /auth/change-email/request` | _none_ | `authenticate` | — | — | — |
| `POST /auth/change-email/confirm` | _none_ | — | — | — | — |
| `POST /auth/login-attempts/clear` | `admin` | `authenticate` | — | — | — |
| `POST /auth/refresh` | _none_ | — | — | — | `requireAllowedOrigin` |
| `POST /auth/logout` | _none_ | — | — | — | `requireAllowedOrigin` |
| `POST /auth/password-reset/request` | _none_ | — | — | — | — |
| `POST /auth/password-reset/confirm` | _none_ | — | — | — | — |
| `GET /auth/sessions` | _none_ | `authenticate` | — | — | — |
| `DELETE /auth/sessions` | _none_ | `authenticate` | — | — | — |
| `DELETE /auth/sessions/:id` | _none_ | `authenticate` | — | — | — |

## `/availability`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /availability/doctors/:doctorProfileId/slots` | _none_ | — | — | — | — |
| `POST /availability/doctors/:doctorProfileId/slots/generate` | `doctor` | `authenticate` | — | — | — |

## `/consultations`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /consultations/mine` | `patient` | `authenticate` | — | — | — |
| `GET /consultations/doctor` | `doctor` | `authenticate` | yes | — | — |
| `POST /consultations` | `doctor` | `authenticate` | yes | — | — |
| `GET /consultations/:consultationId` | _none_ | `authenticate` | — | — | — |
| `GET /consultations/messages/attachments/:attachmentId/download-url` | _none_ | `authenticate` | — | — | — |
| `GET /consultations/messages/attachments/:attachmentId/file` | _none_ | — | — | — | — |
| `GET /consultations/:consultationId/messages` | _none_ | `authenticate` | — | — | — |
| `POST /consultations/:consultationId/messages` | _none_ | `authenticate` | yes | — | — |
| `PATCH /consultations/:consultationId/notes` | `doctor` | `authenticate` | yes | — | — |
| `POST /consultations/:consultationId/sign-off` | `doctor` | `authenticate` | yes | — | — |
| `POST /consultations/:consultationId/addenda` | `doctor` | `authenticate` | yes | — | — |
| `POST /consultations/:consultationId/referrals` | `doctor` | `authenticate` | yes | — | — |

## `/doctors`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /doctors` | _none_ | — | — | — | — |
| `GET /doctors/me` | `doctor` | `authenticate` | — | — | — |
| `PATCH /doctors/me` | `doctor` | `authenticate` | — | — | `requireIfMatch` |
| `PUT /doctors/me/specialties` | `doctor` | `authenticate` | — | — | — |
| `GET /doctors/:doctorProfileId` | _none_ | — | — | — | — |
| `PATCH /doctors/:doctorProfileId/verification` | `admin` | `authenticate` | — | — | — |
| `PATCH /doctors/:doctorProfileId/specialties/:specialtyId/verification` | `admin` | `authenticate` | — | — | — |

## `/facilities`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `POST /facilities` | `admin` | `authenticate` | — | — | — |
| `GET /facilities/me/prices` | `facility` | `authenticate` | — | — | — |
| `POST /facilities/me/prices` | `facility` | `authenticate` | yes | — | — |
| `POST /facilities/me/prices/retire` | `facility` | `authenticate` | yes | — | — |
| `POST /facilities/:facilityId/capabilities` | `admin` | `authenticate` | — | — | — |
| `DELETE /facilities/:facilityId/capabilities/:capabilityId` | `admin` | `authenticate` | — | — | — |
| `GET /facilities/eligible` | _none_ | — | — | — | — |
| `GET /facilities/:facilityId/prices` | _none_ | — | — | — | — |

## `/follow-ups`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /follow-ups/mine` | `patient` | `authenticate` | — | — | — |
| `POST /follow-ups/:followUpId/book` | `patient` | `authenticate` | yes | — | — |

## `/intake`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `POST /intake` | `patient` | `authenticate` | — | — | — |
| `GET /intake/mine` | `patient` | `authenticate` | — | — | — |

## `/lab-orders`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `POST /lab-orders` | _none_ | `authenticate` | — | — | — |
| `GET /lab-orders/:id` | _none_ | `authenticate` | — | — | — |
| `POST /lab-orders/:id/fulfill` | `facility` | `authenticate` | — | — | — |

## `/lab-results`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /lab-results/unacknowledged` | `admin, doctor` | `authenticate` | — | — | — |
| `POST /lab-results/:labResultId/acknowledge` | `doctor` | `authenticate` | yes | — | — |

## `/me`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /me/flags` | _none_ | `authenticate` | — | — | — |

## `/medications`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /medications` | _none_ | `authenticate` | — | — | — |

## `/notifications`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /notifications` | _none_ | `authenticate` | — | — | — |
| `GET /notifications/unread-count` | _none_ | `authenticate` | — | — | — |
| `POST /notifications/read-all` | _none_ | `authenticate` | — | — | — |
| `POST /notifications/:id/read` | _none_ | `authenticate` | — | — | — |
| `GET /notifications/stream` | _none_ | `authenticate`, `authenticate` | — | — | — |

## `/orders`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `POST /orders/consultations` | `doctor` | `authenticate` | yes | — | — |
| `POST /orders/consultations/:consultationId/prescriptions` | `doctor` | `authenticate` | yes | — | — |
| `POST /orders/consultations/:consultationId/lab-orders` | `doctor` | `authenticate` | yes | — | — |
| `POST /orders/lab-orders/:labOrderId/result` | `facility` | `authenticate` | — | — | `labResultBody` |
| `GET /orders/lab-orders/:labOrderId/result` | _none_ | `authenticate` | — | — | — |
| `POST /orders/:id/confirm-receipt` | `patient` | `authenticate` | — | — | — |
| `POST /orders/:id/dispute` | `patient` | `authenticate` | — | — | — |
| `GET /orders/:id` | _none_ | `authenticate` | — | — | — |

## `/patients`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /patients/me/access-log` | `patient` | `authenticate` | — | — | — |
| `GET /patients/me` | `patient` | `authenticate` | — | — | — |
| `PATCH /patients/me` | `patient` | `authenticate` | — | — | `requireIfMatch` |
| `POST /patients/me/export` | `patient` | `authenticate` | — | — | — |
| `GET /patients/me/export/:exportId` | `patient` | `authenticate` | — | — | — |
| `GET /patients/me/export/:exportId/download` | `patient` | `authenticate` | — | — | — |
| `DELETE /patients/me` | `patient` | `authenticate` | — | — | — |
| `POST /patients/me/dependents` | `patient` | `authenticate` | yes | — | — |
| `GET /patients/me/dependents` | `patient` | `authenticate` | — | — | — |

## `/payments`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /payments/mine` | `patient` | `authenticate` | — | — | — |
| `GET /payments/facility/ledger` | `facility` | `authenticate` | — | — | — |
| `GET /payments/facility/ledger.csv` | `facility` | `authenticate` | — | — | — |
| `POST /payments/wallet-link` | `facility, patient` | `authenticate` | yes | — | — |
| `GET /payments/wallet-link` | `facility, patient` | `authenticate` | — | — | — |
| `GET /payments/intents/:id` | `admin` | `authenticate` | — | — | — |
| `POST /payments/intents/:id/prepare` | `patient` | `authenticate` | yes | — | — |
| `POST /payments/intents/:id/fund` | `admin` | `authenticate` | yes | yes | — |
| `POST /payments/intents/:id/release` | `admin` | `authenticate` | yes | yes | — |
| `POST /payments/intents/:id/refund` | `admin` | `authenticate` | yes | yes | — |
| `GET /payments/sep10/challenge` | _none_ | `authenticate` | yes | — | — |
| `POST /payments/sep10/verify` | _none_ | `authenticate` | yes | — | — |

## `/pharmacy-orders`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `POST /pharmacy-orders/fulfillments` | `admin, patient` | `authenticate` | yes | — | — |
| `GET /pharmacy-orders/fulfillments/:id` | _none_ | `authenticate` | — | — | — |
| `GET /pharmacy-orders/orders/:orderId/fulfillments` | `admin, patient` | `authenticate` | — | — | — |
| `PATCH /pharmacy-orders/fulfillments/:id` | `facility` | `authenticate` | yes | — | — |
| `PATCH /pharmacy-orders/fulfillments/:id/items/:itemId` | `facility` | `authenticate` | yes | — | — |
| `GET /pharmacy-orders/orders/:orderId/fulfillment-status` | _none_ | `authenticate` | — | — | — |
| `POST /pharmacy-orders` | _none_ | `authenticate` | — | — | — |
| `GET /pharmacy-orders/:id` | _none_ | `authenticate` | — | — | — |
| `POST /pharmacy-orders/:id/fulfill` | `facility` | `authenticate` | — | — | — |

## `/referrals`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `POST /referrals` | `doctor` | `authenticate` | yes | — | — |
| `POST /referrals/from-consultation/:consultationId` | `doctor` | `authenticate` | yes | — | — |
| `POST /referrals/:referralId/accept` | `patient` | `authenticate` | yes | — | — |
| `POST /referrals/:referralId/decline` | `patient` | `authenticate` | yes | — | — |
| `POST /referrals/:referralId/withdraw` | `doctor` | `authenticate` | yes | — | — |
| `GET /referrals/incoming` | `doctor` | `authenticate` | — | — | — |
| `GET /referrals/mine` | `patient` | `authenticate` | — | — | — |
| `GET /referrals/created` | `doctor` | `authenticate` | — | — | — |
| `GET /referrals/admin/queue` | `admin` | `authenticate` | — | — | — |
| `POST /referrals/admin/:referralId/reassign` | `admin` | `authenticate` | — | — | — |
| `POST /referrals/admin/:referralId/cancel` | `admin` | `authenticate` | — | — | — |
| `GET /referrals/admin/:referralId/audit-events` | `admin` | `authenticate` | — | — | — |
| `GET /referrals/:referralId` | _none_ | `authenticate` | — | — | — |

## `/specialties`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /specialties` | _none_ | — | — | — | — |
| `POST /specialties` | `admin` | `authenticate` | — | — | — |
| `PATCH /specialties/:id` | `admin` | `authenticate` | — | — | — |
| `POST /specialties/:id/retire` | `admin` | `authenticate` | — | — | — |

## `/symptoms`

| Method & path | Roles | Auth | Verified email | Idempotency | Other guards |
|---|---|---|---|---|---|
| `GET /symptoms` | _none_ | — | — | — | — |

## What this does not capture

- **Service-level ownership and state checks.** Most endpoints narrow access
  after the handler starts — the patient id on `/appointments/mine`, "the
  consultation must be yours" in consultations, "this referral is not for
  you" in referrals, a facility's own orders, and the role-aware visibility
  rules inside the read services. A row above says which role *reaches* the
  handler, not which rows that handler will return or mutate.
- **Idempotency keys and rate limits as semantics.** The `Idempotency` column
  says the middleware runs, not which header it reads or what a replay does.
- **Anything not in a chain.** Feature flags, `docs/api/README.md` prose,
  and database RLS policies (`docs/adr/0014`) decide access too and are
  invisible to a router walk.
- **Role guards reached indirectly.** A guard wrapped by another function is
  no longer recognisable as `requireRole` by source text, so its roles are
  not inferred; the wrapper is listed under `Other guards` instead.

Every router layer in the app was attributed to a mount prefix.
