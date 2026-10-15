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
| `POST /auth/login` | none | `{ email, password }` | Same response shape as signup. `403` for a deactivated account — checked *after* the password, so it doesn't leak which addresses exist. |
| `POST /auth/signup-with-invite` | none | `{ token, email, password }` | Redeems an admin invite (Phase 8, issue #39) and signs the new admin in — same response shape as signup. `400` for an unknown/expired/already-used token, `403` if the invite was issued for a different address. |
| `POST /auth/refresh` | refresh cookie | — | Reads the httpOnly cookie (not the body). Returns a fresh `{ user, accessToken }` and rotates the cookie. |
| `POST /auth/logout` | none | — | Clears the refresh cookie. `204 No Content`. |

Access tokens: `Authorization: Bearer <token>`, 15-minute TTL, no
revocation list yet (see `ARCHITECTURE_ESSENTIALS.md` known gaps —
JWT refresh rotation without a revocation list). Refresh tokens: httpOnly
cookie, 30-day TTL, `sameSite: 'lax'`/`secure: false` — **local-dev-only
choice**, see the comment above `setRefreshCookie` in
`backend/src/modules/auth/controllers/index.ts` for what production needs.

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

## Admin account lifecycle (`/admin`) — `backend/src/modules/users`

Phase 8, issue #39. Every route here is admin-only (`authenticate` +
`requireRole('admin')`); a non-admin gets `403`.

| Method & path | Body | Notes |
|---|---|---|
| `POST /admin/invites` | `{ email }` | `201` with `{ id, email, expiresAt, token, inviteUrl }`. The raw `token` is returned **once** — only its SHA-256 hash is stored, so it can never be fetched again, and it is never logged. The inviting admin passes the link on out of band (there's no email provider yet — issue #17). `409` if the address already has an account. Issuing a new invite for the same address retires the previous one. |
| `PATCH /admin/users/:id/deactivate` | — | Soft deactivation: sets `deactivatedAt`, refuses login/refresh/existing access tokens. `409 Cannot deactivate the last active admin.` Idempotent. **Deletes nothing** — no clinical or payment record is keyed to this flag. |
| `PATCH /admin/users/:id/reactivate` | — | Clears `deactivatedAt`. Returns the user; the pre-deactivation session tokens stay revoked. |

Admins are created either by the bootstrap CLI
(`node backend/scripts/create-admin.mjs`, see `scripts/README.md`) or by
invite. `POST /auth/signup` still refuses `role: 'admin'` server-side.

Who-did-what is written to the server console (`[users] admin <id>
deactivated user <id>`): there is no `AuditEvent` table yet (see
`ARCHITECTURE_ESSENTIALS.md` known gaps), so that's the interim record.

Env: `ADMIN_INVITE_TTL_HOURS` (default 72),
`ADMIN_INVITE_ACCEPT_URL` (where the invite link points — docforum-web owns
that page).

## Not yet implemented

Everything else in `ARCHITECTURE.md` §3's module list (`patients`,
`facilities`, `consultations`, `referrals`, `prescriptions`, `lab-orders`,
`pharmacy-orders`, `payments`, `notifications`) has no routes yet — Phase
2 onward, see `ROADMAP.md`.
