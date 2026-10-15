# API docs

Phase 1 endpoints are real and tested (see `backend/tests/`). Everything
else is still unimplemented — see `ROADMAP.md` for phase order. Keep this
file in sync with `backend/src/modules/*/routes` (AGENTS.md doc-update
rule).

Base URL: `http://localhost:4000` locally (`PORT` in `.env`). No OpenAPI
spec yet — TBD, tracked informally, not blocking Phase 1.

## Auth (`/auth`) — `backend/src/modules/auth`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /auth/signup` | none | `{ role: 'patient'\|'doctor', email, password, fullName }` | **`role` is restricted to `patient`/`doctor` server-side, not just in docforum-web's UI** — facility accounts are admin-invited only (PRD OQ-2). Returns `{ user, accessToken }`; sets an httpOnly refresh cookie. |
| `POST /auth/login` | none | `{ email, password }` | Same response shape as signup. |
| `POST /auth/refresh` | refresh cookie | — | Reads the httpOnly cookie (not the body). Returns a fresh `{ user, accessToken }` and rotates the cookie. |
| `POST /auth/logout` | none | — | Clears the refresh cookie. `204 No Content`. |
| `POST /auth/password-reset/request` | none | `{ email }` | **Always `202`**, same body for a known and an unknown email — no account-existence signal. Sends a single-use link through the `notifications` module (console adapter today, provider TBD per issue #17). Rate-limited per email (3/h) and per IP (10/h) → `429`. |
| `POST /auth/password-reset/confirm` | none | `{ token, newPassword }` | `200` on success. The token is single-use, expires after 30 min, and is stored only as a SHA-256 hash. `400` with the **same generic message** for unknown, expired, reused, and superseded tokens. Success invalidates every outstanding refresh token for that user (per-user `tokenVersion` bump) and clears the refresh cookie. |

Access tokens: `Authorization: Bearer <token>`, 15-minute TTL. Refresh
tokens: httpOnly cookie, 30-day TTL, `sameSite: 'lax'`/`secure: false` —
**local-dev-only choice**, see the comment above `setRefreshCookie` in
`backend/src/modules/auth/controllers/index.ts` for what production needs.

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
| `PATCH /doctors/:doctorProfileId/verification` | admin | Body `{ status: 'pending'\|'verified'\|'rejected' }`. Manual, admin-gated per PRD FR-3 — there is no automated verification pipeline. |

## Availability (`/availability`) — `backend/src/modules/availability`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `GET /availability/doctors/:doctorProfileId/slots` | none | — | Lists that doctor's open, future slots. Public on purpose — a patient needs to see availability before signing in. |
| `POST /availability/doctors/:doctorProfileId/slots/generate` | doctor (self only) | `{ date: 'YYYY-MM-DD', startHour, endHour, slotLengthMinutes }` | Fixed-length, single-day generation — no recurrence engine (ARCHITECTURE.md §6.3.6 guardrail). Idempotent: re-running with an overlapping range skips slots that already exist rather than erroring or duplicating. |

## Appointments (`/appointments`) — `backend/src/modules/appointments`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /appointments` | patient | `{ availabilitySlotId }` | **The concurrency-critical endpoint** — see `ARCHITECTURE.md` §5.1 and `backend/tests/integration/booking.test.mts`. `409` if the slot is no longer open. |
| `GET /appointments/mine` | patient | — | Caller's own appointments, most recent first. |

## Not yet implemented

Everything else in `ARCHITECTURE.md` §3's module list (`patients`,
`facilities`, `consultations`, `referrals`, `prescriptions`, `lab-orders`,
`pharmacy-orders`, `payments`, `notifications`) has no routes yet — Phase
2 onward, see `ROADMAP.md`.
