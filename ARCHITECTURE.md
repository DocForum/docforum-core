# ARCHITECTURE.md — DripsWave

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
- `consultations` — the record of what happened in a booked appointment (notes, outcome).
- `referrals` — referral creation, lifecycle, snapshot of context.
- `prescriptions` — prescription issuance and versioning.
- `lab-orders` — lab order issuance and versioning.
- `pharmacy-orders` — fulfillment-side record for prescriptions at a specific pharmacy (kept distinct from `prescriptions` itself — see data model note in §4.7).
- `notifications` — outbound notification dispatch, provider-agnostic.

## 4. Data models

Canonical source of truth: `backend/prisma/schema.prisma`. This section is the human-readable mirror — if they drift, the schema file wins and this doc should be corrected in the same PR.

**Phase 1 models are now real** (User, PatientProfile, DoctorProfile, Specialty, DoctorSpecialty, FacilityProfile, FacilityCapability, AvailabilitySlot, Appointment) — migrated via `backend/prisma/migrations/20260914110638_init/`. Everything else below (§4.3 onward) is still the Phase 0 structural placeholder. Two intentional deviations from the sketches below, both flagged in the schema file itself: `Appointment.intakeId` is deferred (nullable-by-omission, not yet a column) since `IntakeForm` doesn't exist until Phase 2; `PatientProfile.guardianUserId` is a plain string with no FK relation, since the minor/dependent consent model (§8.2.5 in PRD.md) is still an open question, not resolved here.

### 4.1 User / Role model
```
User
  id, email, phone, password_hash, role (enum: patient|doctor|facility|admin)
  created_at, updated_at

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
  id, patient_profile_id, doctor_profile_id, availability_slot_id (FK, unique)
  intake_id (FK -> IntakeForm)
  status (enum: scheduled|completed|cancelled|no_show)
  origin (enum: direct_booking|referral), referral_id (nullable FK -> Referral)
  created_at, updated_at

IntakeForm
  id, patient_profile_id, symptoms (structured: array of {symptom, duration, severity}), free_text_notes
  created_at
```

### 4.3 Consultation
```
Consultation
  id, appointment_id (FK, unique)
  notes, outcome (enum: resolved|referred|follow_up_needed)
  created_at
```

### 4.4 Referral
```
Referral
  id, source_consultation_id (FK)
  referring_doctor_id, target_specialty_id, target_doctor_id (nullable)
  snapshot_intake_id (FK -> IntakeForm, copy reference, immutable)
  snapshot_notes (text copy of the referring consultation notes at time of referral — immutable)
  status (enum: pending|accepted|declined|completed|expired)
  resulting_appointment_id (nullable FK -> Appointment)
  created_at, updated_at
```
Design note: `snapshot_notes` and `snapshot_intake_id` deliberately duplicate data rather than pointing live at `Consultation.notes`, so a later edit to the original consultation can never silently change what the specialist already acted on (PRD hard question 8.1.4).

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

## 5. Key flows (sequence-level, not code)

### 5.1 Booking (concurrency-safe)
1. Client requests open slots for a doctor.
2. Client attempts to book a specific `AvailabilitySlot` → backend runs this inside a DB transaction with a row-level lock / conditional update (`UPDATE ... WHERE status = 'open'`), so a second concurrent booking attempt on the same slot fails atomically instead of racing.
3. On success, `Appointment` is created referencing the now-`booked` slot.

### 5.2 Referral
1. Doctor closes a `Consultation` with outcome `referred`, selects `target_specialty` (+ optional specific doctor).
2. Backend creates `Referral` with an immutable snapshot of intake + notes.
3. Patient is notified, must **accept** (PRD OQ-3) before a new `Appointment` is generated against the target doctor's availability — accepting reuses the snapshot, so the patient does not re-fill intake.
4. If no specialist is available in that specialty (PRD edge case 8.2.2), referral stays `pending` and surfaces to the patient as "waiting for a specialist" rather than silently failing — **not yet implemented, tracked in ROADMAP.**

### 5.3 Order issuance and fulfillment
1. Specialist issues `Prescription` and/or `LabOrder` from a `Consultation`.
2. Patient views eligible facilities filtered by `FacilityCapability` matching the order.
3. Patient selects a facility → `FulfillmentRecord` created (`pending`).
4. Facility updates its own `FulfillmentRecord` status; for labs, attaches `LabResult`.
5. Order's own `status` field is updated to `fulfilled` only via this facility-confirmed path — patient/doctor cannot self-mark it.

## 6. Hard questions (architecture-level — see PRD §8 for product-level)

### 6.1 What do we think would break?
1. Naive slot booking without the DB-level conditional update in §5.1 — the most likely first bug filed against this repo. **Resolved 2026-09-14:** implemented exactly as designed in §5.1 — see `backend/src/modules/availability/repositories/index.ts` (`claimOpenSlot`) and `backend/src/modules/appointments/services/index.ts` (`bookSlot`, the transaction wrapping it). Integration-tested with real concurrency in `backend/tests/integration/booking.test.mts`.
2. `Referral.target_doctor_id` left nullable with no fallback assignment logic — referrals to "a specialty" with no specific doctor need a real routing rule (round robin? load-based?) or they'll pile up unassigned. **Not designed yet — flag as open architecture gap.**
3. Polymorphic `FulfillmentRecord.order_id` (§4.7) — polymorphic FKs are a known footgun for referential integrity in Postgres. Needs either two separate tables (`PrescriptionFulfillment`, `LabOrderFulfillment`) or a check-constraint + application-level guard. **Current schema sketch is a simplification that should be revisited before implementation**, not treated as final.
4. JWT refresh rotation without a revocation list — a stolen refresh token has no clean kill switch until this is added.

### 6.2 What edge cases are we missing (architecture-level)?
1. What happens to `AvailabilitySlot.status = 'held'` if a booking transaction fails/times out mid-flight — is there a TTL to release the hold? (Needed or slots leak into permanent limbo.)
2. Referral `expired` status exists in the enum but no expiry job is designed yet — orphaned referrals (PRD 8.1.3 sibling problem).
3. No schema support yet for a doctor working across multiple facilities/locations (PRD edge case 6) — `AvailabilitySlot` currently assumes one calendar per doctor.
4. No audit-log table — every FR around auditability (PRD §7) currently relies on `created_at/updated_at` timestamps only, which is not sufficient for "who changed what." A dedicated `AuditEvent` table is likely needed before this ships to real patients.

### 6.3 What's overengineered (architecture-level, for v1)?
1. Polymorphic fulfillment design (§4.7) may itself be premature abstraction — two small, boring, separate tables might beat one clever polymorphic one at this stage. Flagged as a design smell to revisit, not shipped as-is.
2. BullMQ/Redis job queue before there's a single job that needs it — fine to stub with a simple cron/interval check initially and introduce a real queue when reminder/expiry logic actually exists.
3. Designing for horizontal service extraction (module boundary purity, §3) before there's a single reason to split — worth doing lightly (it's cheap discipline), but not worth extra ceremony (e.g., separate repos, separate CI, internal API versioning) yet.

## 7. Non-functional / cross-cutting

- **Testing**: unit tests per module (`backend/tests/unit`), integration tests for booking/referral/order flows specifically because those are the correctness-critical paths (`backend/tests/integration`).
- **Migrations**: Prisma migrations are the only way schema changes happen — no manual DB edits, ever.
- **Environments**: local (Docker Compose), staging, production — staging/production infra choice is an open item (see ROADMAP).

## 8. Explicit non-decisions (deferred, not forgotten)

- Deployment target (Fly.io / Render / AWS / etc.) — undecided.
- Video/voice provider — undecided, PRD OQ-1 must resolve first.
- Multi-region / i18n — not designed for, not blocked either.
