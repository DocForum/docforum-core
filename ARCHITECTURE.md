# ARCHITECTURE.md — DocForum

Status: Draft v0.1
Last updated: 2026-09-09

> **Contribution rule:** Any PR that changes a data model, a service boundary, or the tech stack must update this file in the same PR, and reflect the essentials in `ARCHITECTURE_ESSENTIALS.md`. Also update `ROADMAP.md` status if the change closes/opens roadmap work.

See `PRD.md` for product scope and `ARCHITECTURE_ESSENTIALS.md` for the quick-reference version.

---

## 1. Guiding principles

1. **Modular monolith first, not microservices.** One deployable backend, internally organized into bounded modules (auth, doctors, appointments, referrals, consultations, orders, facilities, notifications). Split into services only when a concrete scaling or team-ownership problem demands it — not preemptively (see PRD §8.3).
2. **Orders are append-only.** Prescriptions and lab orders are never mutated after issuance. Corrections create a new versioned record referencing the original. This is a hard architectural constraint, not a style preference (clinical/legal safety).
3. **The referral carries state, not a pointer to state.** A referral snapshots the intake + consultation notes it's built on, so later edits elsewhere can't silently rewrite what a specialist already saw.
4. **Boring tech, correct concurrency.** Availability booking is a correctness problem before it's a scaling problem — solve double-booking with real DB constraints/transactions, not application-level checks.
5. **Build vs. buy for anything not core IP.** Video/chat infra, SMS/email delivery, file storage — use managed providers behind an internal interface so they're swappable.

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Backend language/runtime | Node.js (TypeScript) | Single language across stack, large ecosystem, easy hiring. |
| Backend framework | Express 5 — **decided 2026-09-14**, resolving the "(or Fastify)" either/or | Minimal, unopinionated, matches "modular monolith" — avoid a heavy framework that fights the module boundaries. Express 5's native async-handler error forwarding (rejected promises reach the error middleware without a manual wrapper) was a real factor, not just familiarity. |
| Request validation | Zod | Not originally listed here — added alongside Phase 1's real request bodies. Schemas live per-module (`modules/*/validation.ts`), thrown `ZodError`s are caught centrally by `middleware/error-handler.ts`. |
| Password hashing | bcryptjs | Pure-JS, not a native bcrypt binding — one less native build dependency for a repo with no other native deps yet. |
| Database | PostgreSQL | Relational integrity is critical (bookings, orders, referrals all have strict FK/state constraints); JSONB available for the flexible parts (intake payload). |
| ORM / schema | Prisma | Schema-as-code, migrations, keeps `backend/prisma/schema.prisma` as the single source of truth for data models (mirrors §4 below). |
| Auth | JWT access + refresh tokens, role claims (`patient` \| `doctor` \| `facility` \| `admin`) | Simple, stateless for API scaling; refresh rotation for security. |
| Frontend | React + TypeScript, Vite | Fast dev loop, standard choice, no framework lock-in beyond React. |
| Frontend state/data | React Query (server state) + lightweight store (Zustand) for client-only UI state | Avoids over-centralizing server data into a global store. |
| Realtime (messaging/notifications) | WebSocket gateway (or managed pub/sub, e.g. Pusher/Ably) behind an internal `notifications` interface | Swappable; not custom infra from day one. |
| Video/voice (if/when needed) | Third-party embed (Twilio/Daily/Agora) behind an interface, not built in-house | PRD §8.3.1 — explicitly flagged as overengineering risk if built custom. |
| File/result storage | Object storage (S3-compatible) for lab result attachments | Never store clinical files directly in Postgres rows. |
| Background jobs | Simple queue (BullMQ on Redis) for reminders, order-expiry checks, notification delivery | Needed for FR-15/16 and the "orphaned order" hard question (PRD §8.1.3). |
| Infra | Docker Compose for local dev; containerized deploy target TBD (not decided — see Open Questions in ROADMAP) | Keep infra decisions deferred until a real deploy target is chosen; don't overbuild CI/CD for a repo with no code yet. |

## 3. Module boundaries (backend)

Each module under `backend/src/modules/<name>/` owns its own `routes/`, `controllers/`, `services/`, `repositories/`. Cross-module access happens through a module's exported service interface only — **never reach into another module's repository directly.** This is the internal seam that would let us extract a module into its own service later without a rewrite.

- `auth` — signup/login, tokens, role checks.
- `users` — shared user profile fields common to all roles.
- `patients` — patient-specific profile data.
- `doctors` — doctor profile, specialties, verification status.
- `facilities` — lab/pharmacy accounts, capability tags (what order types they can fulfill).
- `availability` — slot generation and holds (the module responsible for preventing double-booking).
- `appointments` — booking lifecycle, links patient + doctor + slot + intake.
- `consultations` — the record of what happened in a booked appointment (notes, outcome). Minimal slice is real (create against one's own completed appointment, read for that doctor + the patient, spawn referrals); sign-off/addenda stay issue #4.
- `referrals` — referral creation, lifecycle, snapshot of context, loop flags, the appointment-status cascade, and the admin queue/override operations. This is the most cross-wired module: it creates appointments through `appointments`' service, and `appointments` calls back into `referrals`' service (`applyAppointmentOutcome`) from inside its status-transition transaction. That mutual service-to-service import is deliberate and runtime-safe under ESM live bindings (every cross-call happens in an async function, after both modules have loaded) — the alternative, either module reaching into the other's repository, is what hard rule 4 exists to prevent.
- `prescriptions` — prescription issuance and versioning.
- `lab-orders` — lab order issuance and versioning.
- `pharmacy-orders` — fulfillment-side record for prescriptions at a specific pharmacy (kept distinct from `prescriptions` itself — see data model note in §4.7).
- `notifications` — outbound notification dispatch, provider-agnostic.

## 4. Data models

Canonical source of truth: `backend/prisma/schema.prisma`. This section is the human-readable mirror — if they drift, the schema file wins and this doc should be corrected in the same PR.

**Phase 1 models are real** (User, PatientProfile, DoctorProfile, Specialty, DoctorSpecialty, FacilityProfile, FacilityCapability, AvailabilitySlot, Appointment) — migrated via `backend/prisma/migrations/20260914110638_init/`. **Phase 3 added Consultation, Referral and AuditEvent** — migrated via `backend/prisma/migrations/20261016214929_referral_phase3/`; §4.3, §4.4 and §4.10 describe what actually shipped, not a sketch. Everything else below (§4.5 onward) is still the Phase 0 structural placeholder.

Three intentional deviations from the original sketches, all flagged in the schema file itself: `Appointment.intakeId` is deferred (nullable-by-omission, not yet a column) since `IntakeForm` doesn't exist until Phase 2; `PatientProfile.guardianUserId` is a plain string with no FK relation, since the minor/dependent consent model (§8.2.5 in PRD.md) is still an open question, not resolved here; and `Referral.snapshotIntakeId` likewise has no column yet (there is no `IntakeForm` to snapshot) — the intake half of the snapshot rule cannot be violated while there is no intake data at all, and the column must be added (as a copy) when issue #1 lands.

### 4.1 User / Role model
```
User
  id, email, phone, password_hash, role (enum: patient|doctor|facility|admin)
  email_verified_at (nullable — Phase 8 issue #34; null = unverified.
    Backfilled to created_at for pre-existing rows in the
    add_email_verification migration, so accounts from before this phase
    are treated as verified)
  created_at, updated_at

EmailVerificationToken (Phase 8 issue #34)
  id, user_id (FK -> User), token_hash (unique, SHA-256 — raw token never stored)
  expires_at, consumed_at (nullable), created_at
  # Append-only-ish: issuing a new token marks any outstanding one consumed
    ("latest link wins") rather than deleting it. Redemption is a conditional
    UPDATE (consumed_at IS NULL), same single-use shape as §5.1's booking
    guarantee, so two concurrent redemptions can't both win.

PatientProfile (1:1 User)
  id, user_id, full_name, date_of_birth, guardian_user_id (nullable — see PRD edge case: minors)

DoctorProfile (1:1 User)
  id, user_id, full_name, verification_status (enum: pending|verified|rejected)
  specialties: DoctorSpecialty[]

Specialty (controlled vocabulary, admin-managed)
  id, name, slug

DoctorSpecialty (join table)
  id, doctor_profile_id, specialty_id

FacilityProfile (1:1 User)
  id, user_id, name, type (enum: lab|pharmacy), capabilities: FacilityCapability[]

FacilityCapability
  id, facility_profile_id, capability_type (enum: lab_test|medication_dispense), detail (e.g. test category)
```

### 4.2 Availability & Appointments
```
AvailabilitySlot
  id, doctor_profile_id, start_time, end_time, status (enum: open|held|booked)
  # Uniqueness/exclusion constraint at DB level on (doctor_profile_id, start_time, end_time)
  # to make double-booking a constraint violation, not an app-logic bug.

Appointment
  id, patient_profile_id, doctor_profile_id, availability_slot_id (FK, unique, NULLABLE)
  intake_id (FK -> IntakeForm — still not a column, Phase 2 issue #1/#2)
  status (enum: scheduled|completed|cancelled|no_show)
  origin (enum: direct_booking|referral), referral_id (nullable FK -> Referral)
  created_at, updated_at
  # availability_slot_id is nullable (Phase 3): a cancelled appointment
  # releases its slot back to `open` and drops the unique link, so the
  # freed slot can be re-booked. The booking guarantee itself is
  # unchanged — it lives in claimOpenSlot's conditional UPDATE, not in
  # this column. History rows keep their referral_id, so the lineage of a
  # referral that produced several appointments survives the link being
  # cleared (Referral.appointments holds the full list).

IntakeForm
  id, patient_profile_id, symptoms (structured: array of {symptom, duration, severity}), free_text_notes
  created_at
```

### 4.3 Consultation
```
Consultation
  id, appointment_id (FK, unique — one consultation per appointment;
    a re-visit is a new appointment, not a second row)
  notes, outcome (enum: resolved|referred|follow_up_needed)
  created_at, updated_at
  referrals: Referral[]   # children — the lineage loop detection walks
```
Real as of Phase 3 (issue #5's minimal slice): created by the treating
doctor against their own **completed** appointment, and readable only by
that doctor and the patient of the underlying appointment. What is still
open is issue #4's fuller workflow — sign-off, addenda, a doctor editing
notes after the fact — which is exactly why the referral snapshot (§4.4)
exists rather than referrals reading this row live.

### 4.4 Referral
```
Referral
  id
  patient_profile_id (FK -> PatientProfile)
  source_consultation_id (FK -> Consultation, required)
  referring_doctor_id, target_doctor_id (both FK -> DoctorProfile, required)
  target_specialty_id (nullable FK -> Specialty — denormalised label, used
    by the loop guard and admin views; not issue #23's specialty management)
  snapshot_notes (text copy of the referring consultation notes — immutable)
  parent_referral_id (nullable self-FK — the referral whose appointment
    produced the consultation this referral came from; this is the chain
    loop detection walks)
  status (enum: pending|accepted|declined|completed|expired|cancelled)
  no_show_count (Int, default 0), referring_doctor_notified_at (nullable)
  loop_flagged_at (nullable), loop_flag_reason (nullable text)
  cancelled_reason (nullable text)
  resulting_appointment_id (nullable FK -> Appointment, unique — the
    appointment this referral *currently* produced)
  created_at, updated_at
  indexes: patient_profile_id, referring_doctor_id, target_doctor_id,
    status, loop_flagged_at
```
Design note: `snapshot_notes` deliberately duplicates `Consultation.notes`
rather than pointing live at it, so a later edit to the original
consultation can never silently change what the specialist already acted
on (PRD hard question 8.1.4). `snapshotIntakeId` from the original design
has no column yet — see the §4 intro note.

The other six fields are all Phase 3 issue work: `parentReferralId` +
`loop_flagged_*` are loop detection (#65), `no_show_count` +
`referring_doctor_notified_at` are the no-show cascade (#67),
`cancelled_reason` is admin override (#68), and `target_doctor_id` being
**required** is the explicit v1 re-scope of the routing gap (§6.1.2 — the
ADR for specialty-only routing is still owed, issue #6).

Status transitions that exist today:
`pending → accepted` (patient accept, conditional UPDATE — the same
concurrency shape as `claimOpenSlot`), `pending → declined` (patient),
`accepted → completed` (referral-origin appointment completed),
`accepted → pending` (appointment cancelled or first no-show — bookable
again, same snapshot, no re-intake), `accepted → expired` (second
no-show, threshold `NO_SHOW_EXPIRY_THRESHOLD = 2`), and
`pending|accepted → cancelled` (admin, audited — `AuditEvent`, §4.10).

### 4.5 Prescriptions (versioned, append-only)
```
Prescription
  id, consultation_id (FK), patient_profile_id, prescribing_doctor_id
  status (enum: issued|fulfilled|expired|superseded)
  supersedes_prescription_id (nullable, self-FK — corrections create a new row)
  created_at

PrescriptionItem
  id, prescription_id (FK), drug_name, dosage, frequency, duration
```

### 4.6 Lab orders (versioned, append-only)
```
LabOrder
  id, consultation_id (FK), patient_profile_id, ordering_doctor_id
  test_type, urgency (enum: routine|urgent), notes
  status (enum: issued|fulfilled|expired|superseded)
  supersedes_lab_order_id (nullable, self-FK)
  created_at

LabResult
  id, lab_order_id (FK, unique), fulfilling_facility_id, result_file_url, summary
  created_at
```

### 4.7 Fulfillment (facility-side)
```
FulfillmentRecord
  id, order_type (enum: prescription|lab_order), order_id (polymorphic ref)
  facility_id, status (enum: pending|in_progress|fulfilled|rejected)
  created_at, updated_at
```
Design note: kept separate from `Prescription`/`LabOrder` so a facility's operational status doesn't need write access to the clinical order record itself — it only writes to its own fulfillment row. Reduces blast radius of a compromised/misbehaving facility account.

### 4.8 Notifications
```
Notification
  id, user_id, type, payload (jsonb), read_at (nullable), created_at
```

### 4.9 Auth hardening state (Phase 8)
```
LoginAttempt (issue #35)
  id, scope ('email' | 'ip'), key, failed_count, window_start, last_failed_at
  lock_until (nullable), created_at, updated_at
  # unique (scope, key). One bucket per normalised email and per client IP.
  # Deliberately in Postgres, not process memory: the deployment is a single
  # instance today but must not be designed as one forever, and a restart
  # must not hand an attacker a fresh budget.
  # Counters move only via a single conditional upsert (INSERT ... ON
  # CONFLICT DO UPDATE) — never read-then-write — so N concurrent bad logins
  # are counted as N (integration-tested).
  # The lock is set once per window; hammering a locked account grows the
  # count but never extends the deadline, so a lock is a bounded wait.
```
`User` fields added in Phase 8 live in §4.1; the `email_verified_at` /
`EmailVerificationToken` pair (issue #34) is in §4.1 as well.

### 4.10 Audit events (Phase 3, issue #68)
```
AuditEvent
  id, actor_user_id, actor_role ('admin'|'doctor'|'patient'|'system')
  action (e.g. 'referral.reassign', 'referral.cancel')
  referral_id (nullable FK -> Referral), reason (text, nullable), metadata (jsonb)
  created_at
  indexes: referral_id, action, created_at
```
Append-only by construction — a separate table rather than columns
smeared onto `Referral`, because an audit trail that overwrites itself
isn't one. Generic enough to grow order/prescription actions later without
a migration. Only referral admin actions write here today; §6.2.4 records
what still isn't audited.

## 5. Key flows (sequence-level, not code)

### 5.1 Booking (concurrency-safe)
1. Client requests open slots for a doctor.
2. Client attempts to book a specific `AvailabilitySlot` → backend runs this inside a DB transaction with a row-level lock / conditional update (`UPDATE ... WHERE status = 'open'`), so a second concurrent booking attempt on the same slot fails atomically instead of racing.
3. On success, `Appointment` is created referencing the now-`booked` slot.

### 5.2 Referral (Phase 3 — issues #5/#7/#65–#68)
1. Doctor records a `Consultation` against their own **completed** appointment, then creates one or more `Referral`s from it (`POST /referrals`, or the atomic batch `POST /referrals/from-consultation/:id` / `POST /consultations/:id/referrals`) — each target gets its own `snapshot_notes` copy. v1 requires a **concrete, verified** `target_doctor_id`; a "specialty, no doctor" referral is the still-open routing gap (§6.1.2), not something this path silently defaults.
2. Creation is one transaction: gates (own consultation, completed appointment, no self-referral, target verified [+ in specialty], no duplicate target in this consultation), lineage lookup (`parent_referral_id` via consultation → appointment → referral), then the loop walk (PRD §8.1.2 / issue #65) — a repeat doctor/specialty in the chain **flags** the referral for the admin queue rather than blocking it; exceeding the hop limit (`REFERRAL_MAX_HOPS`, default 4) hard-rejects with 422.
3. Patient must **accept** (PRD OQ-3): `POST /referrals/:id/accept` does a conditional `pending → accepted` UPDATE (exactly one concurrent accept wins) and books a real `Appointment` against the target doctor through the appointments service — same `claimOpenSlot` path as a direct booking, `origin: 'referral'`, patient picks the slot, and no re-intake happens because the snapshot travels on the referral. Decline is `pending → declined`, terminal.
4. The appointment's own status transition then cascades back into the referral inside the same transaction (issue #67): `completed →` referral `completed`; `cancelled →` referral back to `pending` (slot released, re-bookable, same snapshot); `no_show →` count++ and back to `pending`, except at `NO_SHOW_EXPIRY_THRESHOLD` (2) where it becomes `expired` with `referring_doctor_notified_at` set. Every one of these writes is conditional on the referral still being `accepted` and still pointing at that appointment, so a hook firing twice is a no-op.
5. Admin override (issue #68): `GET /referrals/admin/queue` (stuck/aged/loop-flagged, with a derived reason), reassign a **pending** referral to another verified doctor (target column only — snapshot untouched), cancel a `pending`/`accepted` referral with a reason (closing its live appointment through the appointments service). Reassign and cancel each write an `AuditEvent` (§4.10), readable at `GET /referrals/admin/:id/audit-events`.
6. The "zero verified doctors in that specialty" dead end (PRD edge case 8.2.2) **cannot be constructed** in v1: a referral cannot exist without naming a verified target doctor (and being verified in the claimed specialty when one is claimed). The specialty-only case — where the patient would wait for *any* specialist — remains the §6.1.2 routing ADR (issue #6), not an implemented "waiting" state.

### 5.3 Order issuance and fulfillment
1. Specialist issues `Prescription` and/or `LabOrder` from a `Consultation`.
2. Patient views eligible facilities filtered by `FacilityCapability` matching the order.
3. Patient selects a facility → `FulfillmentRecord` created (`pending`).
4. Facility updates its own `FulfillmentRecord` status; for labs, attaches `LabResult`.
5. Order's own `status` field is updated to `fulfilled` only via this facility-confirmed path — patient/doctor cannot self-mark it.

## 6. Hard questions (architecture-level — see PRD §8 for product-level)

### 6.1 What do we think would break?
1. Naive slot booking without the DB-level conditional update in §5.1 — the most likely first bug filed against this repo. **Resolved 2026-09-14:** implemented exactly as designed in §5.1 — see `backend/src/modules/availability/repositories/index.ts` (`claimOpenSlot`) and `backend/src/modules/appointments/services/index.ts` (`bookSlot`, the transaction wrapping it). Integration-tested with real concurrency in `backend/tests/integration/booking.test.mts`.
2. `Referral.target_doctor_id` left nullable with no fallback assignment logic — referrals to "a specialty" with no specific doctor need a real routing rule (round robin? load-based?) or they'll pile up unassigned. **Re-scoped for v1, 2026-10-17 (Phase 3):** rather than ship a nullable column with no assignment logic (the failure mode this item predicts), `target_doctor_id` is **required** — a referral cannot be created without a concrete, verified target doctor, so nothing can pile up unassigned. The routing ADR for specialty-only referrals is still owed (issue #6) and the gap stays open until it lands; note also that this makes PRD §8.2.2's "zero verified doctors in the specialty" state unreachable-by-construction rather than surfaced as a distinct "waiting for a specialist" state, which is a deliberate scope reduction to flag in review.
3. Polymorphic `FulfillmentRecord.order_id` (§4.7) — polymorphic FKs are a known footgun for referential integrity in Postgres. Needs either two separate tables (`PrescriptionFulfillment`, `LabOrderFulfillment`) or a check-constraint + application-level guard. **Current schema sketch is a simplification that should be revisited before implementation**, not treated as final.
4. JWT refresh rotation without a revocation list — a stolen refresh token has no clean kill switch until this is added.
5. **Discovered 2026-10-15 while building email verification (Phase 8, issue #34):** the email/SMS provider is still undecided (Phase 6, issue #17), so verification links can't actually be delivered in a hosted environment yet — `backend/src/modules/auth/services/email-dispatcher.ts` is a no-op seam until a provider is integrated. Until then `backend/scripts/mark-email-verified.mjs` is the documented out-of-band path for an operator with DB access. Not a reason to skip the guard: the guard is what makes the flow safe once delivery exists, and shipping it locked-off would just mean shipping it untested.

### 6.2 What edge cases are we missing (architecture-level)?
1. What happens to `AvailabilitySlot.status = 'held'` if a booking transaction fails/times out mid-flight — is there a TTL to release the hold? (Needed or slots leak into permanent limbo.)
2. Referral `expired` status exists in the enum but no expiry job is designed yet — orphaned referrals (PRD 8.1.3 sibling problem). **Partly addressed 2026-10-17 (Phase 3, issue #67):** repeated no-shows now drive a referral to `expired` (`NO_SHOW_EXPIRY_THRESHOLD = 2`, with `referring_doctor_notified_at` set as the seam Phase 6's notification layer will read). What is still missing is **time-based** expiry — a pending referral nobody ever accepts, or one whose target doctor never offers a slot, has no TTL and no worker. Tracked as issue #8; per §6.3.2 it should ship as a simple interval/cron, not a queue.
3. No schema support yet for a doctor working across multiple facilities/locations (PRD edge case 6) — `AvailabilitySlot` currently assumes one calendar per doctor.
4. ~~No audit-log table~~ **Partly resolved 2026-10-17 (Phase 3, issue #68):** `AuditEvent` (§4.10) now exists and records referral admin actions (`referral.reassign`, `referral.cancel`) with actor, role, reason and metadata. What it does *not* yet cover: every other mutation domain — auth (the admin `login-attempts/clear` escape hatch is still console-logged only), payments, booking, and orders once Phase 4 lands. PRD §7 auditability is therefore "a real mechanism exists" rather than "auditability is done"; remaining coverage stays an open gap.
5. CSRF on the cookie-authenticated routes — the refresh cookie has to be `SameSite=None; Secure` (the Pages frontend is a different site — see `docs/adr/0003`), which means any site the patient visits can make their browser send it to `/auth/refresh` and `/auth/logout`. **Resolved 2026-10-15 (issue #37):** a per-session CSRF token is bound into the refresh token and required in the `X-CSRF-Token` header, the `Origin` header is validated against an explicit allowlist, and CORS is now a per-environment allowlist (`CORS_ORIGINS`) instead of one configured string. The double-submit cookie pattern — the usual answer — is *not* usable here: a cookie set by this API is a third-party cookie to `docforum.github.io`, so the frontend's JavaScript can never read it; the token travels in the login/refresh response body instead. A request with no `Origin` (curl, server-to-server) is allowed through the Origin check but still needs the token. See `backend/src/middleware/csrf.ts`, and `docs/api/README.md` for what the client must send. Consequence: refresh cookies issued before this change carry no `csrf` claim and are rejected, i.e. existing sessions need one re-login.

### 6.3 What's overengineered (architecture-level, for v1)?
1. Polymorphic fulfillment design (§4.7) may itself be premature abstraction — two small, boring, separate tables might beat one clever polymorphic one at this stage. Flagged as a design smell to revisit, not shipped as-is.
2. BullMQ/Redis job queue before there's a single job that needs it — fine to stub with a simple cron/interval check initially and introduce a real queue when reminder/expiry logic actually exists.
3. Designing for horizontal service extraction (module boundary purity, §3) before there's a single reason to split — worth doing lightly (it's cheap discipline), but not worth extra ceremony (e.g., separate repos, separate CI, internal API versioning) yet.

## 7. Non-functional / cross-cutting

- **Testing**: unit tests per module (`backend/tests/unit`), integration tests for booking/referral/order flows specifically because those are the correctness-critical paths (`backend/tests/integration`).
- **Security — login throttling (Phase 8, issue #35)**: `POST /auth/login` is throttled per normalised email *and* per client IP, in Postgres (`LoginAttempt`, §4.9): exponential backoff with `Retry-After` from `LOGIN_THROTTLE_BACKOFF_AFTER` failures, a temporary lock at `LOGIN_THROTTLE_LOCK_AFTER`, and a cleanup interval in `src/server.ts`. Two things this depends on operationally: (1) `TRUST_PROXY` must be set correctly in production — Render terminates TLS in front of exactly one hop, so `TRUST_PROXY=1`; leaving it unset makes every request look like Render's proxy (one shared bucket for everyone), and `true` lets a client spoof `X-Forwarded-For` for a fresh bucket per request; (2) the throttle deliberately does not reveal whether an account exists — locked, backoff and unknown-account responses are identical, and an absent account still pays the bcrypt comparison cost so response timing doesn't leak either.
- **Migrations**: Prisma migrations are the only way schema changes happen — no manual DB edits, ever.
- **Environments**: local (Docker Compose), staging, production — staging/production infra choice is an open item (see ROADMAP).

## 8. Explicit non-decisions (deferred, not forgotten)

- Deployment target (Fly.io / Render / AWS / etc.) — still undecided for
  production. A Render free-tier instance exists as a **preview only**
  (so `docforum-web`'s GitHub Pages preview has a live backend to call) —
  see `docs/adr/0003-render-preview-deployment.md`. Explicitly not this
  decision: no secrets manager, no backups, disposable data, 30-day
  free-tier DB expiry.
- Video/voice provider — undecided, PRD OQ-1 must resolve first.
- Multi-region / i18n — not designed for, not blocked either.
