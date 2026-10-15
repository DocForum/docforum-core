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
| `POST /auth/logout` | none | — | Clears the refresh cookie. `204 No Content`. Does **not** revoke the session — use `DELETE /auth/sessions/:id` for that. |
| `GET /auth/sessions` | authenticated | — | The caller's own active sessions: `[{ id, createdAt, lastUsedAt, userAgent, ip, current }]`, most recently used first. `current` marks the session behind the request's refresh cookie. |
| `DELETE /auth/sessions/:id` | authenticated | — | Revokes one of the caller's sessions. `204`. Another user's id is a `404` (scoped update, no existence signal). Revoking the *current* session also clears the refresh cookie in the same response. |
| `DELETE /auth/sessions` | authenticated | — | "Sign out everywhere else": revokes every session of the caller **except** the current one. `200 { revoked }`. |
| `DELETE /admin/users/:id/sessions` | admin | — | Revokes every session for a user. `200 { revoked }`. Mounted under `/admin`, not `/auth` — it acts on someone else's sessions. |

Access tokens: `Authorization: Bearer <token>`, 15-minute TTL, stateless —
**no revocation check**, so a revoked session's access token keeps working
until it expires (≤15 min). Refresh tokens: httpOnly cookie, 30-day TTL,
`sameSite: 'lax'`/`secure: false` — **local-dev-only choice**, see the comment
above `setRefreshCookie` in `backend/src/modules/auth/controllers/index.ts`
for what production needs.

Every login/signup creates a `RefreshSession` row and returns `sessionId` in
the body; the refresh JWT carries `sid` and `POST /auth/refresh` only succeeds
while that row exists and is unrevoked. Revocation therefore takes effect on
the next refresh. Refresh rotates the tokens but keeps the same session (same
family) — a new row per refresh would make "list my sessions" meaningless — and
it is the **only** place `lastUsedAt` is written, so there's no session write on
every authenticated request. Tokens minted before session records existed carry
no `sid` and are rejected: the migration logs existing sessions out once.

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
