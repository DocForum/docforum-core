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

## Consultations (`/consultations`) — `backend/src/modules/consultations`

Clinical notes are legal records: a draft is editable, and once signed off the
note and outcome are immutable — corrections are **addenda**. Enforced twice: the
repository scopes every write to `signedAt IS NULL`, and a `BEFORE UPDATE`
trigger rejects any change to `notes`/`outcome`/`signedAt` on a signed row, so a
direct Prisma update fails too.

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /consultations` | doctor | `{ notes?, outcome? }` | Opens a draft. `outcome` ∈ `resolved\|referred\|follow_up_needed`. `201`. |
| `GET /consultations/:id` | doctor (author) | — | `{ id, notes, outcome, signedAt, createdAt, editable, addenda: [{ id, body, createdAt, authorDoctorProfileId }] }` — addenda oldest-first. An id belonging to another doctor is a `404`. |
| `PATCH /consultations/:id` | doctor (author) | `{ notes? and/or outcome? }` | Draft only. `409` once signed off. An empty body is a `400`. |
| `POST /consultations/:id/sign-off` | doctor (author) | — | Freezes the note. `409` if already signed off. |
| `POST /consultations/:id/addenda` | doctor (author) | `{ body }` | **Post-sign-off only** (`409` while it's still a draft — edit the note instead). Append-only. `201`. |

Drafts also get signed off automatically once they're older than
`CONSULTATION_AUTO_SIGNOFF_HOURS` (default 24) — the job in
`backend/src/jobs/consultation-auto-sign-off.ts`, started from `server.ts`.
Until `Consultation.appointmentId` exists (issue #4) the window is measured from
`createdAt`, and only the authoring doctor can reach these routes; patient access
to their own care thread follows the appointment link.

## Not yet implemented

Everything else in `ARCHITECTURE.md` §3's module list (`patients`,
`facilities`, `referrals`, `prescriptions`, `lab-orders`,
`pharmacy-orders`, `notifications`) has no routes yet — Phase 2 onward, see
`ROADMAP.md`. (`consultations` now has routes; `payments` has its own
admin-triggered endpoints, documented in `docs/adr/0004`.)
