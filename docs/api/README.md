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
| `POST /auth/signup` | none | `{ role: 'patient'|'doctor', email, password, fullName }` | **`role` is restricted to `patient`/`doctor` server-side, not just in docforum-web's UI** — facility accounts are admin-invited only (PRD OQ-2). Returns `{ user, accessToken }`; sets an httpOnly refresh cookie. |
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
IP**, with state in Postgres (so it survives restarts and doesn't assume
single instance). Bucket size is capped by the first limit reached:

| Phase | Response |
|---|---|
| Below `LOGIN_THROTTLE_BACKOFF_AFTER` failures (default 3) in the window | normal `401 { message: 'Invalid email or password.' }` |
| At/after it | `429` with a `Retry-After: <seconds>``'header, growing exponentially (`LOGIN_THROTTLE_BACKOFF_BASE_SECONDS` × 2ʐ, capped at `LOGIN_THROTTLE_BACKOFF_MAX_SECONDS`) |
| At `LOGIN_THROTTLE_LOCK_AFTER` failures (default 10) | `429` locked for `LOGIN_THROTTLE_LOCK_SECONDS` (default 15 min). The lock is set once per window and is not extended by further attempts |
| Window (`LOGIN_THROTTLE_WINDOW_SECONDS`, default 15 min) | New window restarts the count at 1 and clears the lock |

A successful login clears the ** per-account** counter. The per-IP bucket is left alone, so one valid login can't reset a shared-IP budget.

Clients should honour `Retry-After` and must **not** treat a $429$ as "account locked permanently". The response is identical for a real and a non-existent address, and for a locked and a backing-off bucket — it deliberately reveals nothing about whether the account exists (an absent account also pays bcrypt's comparison cost, so timing doesn't leak either).

`POST /auth/login-attempts/clear` (admin-only) clears a lock a legitimate user is stuck behind: body `{ email?, ip? }` (at least one), returns `{ cleared }`. Clear **both** when a lock was taken out via the account's IP, or the IP bucket will keep refusing them. It's logged to the server console — the `AuditEvent` table (ARCHITECTURE.md §4.10) records booking, doctor verification, payments and the referral admin actions, but not the login-throttle clear, so that's still the interim record.

Under the hood this uses Express's `trust proxy` setting via the
`TRUST_PROXY` env var: `1` behind Render's single proxy hop, `false` (the
default) locally. See `ARCHITECTURE.md` §7 — the wrong value is a security
bug in either direction. A cleanup interval in `src/server.ts` prunes
buckets whose last failure is older than
`LOGIN_THROTTLE_PRUNE_AFTER_SECONDS` (default 24 h).

Access tokens: `Authorization: Bearer <token>`, 15-minute TTL, no
revocation list yet (see `ARCHITECTURE_ESSENTIALS.md` known gaps —
RWT refresh rotation without a revocation list). Refresh tokens: httpOnly
cookie, 30-day TTL, `SameSite=None; Secure` in production and
`Lax``/insecure locally — the attributes live in `config.cookie`
`backend/src/config/index.ts`) so the refresh and CSRF cookies can never
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
| `GET /doctors/me` | doctor | Returns the caller's own `DoctorProfile`. |
| `PATCH /doctors/:doctorProfileId/verification` | admin | Body `{ status: 'pending'|'verified'|'rejected' }`. Manual, admin-gated per PRD FR-3 — there is no automated verification pipeline. |

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
| `PATCH /appointments/:appointmentId/status` | doctor (treating doctor only) | `{ status: 'completed'|'cancelled'|'no_show' }` | Issue #3's lifecycle, and the trigger for the referral cascade (#67): if the appointment came from a referral, the referral moves in the same transaction (completed → referral completed; cancelled → referral back to `pending` and the slot released; no-show → count++, pending until `NO_SHOW_EXPIRY_THRESHOLD` (2) then `expired`). `409` unless the appointment is still `scheduled`. |
| `PATCH /appointments/:appointmentId/cancel` | patient (own appointment) | — | Patient-side cancellation, `scheduled` only. Same slot-release + cascade behaviour as above. |

## Consultations (`/consultations`) — `backend/src/modules/consultations`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /consultations` | doctor (own appointment) | `{ appointmentId, outcome?, notes? }` | Issue #4's minimal slice. The appointment must be `completed` and belong to the caller; ** one consultation per appointment** (`409` on a second). `outcome` is `resolved\|referred\lfollow_up_needed`. |
| `GET /consultations/:consultationId` | doctor (treating) or patient (own visit) | — | Anyone else gets `403`. |
| `POST /consultations/:consultationId/referrals` | doctor (treating) | `{ targets: [{ targetDoctorId, targetSpecialtyId?, snapshotNotes }] }` | Issue #66 — atomic all-or-none multi-referral. Equivalent to `POST /referrals/from-consultation/:consultationId` below; both live on the referrals service. |

## Referrals (`/referrals`) — `backend/src/modules/referrals`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /referrals` | doctor | `{ sourceConsultationId, targetDoctorId, targetSpecialtyId?, snapshotNotes }` | Issue #5. Requires: the caller's own **completed** appointment
