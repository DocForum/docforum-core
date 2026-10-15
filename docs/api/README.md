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
| `POST /auth/login` | none | `{ email, password }` | Same response shape as signup — **unless the user has 2FA enabled**, in which case it returns `{ mfaRequired: true, mfaPendingToken }` with no session (see the two-step sequence below). |
| `POST /auth/refresh` | refresh cookie | — | Reads the httpOnly cookie (not the body). Returns a fresh `{ user, accessToken }` and rotates the cookie. |
| `POST /auth/logout` | none | — | Clears the refresh cookie. `204 No Content`. |
| `GET /auth/2fa` | authenticated | — | `{ enabled, enabledAt, pendingEnrollment }`. |
| `POST /auth/2fa/setup` | authenticated | — | `{ otpauthUri }` to scan/enter in an authenticator app. Rejects `409` if 2FA is already enabled. Nothing is enforced until `/enable` confirms a code. |
| `POST /auth/2fa/enable` | authenticated | `{ code }` | Confirms enrollment with a first TOTP code and returns `{ recoveryCodes: [...] }` — 10 single-use codes, shown **once**, stored bcrypt-hashed. |
| `POST /auth/2fa/verify` | mfa_pending token | `{ mfaPendingToken, code }` | Second step of login. `code` is a TOTP code **or** a recovery code. Returns the normal `{ user, accessToken }` + refresh cookie. `401` on a wrong code, a replayed code, or a spent recovery code. |
| `POST /auth/2fa/disable` | authenticated | `{ code }` | Requires a current TOTP code or a recovery code — a password-authenticated request alone is not enough. `204 No Content`. |

Access tokens: `Authorization: Bearer <token>`, 15-minute TTL, no
revocation list yet (see `ARCHITECTURE_ESSENTIALS.md` known gaps —
JWT refresh rotation without a revocation list). Refresh tokens: httpOnly
cookie, 30-day TTL, `sameSite: 'lax'`/`secure: false` — **local-dev-only
choice**, see the comment above `setRefreshCookie` in
`backend/src/modules/auth/controllers/index.ts` for what production needs.

### Two-step login (2FA enabled)

```
POST /auth/login   { email, password }
  → 200 { mfaRequired: true, mfaPendingToken }        # no cookie, no access token
POST /auth/2fa/verify  { mfaPendingToken, code }
  → 200 { user, accessToken } + httpOnly refresh cookie
```

The `mfaPendingToken` is signed with the access-token secret but carries a
`scope: 'mfa_pending'` claim, and `verifyAccessToken` refuses any token that
has one — so it is **accepted by exactly one route** (this verify endpoint)
and rejected by every authenticated route (tested both directions). It expires
after 5 minutes. `code` is a 6-digit RFC 6238 TOTP code (SHA-1, 30s period,
±1 step of clock skew) or one of the recovery codes.

TOTP codes are replay-protected: the highest accepted time step is stored per
user and any code at or below it is rejected, even inside the ±1 window.
Recovery codes are single-use (bcrypt-hashed; the plaintext is returned only
from `/2fa/enable`). The TOTP secret is stored AES-256-GCM encrypted with
`TOTP_ENCRYPTION_KEY`.

`REQUIRE_2FA_FOR_ADMIN=true` makes 2FA mandatory for admin logins: an admin
without 2FA enrolled gets `403` at login. See
`ARCHITECTURE_ESSENTIALS.md` for the enrollment bootstrap caveat on that flag.

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
