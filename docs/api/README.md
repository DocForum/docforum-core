# API docs

Endpoints are grouped by module below. Which phases are built is tracked
in `ROADMAP.md`, not here. Keep this file in sync with
`backend/src/modules/*/routes` (AGENTS.md doc-update rule): when you add or
change an endpoint, add or edit its row in that module's table, and leave
the rest of the file alone.

Base URL: `http://localhost:4000` locally (`PORT` in `.env`). No OpenAPI spec yet — TBD, tracked informally, not blocking Phase 1.

## Auth (`/auth`) — `backend/src/modules/auth`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /auth/signup` | none | `{ role: 'patient'\|'doctor', email, password, fullName }` | **`role` is restricted to `patient`/`doctor` server-side, not just in docforum-web's UI** — facility accounts are admin-invited only (PRD OQ-2). Returns `{ user, accessToken }`; sets an httpOnly refresh cookie. Stores the best supported language from `Accept-Language` (`en` fallback) as `user.locale`. |
| `POST /auth/login` | none | `{ email, password }` | Same response shape as signup. **Throttled** (Phase 8, issue #35) — see below. |
| `POST /auth/refresh` | refresh cookie + `X-CSRF-Token` | — | Reads the httpOnly cookie (not the body). Returns a fresh `{ user, accessToken, csrfToken }` and rotates the cookie **and** the CSRF token. `403` if the CSRF token is missing/wrong or the `Origin` isn't allowlisted. |
| `POST /auth/logout` | `X-CSRF-Token` | — | Clears the refresh cookie. `204 No Content`; `403` without the CSRF header or from a disallowed `Origin`. |
| `POST /auth/verify-email` | none | `{ token }` | Redeems the token from the verification email. `200 { emailVerifiedAt }`. Errors are `400` with `code: 'INVALID_VERIFICATION_TOKEN'` (unknown / already used) or `code: 'VERIFICATION_TOKEN_EXPIRED'`. Single-use and atomic — two concurrent redemptions can't both succeed. |
| `POST /auth/verify-email/resend` | access token | — | Re-sends to the caller's own address. `200 { resendAfterSeconds }`. `409 EMAIL_ALREADY_VERIFIED` if already verified; `429 EMAIL_VERIFICATION_RATE_LIMITED` if a mail went out less than `EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS` ago (default 60). Authenticated and account-scoped on purpose — no email in the body, so it can't be used to enumerate accounts. |

### Email verification (Phase 8, issue #34)

`POST /auth/signup` creates the account **unverified** (`user.emailVerifiedAt`
is `null` in the response and in `GET`-style payloads). Unverified accounts
can log in, refresh, and browse; they get
`403 { message, code: 'EMAIL_NOT_VERIFIED' }` from mutating routes that
depend on a trustworthy contact address:

- `POST /appointments` (booking)
- `POST /consultations`, `POST /consultations/:id/referrals`
- `POST /referrals`, `POST /referrals/from-consultation/:id`,
  `POST /referrals/:id/{accept,decline}`
- `POST /payments/wallet-link`, `POST /payments/intents`,
  `POST /payments/intents/:id/{fund,release,refund}`

(`GET`-style routes — lists, availability, the admin referral queue —
are deliberately *not* gated on verification: browsing needs no contact
address.)

That guard reads the database rather than trusting a claim in the access
token, so verifying in one tab unblocks the caller immediately instead of
after the 15-minute token TTL.

**No email provider is integrated yet** (Phase 6, issue #17) —
`backend/src/modules/auth/services/email-dispatcher.ts` is the
provider-agnostic seam and currently drops the message (logging only the
subject and recipient, never the body/token). On a hosted deployment, an
operator can mark an address verified out-of-band with
`node backend/scripts/mark-email-verified.mjs <email>`; see
`scripts/README.md`. This is a documented interim, not the end state.

Env knobs: `EMAIL_VERIFICATION_TOKEN_TTL_MINUTES` (default 1440),
`EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS` (default 60),
`EMAIL_VERIFICATION_LANDING_URL` (where the emailed link points).

### CSRF (Phase 8, issue #37)

The refresh cookie is `SameSite=None; Secure` in production (docforum-web on
GitHub Pages and this API on Render are different sites), so **any** website
can cause a browser to send it to `/auth/refresh` / `/auth/logout`. Those two
routes are therefore protected by:

1. **A required `X-CSRF-Token` header** carrying the `csrfToken` from the
   login/signup/refresh response body. It's a claim inside the refresh JWT
   for that session, so it rotates together with the cookie and needs no
   server-side state. On `/auth/logout` there is no session token to match
   against, so the header's presence is required instead (the impact of a
   forged logout is a forced sign-out, not data loss).
2. **An `Origin` allowlist** — a request whose `Origin` is present and not on
   the CORS allowlist is rejected with `403 Origin not allowed.`
3. **An explicit per-environment CORS allowlist** — `CORS_ORIGINS`
   (comma-separated; `CORS_ORIGIN` still works as a single origin).
   Production defaults to `https://docforum.github.io`; local dev to
   `http://localhost:5173` and `http://127.0.0.1:5173`.

**Why not a double-submit cookie** (the usual default): a cookie set by this
API is a third-party cookie to `docforum.github.io`, so docforum-web's
JavaScript can never read it — the value therefore has to travel in the
response body instead. See `backend/src/middleware/csrf.ts`.

**Client requirements (docforum-web):**

- Store `csrfToken` from the signup/login/refresh response next to the access
  token (in memory), and replace it on every refresh response.
- Send it on the two cookie-authenticated calls:
  `fetch(url, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrfToken } })`.
- A `403` there means re-login, not retry.

**Requests with no `Origin` header** (curl, server-to-server): allowed past
the Origin check, but the CSRF header is still required — an attacker's page
can't win by suppressing `Origin`. Sessions issued before this change carry
no `csrf` claim in their refresh token, so they are rejected with `403` and
need one re-login.

### Login throttling (Phase 8, issue #35)

`POST /auth/login` is rate-limited **per normalised email and per client
IP**, with state in Postgres (so it survives restarts and doesn't assume a
single instance). Bucket size is capped by the first limit reached:

| Phase | Response |
|---|---|
| Below `LOGIN_THROTTLE_BACKOFF_AFTER` failures (default 3) in the window | normal `401 { message: 'Invalid email or password.' }` |
| At/after it | `429` with a `Retry-After: <seconds>` header, growing exponentially (`LOGIN_THROTTLE_BACKOFF_BASE_SECONDS` × 2ⁿ, capped at `LOGIN_THROTTLE_BACKOFF_MAX_SECONDS`) |
| At `LOGIN_THROTTLE_LOCK_AFTER` failures (default 10) | `429` locked for `LOGIN_THROTTLE_LOCK_SECONDS` (default 15 min). The lock is set once per window and is not extended by further attempts |
| Window (`LOGIN_THROTTLE_WINDOW_SECONDS`, default 15 min) | New window restarts the count at 1 and clears the lock |

A successful login clears the **per-account** counter. The per-IP bucket is
left alone, so one valid login can't reset a shared-IP budget.

Clients should honour `Retry-After` and must **not** treat a `429` as
"account locked permanently". The response is identical for a real and a
non-existent address, and for a locked and a backing-off bucket — it
deliberately reveals nothing about whether the account exists (an absent
account also pays bcrypt's comparison cost, so timing doesn't leak either).

`POST /auth/login-attempts/clear` (admin-only) clears a lock a legitimate
user is stuck behind: body `{ email?, ip? }` (at least one), returns
`{ cleared }`. Clear **both** when a lock was taken out via the account's IP,
or the IP bucket will keep refusing them. It's logged to the server console
— the `AuditEvent` table (ARCHITECTURE.md §4.10) records booking, doctor
verification, payments and the referral admin actions, but not the
login-throttle clear, so that's still the interim record.

Under the hood this uses Express's `trust proxy` setting via the
`TRUST_PROXY` env var: `1` behind Render's single proxy hop, `false` (the
default) locally. See `ARCHITECTURE.md` §7 — the wrong value is a security
bug in either direction. A cleanup interval in `src/server.ts` prunes
buckets whose last failure is older than
`LOGIN_THROTTLE_PRUNE_AFTER_SECONDS` (default 24 h).

Access tokens: `Authorization: Bearer <token>`, 15-minute TTL, no
revocation list yet (see `ARCHITECTURE_ESSENTIALS.md` known gaps —
JWT refresh rotation without a revocation list). Refresh tokens: httpOnly
cookie, 30-day TTL, `SameSite=None; Secure` in production and
`Lax`/insecure locally — the attributes live in `config.cookie`
(`backend/src/config/index.ts`) so the refresh and CSRF cookies can never
drift apart. See `docs/adr/0003` for why production needs `SameSite=None`.

Every token carries a `tv` claim (the user's `tokenVersion` at issue time).
Bumping `User.tokenVersion` — which password reset does — invalidates every
outstanding refresh token for that user at the next refresh. This is the
interim kill switch for issue #33; the fuller revocation list (per-session
revocation, #18) is still open, so a bumped-away **access** token keeps
working until its 15-minute TTL elapses. Refresh tokens are checked
against `tokenVersion` on every `POST /auth/refresh`.

## Doctors (`/doctors`) — `backend/src/modules/doctors`

| Method & path | Auth | Notes |
|---|---|---|
| `GET /doctors` | none | Query: optional `specialty` slug, typo-tolerant `q`, `limit` (1–50, default 20), and keyset `cursor`. Returns `{ items: [{ id, fullName, specialties: [{ id, name, slug }] }], nextCursor }`; only verified profiles and public fields are returned. One/two-character queries use prefix matching; longer queries use `pg_trgm` similarity. The frontend fetches slot details separately. |
| `GET /doctors/me` | doctor | Returns the caller's own `DoctorProfile`. |
| `PUT /doctors/me/specialties` | doctor | Body `{ specialtyIds: string[] }`; replaces the caller's specialty assignments. Unknown ids return `400`. |
| `PATCH /doctors/:doctorProfileId/verification` | admin | Body `{ status: 'pending'\|'verified'\|'rejected' }`. Manual, admin-gated per PRD FR-3 — there is no automated verification pipeline. |

## Specialties (`/specialties`) — `backend/src/modules/doctors`

| Method & path | Auth | Notes |
|---|---|---|
| `GET /specialties` | none | Lists the seeded specialty catalog as `{ id, name, slug }` records. |

## Availability (`/availability`) — `backend/src/modules/availability`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `GET /availability/doctors/:doctorProfileId/slots` | none | — | Lists that doctor's open, future slots. Public on purpose — a patient needs to see availability before signing in. |
| `POST /availability/doctors/:doctorProfileId/slots/generate` | doctor (self only) | `{ date: 'YYYY-MM-DD', startHour, endHour, slotLengthMinutes }` | Fixed-length, single-day generation — no recurrence engine (ARCHITECTURE.md §6.3.6 guardrail). Idempotent: re-running with an overlapping range skips slots that already exist rather than erroring or duplicating. |

## Appointments (`/appointments`) — `backend/src/modules/appointments`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /appointments` | patient | `{ availabilitySlotId }` | **The concurrency-critical endpoint** — see `ARCHITECTURE.md §5.1` and `backend/tests/integration/booking.test.mts`. `409` if the slot is no longer open. Load-tested under contention (Phase 9, issue #86) — see `backend/tests/load/README.md`. |
| `GET /appointments/mine` | patient | — | Caller's own appointments, most recent first. |
| `GET /appointments/doctor/today` | doctor | — | Caller's scheduled appointments for the current server-local calendar day, ordered by slot start time. |
| `PATCH /appointments/:appointmentId/status` | doctor (treating doctor only) | `{ status: 'completed'\|'cancelled'\|'no_show' }` | Issue #3's lifecycle, and the trigger for the referral cascade (#67): if the appointment came from a referral, the referral moves in the same transaction (completed → referral completed; cancelled → referral back to `pending` and the slot released; no-show → count++, pending until `NO_SHOW_EXPIRY_THRESHOLD` (2) then `expired`). `409` unless the appointment is still `scheduled`. |
| `PATCH /appointments/:appointmentId/cancel` | patient (own appointment) | — | Patient-side cancellation, `scheduled` only. Same slot-release + cascade behaviour as above. |

## Consultations (`/consultations` + `/appointments`) — `backend/src/modules/consultations`

Phase 2, issue #4 (close-once) and Phase 3's referral slice. The module owns
the `Consultation` row: **one writer**, `consultationsService.createConsultation`,
reached through three addresses — the appointment-scoped close route, the
`/consultations` create route, and the orders flow's consultation step (which
adds its own verified-doctor gate and delegates). Same guarantees regardless
of the address.

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /appointments/:appointmentId/consultation` | doctor (own **completed** appointment, verified email) | `{ outcome: 'resolved' \| 'referred' \| 'follow_up_needed', notes }` | Closes the appointment's consultation. `201` returns `{ consultation, appointment }`; `404` if the appointment doesn't exist **or isn't the caller's** (no existence leak); `409` if the appointment isn't `completed` or its consultation was already closed; `400` on an unknown outcome or empty/over-20k notes. |
| `POST /consultations` | doctor (own completed appointment, verified email) | `{ appointmentId, outcome?, notes? }` | The same write with the appointment in the body — Phase 3's address for it. `201` returns the consultation. `outcome` is optional here so a record can exist before sign-off; the close route above requires it. |
| `GET /consultations/:consultationId` | doctor (treating) or patient (own visit) | — | Anyone else gets `403`; unknown id `404`. `notes` comes back decrypted. |
| `POST /consultations/:consultationId/referrals` | doctor (treating, verified email) | `{ targets: [{ targetDoctorId?, targetSpecialtyId?, snapshotNotes }] }` | Issue #66 — atomic all-or-none multi-referral. Equivalent to `POST /referrals/from-consultation/:consultationId` below; both live on the referrals service, so a specialty-only target is routed at creation exactly as that row describes (issue #6). |

Once-only is a database guarantee, not an app-level check:
`Consultation.appointmentId` is `UNIQUE`, so two concurrent closes can't both
commit — the loser gets `409`. There is no amendment/edit path in v1 (an
explicit open question, not an assumption).

`notes` is clinical free text and is stored **encrypted** (AES-256-GCM
envelope, `v1:<iv>:<tag>:<data>` — ARCHITECTURE.md §4.3, issue #46); it is
returned in plaintext to the caller who just wrote it and to a permitted
reader. This requires `FIELD_ENCRYPTION_KEY_V1` (32 bytes, base64) and
optionally `FIELD_ENCRYPTION_ACTIVE_VERSION` (default `v1`) to be set; a
missing key is a `500` on the write, not a silent plaintext write. Encrypted
columns cannot be searched or indexed.

Every write also records an `AuditEvent` (`consultation.closed`) in the same
transaction, so the event exists iff the consultation was written.


## Referrals (`/referrals`) — `backend/src/modules/referrals`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /referrals` | doctor | `{ sourceConsultationId, targetDoctorId?, targetSpecialtyId?, snapshotNotes }` | Issues #5 and #6 (routing — `docs/adr/0008-referral-routing-without-target-doctor.md`). Requires: the caller's own **completed** appointment's consultation, at least one of `targetDoctorId` / `targetSpecialtyId` (`400` otherwise), no self-referral, no duplicate target for that consultation. A named doctor must be verified (and verified in `targetSpecialtyId` when given). **A specialty-only target is routed at creation to the least-loaded eligible doctor** — verified, holds the specialty, not the referring doctor, active account; fewest `pending`+`accepted` referrals, ties broken by doctor id — and the response carries the resolved `targetDoctorId`. When nobody is eligible: `422` with `code: "REFERRAL_NO_ELIGIBLE_TARGET"` and **no referral row is written**. Writes `snapshotNotes` as a copy. A repeat doctor/specialty anywhere in the lineage **flags** the referral (`loopFlaggedAt`) for the admin queue instead of failing; chains over `REFERRAL_MAX_HOPS` (default 4) and self-referrals are `422`. |
| `POST /referrals/from-consultation/:consultationId` | doctor | `{ targets: [...] }` | Issue #66 — same atomic batch as the consultations route; the decision to allow multi-referral with independent lifecycles (and no bundle table) is `docs/adr/0006-multiple-referrals-per-consultation.md`. Duplicate doctor *or* specialty inside the batch, or against an existing referral from that consultation, fails the whole batch. Each specialty-only target is routed independently (issue #6), a batch never routes one onto a doctor it names explicitly, and a target with no eligible candidate left fails the whole batch. |
| `POST /referrals/:referralId/accept` | patient (the referred patient) | `{ availabilitySlotId }` | Issue #7. Conditional `pending → accepted` (exactly one concurrent accept wins → `409`), then books a real appointment against the **target doctor** through the same slot-claim path as `POST /appointments` — the patient picks the slot; no re-intake, the snapshot travels on the referral. `409` if the slot isn't the target doctor's. Writes two audit rows in the one append-only trail: `referral.accepted` (a `Referral`-typed row) and `appointment.booked` for the appointment it booked (`origin: 'referral'`), both inside the accept's own transaction. |
| `POST /referrals/:referralId/decline` | patient (the referred patient) | — | Pending-only, terminal (`409` otherwise). Writes a `referral.declined` audit row. |
| `GET /referrals/mine` | patient | — | `{ referrals, groupedByConsultation }` — grouped for the "one visit, several referrals" view (#66). |
| `GET /referrals/created` | doctor | — | Referrals the caller created, including ones the cascade expired (see `referringDoctorNotifiedAt`) and ones the loop guard flagged. |
| `GET /referrals/admin/queue` | admin | query: `status`, `olderThan` (`48h` / `7d`), `loopFlagged` (`true`\|`false`) | Issue #68 — stuck/aged/loop-flagged referrals with a derived human-readable `reason` and `ageMinutes`. |
| `POST /referrals/admin/:referralId/reassign` | admin | `{ targetDoctorId, reason }` | **Pending referrals only.** Moves `targetDoctorId` (validated through the doctors service) — the snapshot, lineage and patient are untouched. Writes an `AuditEvent` (`referral.reassign`) in the one append-only audit trail, as a `Referral`-typed row. |
| `POST /referrals/admin/:referralId/cancel` | admin | `{ reason }` | Pending or accepted (`409` on terminal). Cancelling an accepted referral also cancels its live appointment through the appointments service. Writes an `AuditEvent` (`referral.cancel`) in the one append-only audit trail, as a `Referral`-typed row. `cancelled` is distinct from `expired`/`declined` so the three exits stay tellable apart. |
| `GET /referrals/admin/:referralId/audit-events` | admin | — | The referral's audit rows, read from the same `AuditEvent` table `GET /admin/audit-events` serves (`entityType: 'Referral'`, `entityId: <referralId>`): actor, role, action, from/to state, metadata (the admin's `reason` lives in `metadata.reason`), timestamp. |

## Payments (`/payments`) — `backend/src/modules/payments`

Phase 5.5 (custodial v1 — `docs/adr/0004-custodial-payments-v1.md`):
`POST /payments/wallet-link` (facility, sets its Stellar payout address),
and admin-gated `/payments/intents` (`POST`, `GET /:id`, plus
`POST /intents/:id/{fund,release,refund}`). `PaymentIntent.orderType` /
`orderId` are opaque and **not** FK-validated — `Prescription`/`LabOrder`
don't exist yet (Phase 4). Admin-triggered release/refund is the interim
design, not the final one.

## Orders (`/orders`) — `backend/src/modules/orders`

Verified doctors can create a consultation with `POST /orders/consultations` (`appointmentId`, optional `outcome` and `notes`) — the same write as `POST /consultations` plus the verified-doctor gate, so all of its one-per-appointment/encryption/audit rules apply. Issue a prescription with `POST /orders/consultations/:consultationId/prescriptions` (`facilityProfileId`, positive integer `amountStroops`, and `items`), or a lab order with `POST /orders/consultations/:consultationId/lab-orders` (`facilityProfileId`, `amountStroops`, `testType`, optional `urgency` and `notes`). Issuance creates its payment intent in the same transaction. Corrections create superseding immutable orders: a created intent moves to the correction; an escrowed intent remains linked to the original and is handled by the existing admin refund action.

## Audit trail (`/admin/audit-events`) — `backend/src/modules/audit`

Phase 8, issue #43. Every response carries an `X-Request-Id` header: a
well-formed inbound `X-Request-Id` (8–128 chars of `[A-Za-z0-9._:-]`) is
kept, anything else is replaced with a UUID. Audit events store it, so an
event can be traced to the request (and logs) that caused it.

| Method & path | Auth | Notes |
|---|---|---|
| `GET /admin/audit-events` | admin | Newest first. Query: `entityType`, `entityId` (requires `entityType`), `actorUserId`, `from` / `to` (ISO-8601 date or date-time, inclusive), `limit` (1–200, default 50), `cursor`. Unknown parameters are `400`. Returns `{ items, nextCursor }`; pass `nextCursor` back as `cursor` for the next page (`null` = last page). |

Item shape: `{ id, actorUserId, actorRole, entityType, entityId, action,
fromState, toState, requestId, metadata, createdAt }`. `metadata` is a small
flat map of ids/codes (never personal data). Ordering is
`(createdAt DESC, id DESC)` and the cursor is a keyset position on that
pair, so paging never skips or repeats an event; events written after a scan
started appear at the front of a new scan, not mid-way through the old one.
`400 INVALID_CURSOR` for a malformed cursor; `400` if `from` is after `to`.

Recorded today: `appointment.booked` (both the direct booking and the
referral-origin booking the accept produces — the `origin` metadata tells
them apart), `doctor.verification_status_changed`,
`payment_intent.{funded,released,refunded}`, `consultation.closed`,
`prescription.issued`, `lab_order.issued`, `referral.accepted`,
`referral.declined`, `referral.reassign`, `referral.cancel` — see
ARCHITECTURE.md §4.10. There is no write or delete
endpoint, and the table rejects UPDATE/DELETE in the database.

Payment actions (`POST /payments/intents/:id/{fund,release,refund}`) now
return `409` when the intent changed state concurrently between the check
and the write (previously the second write silently overwrote the first).

### Payment history and facility ledger (Phase 5.5, issue #90)

| Method & path | Auth | Query | Notes |
|---|---|---|---|
| `GET /payments/mine` | patient | `status`, `from`, `to`, `limit`, `cursor` | Lists only the caller's payment intents, newest first. |
| `GET /payments/facility/ledger` | facility | `status`, `from`, `to`, `limit`, `cursor` | Lists only the caller facility's intents and includes SQL-aggregated lifecycle totals. |

`limit` defaults to 50 and is capped at 100. `from` and `to` are inclusive
ISO-8601 dates or date-times; `status` is one of `created`, `escrowed`,
`released`, `refunded`, or `failed`. The opaque `nextCursor` can be passed
as `cursor`; ordering is stable by `(createdAt DESC, id DESC)`. Facility
totals apply the date filters but intentionally remain split across all
three summary statuses even when the row list has a `status` filter.

Rows include `orderType`, `orderId`, lifecycle status, amount, and the
contract/escrow/transaction references needed for an explorer link. Stroop
amounts and escrow ids are decimal strings. The current schema supports
native XLM only, so `asset` is `{ "type": "native", "code": "XLM" }`.
`refundAfter` is currently `null`: this custodial v1 contract path does not
set an on-chain refund deadline, and the schema has no such field. No
clinical order details are exposed. The facility totals object contains
`escrowed` (pending in escrow), `released`, and `refunded` sums, each as a
BigInt-safe decimal string.
## Patients (`/patients`) — `backend/src/modules/patients`

### Data export — right of access (Phase 8, issue #40)

| Method & path | Auth | Notes |
|---|---|---|
| `POST /patients/me/export` | patient | Starts an export of the **caller's own** data. `202` with the export status object and a `Location: /patients/me/export/:id` header. If one is already `pending`/`processing`, returns that one instead of queuing a second. No body is read — there is no way to name another patient. |
| `GET /patients/me/export/:id` | patient (owner) | Status object (below). `404` for an id that isn't the caller's — the same response as one that doesn't exist. |
| `GET /patients/me/export/:id/download` | patient (owner) | Streams the bundle as `application/json` (`Content-Disposition: attachment`, `Cache-Control: no-store`). `409 EXPORT_NOT_READY` while pending/processing/failed; `410 EXPORT_EXPIRED` at or after `expiresAt`, even before the cleanup job has run. |

Doctors and admins get `403` on all three — there is no on-behalf-of export.

Status object:

```json
{
  "id": "uuid",
  "status": "pending | processing | ready | failed | expired",
  "schemaVersion": 1,
  "createdAt": "…", "startedAt": "…", "generatedAt": "…", "expiresAt": "…",
  "sizeBytes": 12345,
  "failure": null,
  "downloadUrl": "/patients/me/export/<id>/download"
}
```

`downloadUrl` and `sizeBytes` are non-null only while `ready`. A failed
export reports `failure: { code: 'SECTION_FAILED', section: '<name>' }` (or
`GENERATION_FAILED` / `GENERATION_TIMEOUT`, with `section: null`) — request a
new export to retry. Generation is asynchronous; poll the status object.

Bundle (`schemaVersion` 1):

```json
{
  "format": "docforum.patient-export",
  "schemaVersion": 1,
  "exportId": "uuid",
  "generatedAt": "ISO-8601",
  "sections": {
    "account":      { "version": 1, "items": [{ "id", "email", "phone", "role", "emailVerifiedAt", "createdAt", "updatedAt" }] },
    "appointments": { "version": 1, "items": [{ "id", "status", "origin", "slot": { "startTime", "endTime" }, "doctor": { "id", "fullName" }, "createdAt", "updatedAt" }] },
    "payments":     { "version": 1, "items": [{ "id", "prescriptionId", "labOrderId", "status", "amountStroops", "facility": { "id", "name" }, "escrowId", "stellarTxHash", "sorobanContractId", "createdAt", "updatedAt" }] },
    "profile":      { "version": 1, "items": [{ "id", "fullName", "dateOfBirth", "createdAt", "updatedAt" }] }
  }
}
```

Sections are sorted by name; new modules add sections (ARCHITECTURE.md §3.1)
without changing the envelope. `amountStroops`/`escrowId` are strings
(bigint). No password hash, tokens, throttle state or platform secrets are
ever included.

Exports stay downloadable for `PATIENT_EXPORT_TTL_HOURS` (default 24), then
the cleanup job deletes the stored bundle. Other knobs: `PATIENT_EXPORT_PAGE_SIZE`,
`PATIENT_EXPORT_CHUNK_BYTES`, `PATIENT_EXPORT_WORKER_INTERVAL_SECONDS`,
`PATIENT_EXPORT_CLEANUP_INTERVAL_SECONDS`, `PATIENT_EXPORT_STALE_AFTER_SECONDS`,
`PATIENT_EXPORT_MAX_ATTEMPTS` — see `backend/src/config/index.ts` and
`backend/src/jobs/README.md`.

## Not yet implemented

`patients`, `facilities`, `prescriptions`, `lab-orders`,
`pharmacy-orders` and `notifications` have no routes yet — Phase 2
(intake), 4 (orders), 5 (facilities) and 6 (notifications), see
`ROADMAP.md`.

## Escrow chain events (/admin/payments/escrow-events)

Admin-only read endpoint. Optional state filter accepts pending, matched, or unmatched; limit is 1–200 (default 50). It returns persisted Soroban events and per-contract cursors. Unmatched release/refund events produce a high-severity structured log, an optional JSON POST to ESCROW_EVENT_ALERT_WEBHOOK_URL, and an unmatched row visible here. A retention-window failure sets catchupError on the corresponding cursor; operators must reconcile the gap before changing the configured start ledger.
