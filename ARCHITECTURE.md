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
| ORM / schema | Prisma 7, with the `@prisma/adapter-pg` (node-postgres) driver adapter — **upgraded 2026-10-16 to clear a high-severity advisory; see `docs/adr/0006`** | Schema-as-code, migrations, keeps `backend/prisma/schema.prisma` as the single source of truth for data models (mirrors §4 below). Two v7 facts that constrain where code goes: (a) there is no Rust query engine any more, so the client must be constructed with a driver adapter (`src/db/prisma-client.ts`) — bare `new PrismaClient()` throws; (b) the CLI's datasource URL lives in `backend/prisma.config.ts`, not in the schema's `datasource` block. The `prisma-client-js` generator is retained deliberately, so the client still generates into `node_modules/@prisma/client` and this backend stays CommonJS (see §3 note on `@docforum/escrow-sdk` being ESM-only). Requires Node >= 20.19. |
| Auth | JWT access + refresh tokens, role claims (`patient` \| `doctor` \| `facility` \| `admin`) | Simple, stateless for API scaling; refresh rotation for security. |
| Frontend | React + TypeScript, Vite | Fast dev loop, standard choice, no framework lock-in beyond React. |
| Frontend state/data | React Query (server state) + lightweight store (Zustand) for client-only UI state | Avoids over-centralizing server data into a global store. |
| Realtime (messaging/notifications) | WebSocket gateway (or managed pub/sub, e.g. Pusher/Ably) behind an internal `notifications` interface | Swappable; not custom infra from day one. |
| Video/voice (if/when needed) | Third-party embed (Twilio/Daily/Agora) behind an interface, not built in-house | PRD §8.3.1 — explicitly flagged as overengineering risk if built custom. |
| File/result storage | Object storage (S3-compatible) for lab result attachments | Never store clinical files directly in Postgres rows. |
| Field-level encryption | AES-256-GCM envelope encryption (`backend/src/utils/field-encryption.ts`, Phase 8 issue #46) for clinical free text (`Consultation.notes`, `Referral.snapshotNotes`) | Limits blast radius of a leaked DB dump / over-broad read replica — encryption at rest doesn't protect against those. Versioned key-id prefix enables rotation without rewriting every row. **Constraint: encrypted fields cannot be searched or indexed** — they're write-once/read-decrypt blobs. |
| Background jobs | Simple queue (BullMQ on Redis) for reminders, order-expiry checks, notification delivery | Needed for FR-15/16 and the "orphaned order" hard question (PRD §8.1.3). |
| Infra | Docker Compose for local dev; containerized deploy target TBD (not decided — see Open Questions in ROADMAP) | Keep infra decisions deferred until a real deploy target is chosen; don't overbuild CI/CD for a repo with no code yet. |

## 3. Module boundaries (backend)

Each module under `backend/src/modules/<name>/` owns its own `routes/`, `controllers/`, `services/`, `repositories/`. Cross-module access happens through a module's exported service interface only — **never reach into another module's repository directly.** This is the internal seam that would let us extract a module into its own service later without a rewrite.

- `auth` — signup/login, tokens, role checks.
- `users` — shared user profile fields common to all roles, plus the admin account lifecycle (invites, soft deactivation — issue #39). `auth` calls this module's services to create an invited admin; `users` never calls back into `auth`.
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
- `payments` — `PaymentIntent`, the facility payee `WalletLink`, and the patient payer `PatientWalletLink` (§4.13). Relational metadata only; every Stellar call goes through `@docforum/escrow-sdk` via `services/escrow-sdk-loader.ts`. Assets are allowlisted per environment (issue #79), and the prepare half of ADR 0005 (issue #80) builds the unsigned patient transaction without moving funds.
- `audit` — the append-only `AuditEvent` trail (Phase 8, issue #43). Owns one write helper, `auditService.record(tx, actor, event)`, that every module calls **inside the transaction of the state change it describes** (it refuses the root client), and the admin-only `GET /admin/audit-events`. Controllers build the actor with `auditActor(req)` (`src/middleware/request-id.ts`: user id, role, `X-Request-Id`). Wired today: appointment booking (both the direct and the referral-origin path), consultation closing (Phase 2, issue #4), doctor verification, payment fund/release/refund, the patient's referral accept/decline, and the referral admin actions (Phase 3, issue #68 — `referral.reassign` / `referral.cancel`, recorded as `entityType: 'Referral'` rows; there is no second, referral-specific audit table). **Phase 4 transitions (fulfillment) must call `record()` in the same transaction when they're built** — prescriptions and lab orders already do. Also owns the PHI read-access log (Phase 8, issue #45, §4.11): `auditService.recordAccess()` (fire-and-forget off the read path, fail-open but counted), admin `GET /admin/access-logs` (+ `/user`, `/stats`) and the patient-facing `GET /patients/me/access-log`, whose response strips all viewer PII to a role.

### 3.1 Patient data export registry (Phase 8, issue #40)

Right of access (`POST /patients/me/export`) is coordinated by `patients`,
but **each module contributes its own section through its own `services/`
interface** — `patients` never reads another module's tables to build an
export. The pieces:

- `modules/patients/services/export-registry.ts` — the `PatientExportSection`
  contract (`name`, `version`, `pages(subject, pageSize)` yielding pages of
  plain JSON items), `registerExportSection`, and a `paginate` keyset helper.
- `src/export-sections.ts` — the one explicit list of registered sections,
  called from `createApp()`. It's wiring, outside `modules/`, so `patients`
  doesn't have to import every module that already imports `patients`.
- Current sections: `account` (auth: email/phone/role, never the password
  hash), `profile` (patients), `appointments` (appointments, with slot times
  from `availability` and the doctor's name from `doctors`, both via their
  services), `payments` (version 2: amount in the asset's smallest unit,
  asset code, status, on-chain tx hash / escrow id / contract id; the
  platform's signing secrets never live in a row and can't reach an export).

**Adding a module with patient data (referrals, prescriptions, lab orders,
…):** export a `PatientExportSection` from that module's `services/` and add
it to `src/export-sections.ts`. Rules for a section: an explicit field
allowlist (never spread a Prisma row — a column added later must not leak by
default); page through your own tables with `paginate` (at most `pageSize`
rows in memory); batch any cross-module lookups per page through the other
module's service; JSON-safe values only (BigInt → string). Bump `version`
when the item shape changes. A section that throws fails the whole export —
there is no "partial" bundle.

Generation runs in `src/jobs/patient-exports.ts` (plain intervals, woken
immediately by a new request). Sections run one at a time and the bundle is
flushed in bounded chunks to `PatientExportChunk` (§4.11), so memory is
bounded by one page of rows plus one chunk regardless of history length.

### 3.1 Account deletion and retention holds (Phase 8, issue #41)

`DELETE /patients/me` is orchestrated by `patients` and anonymises in one
transaction: the `User` row through `auth`'s service (`anonymizeAccount`,
which takes the caller's transaction client) and the `PatientProfile`
through `patients`' own repository. Nothing is cascaded; see
`docs/adr/0010` for the per-model retention table.

The scheduled purge (`src/jobs/account-purge.ts`) may only hard-delete a
*tombstone*: an anonymised patient that no module still holds records for.
"Holds records" is answered by each owning module through its own service,
registered in `src/retention-holds.ts` (wiring, outside `modules/`, because
`patients` can't import modules that already import it). The RESTRICT
foreign keys are the backstop. **A new module with patient-linked records
must do both:** reference `PatientProfile` with `onDelete: Restrict`, and add
a hold.

## 4. Data models

Canonical source of truth: `backend/prisma/schema.prisma`. This section is the human-readable mirror — if they drift, the schema file wins and this doc should be corrected in the same PR.

**Phase 1 models are real** (User, PatientProfile, DoctorProfile, Specialty, DoctorSpecialty, FacilityProfile, FacilityCapability, AvailabilitySlot, Appointment) — migrated via `backend/prisma/migrations/20260914110638_init/`. **Phase 3 added the real `Referral` and the `Consultation`↔appointment link** — migrated via `backend/prisma/migrations/20261016214929_referral_phase3/`; §4.3 and §4.4 describe what actually shipped, not a sketch. The audit trail (`AuditEvent`, §4.10) is the Phase 8 one (issue #43, `20261017212335_add_audit_event`) — the referral admin actions live in it rather than in a second table. Everything else below (§4.5 onward) is still the Phase 0 structural placeholder.

Three intentional deviations from the original sketches, all flagged in the schema file itself: `Appointment.intakeId` is deferred (nullable-by-omission, not yet a column) since `IntakeForm` doesn't exist until Phase 2; `PatientProfile.guardianUserId` was a plain string with no FK relation while the minor/dependent consent model (PRD §8.2.5) was open — **replaced in Phase 8 (issue #42, `docs/adr/0011`)** by the `Guardianship` relation (§4.1); and `Referral.snapshotIntakeId` likewise has no column yet (there is no `IntakeForm` to snapshot) — the intake half of the snapshot rule cannot be violated while there is no intake data at all, and the column must be added (as a copy) when issue #1 lands.

### 4.1 User / Role model
```
User
  id, email, phone, password_hash, role (enum: patient|doctor|facility|admin)
  email_verified_at (nullable — Phase 8 issue #34; null = unverified.
    Backfilled to created_at for pre-existing rows in the
    add_email_verification migration, so accounts from before this phase
    are treated as verified)
  locale (string, default `en` — Phase 9 issue #133; selected from
    Accept-Language at signup, unsupported tags fall back to `en`)
  locale (string, default `en` — Phase 9 issue #133; supported language
    selected from Accept-Language at signup, unsupported tags fall back to `en`)
  deleted_at (nullable — Phase 8 issue #41, docs/adr/0010; set once,
    irreversibly, when the account is deleted. The row is anonymised in
    place: email -> deleted+<id>@deleted.invalid, phone null, password
    unusable, email_verified_at null. Login and refresh refuse it.)
  created_at, updated_at

EmailVerificationToken (Phase 8 issue #34)
  id, user_id (FK -> User), token_hash (unique, SHA-256 — raw token never stored)
  expires_at, consumed_at (nullable), created_at
  # Append-only-ish: issuing a new token marks any outstanding one consumed
    ("latest link wins") rather than deleting it. Redemption is a conditional
    UPDATE (consumed_at IS NULL), same single-use shape as §5.1's booking
    guarantee, so two concurrent redemptions can't both win.

PatientProfile (1:1 User, or 0:1 for a dependent)
  id, user_id (nullable since issue #42 — null = a guardian-owned dependent
    with no login; still unique. FK -> User, ON DELETE RESTRICT since issue
    #41 — was CASCADE), full_name, date_of_birth
  anonymized_at (nullable — issue #41; set with full_name -> 'Deleted patient',
    date_of_birth -> null. The row stays so Appointment and
    PaymentIntent keep their FK; both of those reference it ON DELETE RESTRICT.)
  # CHECK (user_id IS NOT NULL OR date_of_birth IS NOT NULL): a dependent
    always has a DOB, because guardian access ends at the age of majority.
  # guardian_user_id (unenforced string) was dropped in issue #42; the
    migration refuses to run if any row still had a value.

Guardianship (Phase 8, issue #42 — docs/adr/0011)
  id, guardian_user_id (FK -> User, RESTRICT), dependent_profile_id (FK -> PatientProfile, RESTRICT)
  created_at, revoked_at (nullable)
  # unique (guardian_user_id, dependent_profile_id) — no duplicate pairs.
  # Created only together with a new dependent profile (POST
    /patients/me/dependents); there is no way to link an existing profile.
  # Active = revoked_at IS NULL AND the dependent is under
    AGE_OF_MAJORITY_YEARS (UTC calendar date, checked at request time).
    Never deleted — ending access sets revoked_at, or happens by age.
  # All dependent-scoped access goes through
    patients/services resolveActingProfile (booking, appointment listing).

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
  notes [ENCRYPTED — Phase 8 issue #46, see §2 field-level encryption row]
  outcome (enum: resolved|referred|follow_up_needed, nullable in the schema —
    the close routes require it, so a closed record has one; see below)
  created_at, updated_at
  referrals: Referral[]   # children — the lineage loop detection walks
```
**Implemented 2026-10-20 (Phase 2, issue #4):** `appointment_id UNIQUE` is what makes a consultation closable **once** — a second concurrent close loses at the INSERT, not at an app-level check (see docs/adr/0009). There is no amendment/edit path in v1. `notes` is encrypted on write via `encryptField()` (requires `FIELD_ENCRYPTION_KEY_V1`), so the first writer to a clinical free-text column honours the rule below rather than starting a plaintext precedent; reads decrypt in the consultations service.

The row has exactly one writer — `consultationsService.createConsultation` — reachable from three addresses so that no path can bypass the uniqueness, encryption or audit rules: `POST /consultations` (appointment in the body; Phase 3's referral slice, `outcome` optional so a record can exist before sign-off), `POST /appointments/:id/consultation` (Phase 2's close route, `outcome` + `notes` required), and the orders flow's consultation step (which adds its own verified-doctor gate and then delegates). All of them require the appointment to be `completed` and to belong to the calling doctor, and all of them write the same `consultation.closed` audit event in the same transaction.

**Encryption note:** `notes` is stored as an AES-256-GCM envelope (`v1:<iv>:<tag>:<data>`) via `backend/src/utils/field-encryption.ts`. Because it's encrypted, it **cannot be searched or indexed** — any future full-text search over consultation notes must decrypt in the application layer or use a separate searchable index, not a Postgres index on this column. Key rotation: `backend/scripts/rotate-field-keys.mjs` re-encrypts in batches.

Readable (`GET /consultations/:id`) only by the treating doctor and the
patient of the underlying appointment; anyone else gets `403`, and the
stored ciphertext never leaves the module. What is still open is issue
#4's fuller workflow — sign-off, addenda, a doctor editing notes after the
fact — which is exactly why the referral snapshot (§4.4) exists rather
than referrals reading this row live.

### 4.4 Referral
```
Referral
  id
  patient_profile_id (FK -> PatientProfile)
  source_consultation_id (FK -> Consultation, required)
  referring_doctor_id, target_doctor_id (both FK -> DoctorProfile, required)
  target_specialty_id (nullable FK -> Specialty — denormalised label, used
    by the loop guard and admin views; not issue #23's specialty management)
  snapshot_notes [ENCRYPTED — Phase 8 issue #46] (text copy of the referring consultation notes at time of referral — immutable)
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
`cancelled_reason` is admin override (#68). `target_doctor_id` being
**required** is now backed by a real routing rule rather than a scope
cut (issue #6, `docs/adr/0008-referral-routing-without-target-doctor.md`):
a specialty-only referral is resolved to the least-loaded eligible
doctor *at creation*, so the resolved id is always what this column
holds and nothing is ever created unassigned.

Status transitions that exist today:
`pending → accepted` (patient accept, conditional UPDATE — the same
concurrency shape as `claimOpenSlot`), `pending → declined` (patient),
`accepted → completed` (referral-origin appointment completed),
`accepted → pending` (appointment cancelled or first no-show — bookable
again, same snapshot, no re-intake), `accepted → expired` (second
no-show, threshold `NO_SHOW_EXPIRY_THRESHOLD = 2`), and
`pending|accepted → cancelled` (admin, audited — `AuditEvent`, §4.10).

```
pending ──accept──▶ accepted ──appointment completed──▶ completed
   │                   │
   │                   ├─appointment cancelled──▶ pending   (slot released; same snapshot)
   │                   ├─no-show #1─────────────▶ pending   (no_show_count = 1)
   │                   ├─no-show #2 (=threshold)─▶ expired   (referring_doctor_notified_at set)
   │                   └─admin cancel────────────▶ cancelled (reason; audited; live appt closed)
   ├─decline──────────▶ declined
   └─admin cancel──────▶ cancelled
```
Every arrow into `pending`/`completed`/`expired` from `accepted` is a
conditional UPDATE that only matches a referral still `accepted` *and
still pointing at the appointment that triggered it*, so a doubled hook
is a no-op (issue #67, integration-tested).

### 4.5 Prescriptions (versioned, append-only)
```
Prescription
  id, consultation_id (FK), patient_profile_id (FK), prescribing_doctor_id (FK)
  facility_profile_id (FK to pharmacy), amount_stroops (clinician-entered XLM total)
  supersedes_prescription_id (nullable, unique self-FK), created_at
  # Corrections create a child row and never update the issued row.

PrescriptionItem
  id, prescription_id (FK), drug_name, dosage, frequency, duration
```

### 4.6 Lab orders (versioned, append-only)
```
LabOrder
  id, consultation_id (FK), patient_profile_id (FK), ordering_doctor_id (FK)
  facility_profile_id (FK to lab), amount_stroops (clinician-entered XLM total)
  test_type, urgency (enum: routine|urgent), notes [ENCRYPTED]
  supersedes_lab_order_id (nullable, unique self-FK), created_at

LabResult
  id, lab_order_id (FK, unique), fulfilling_facility_id (FK), result_file_url, summary
  created_at
```
The facility and total are captured at issuance. The issuing clinician supplies
`amount_stroops` in native XLM stroops because v1 has no facility catalog or
pricing service. Corrections create a new immutable row. A `created` payment
intent moves to the correction; an already escrowed intent remains linked to
the original and is refunded through the existing admin refund action.

### 4.7 Fulfillment (facility-side)
```
FulfillmentRecord
  id, prescription_id (FK, nullable, unique), lab_order_id (FK, nullable, unique)
  facility_id (FK), status (enum: pending|in_progress|fulfilled|rejected)
  created_at, updated_at
  # Exactly one of the two order FKs is set — enforced by a PostgreSQL CHECK,
    not an application guard. One row per order, enforced by the unique on
    each FK column (Postgres keeps NULLs, so each is at most one non-null).
  # All three FKs are RESTRICT: deleting an order or a facility account cannot
    erase the fulfillment trail (docs/adr/0010's retention rule).
  # Replaces the Phase 0 polymorphic (order_type, order_id) pair.
    Decision + reasoning: docs/adr/0012 (issue #13).
```
Design note: kept separate from `Prescription`/`LabOrder` so a facility's operational status doesn't need write access to the clinical order record itself — it only writes to its own fulfillment row. Reduces blast radius of a compromised/misbehaving facility account.

One table rather than a `PrescriptionFulfillment`/`LabOrderFulfillment` pair: the §5.3 step-5 transition ("`fulfilled` only via the facility-confirmed path") then exists in exactly one implementation instead of two that can drift, and the facility's assigned-orders queue is one indexed query (`WHERE facility_id = ? AND status IN (…)`) instead of a cross-table union. The lab-specific payload was never on this row anyway — it lives in `LabResult` (§4.6).

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

### 4.10 Audit trail (Phase 8, issue #43)
```
AuditEvent
  id, actor_user_id (nullable — null = system), actor_role (nullable Role)
  entity_type ('Appointment' | 'DoctorProfile' | 'PaymentIntent' | 'Consultation' | 'Prescription' | 'LabOrder' | 'Referral'), entity_id
  action (dotted, e.g. 'appointment.booked'), from_state, to_state (nullable)
  request_id (X-Request-Id of the causing request), metadata (jsonb, nullable)
  created_at
  # APPEND-ONLY: no update/delete path in code, and BEFORE UPDATE/DELETE
    (row) + BEFORE TRUNCATE (statement) triggers reject mutation in the
    database. A future retention policy must drop/recreate them in its own
    reviewed migration.
  # No foreign keys on purpose: an ON DELETE action would have to rewrite
    audit rows (forbidden), and RESTRICT would let the trail block account
    lifecycle (e.g. issue #41's purge). Ids are recorded as facts.
  # Written only by audit.record() inside the transaction of the change it
    describes — the event exists iff the change committed.
  # metadata: <= 16 flat scalar keys, strings <= 200 chars; keys that look
    like personal/secret data (name, email, phone, dob, notes, intake,
    password, secret, token, key, body, payload, …) are refused. Never PHI.
  # created_at is stamped by Prisma on the app server per row (ms
    precision); same-millisecond rows are ordered by id.
  # indexes: (entity_type, entity_id, created_at), (actor_user_id,
    created_at), (created_at, id) — the last backs the admin cursor.
```
There is **one** audit trail in this schema. Phase 3's referral admin
actions (#68) do not get their own table — they are `entity_type =
'Referral'` rows in this one, written through the audit module's
`record()` in the same transaction as the referral change, so the trigger
that makes the trail append-only covers them too.

Transitions recorded (action: from → to):
- `appointment.booked`: `null → scheduled` (metadata: slot id, doctor profile id, origin). Written by the appointments module for **both** booking paths — a direct booking and a referral-origin booking (the accept path), which is what the `origin` metadata distinguishes; there is no way to create an appointment that leaves no trail.
- `consultation.closed`: `null → outcome` (metadata: appointment id; never the notes — that's PHI). Written by the consultations module for every consultation write, whichever route addressed it (`POST /consultations`, `POST /appointments/:id/consultation`, or the orders flow).
- `doctor.verification_status_changed`: previous → new verification status (read under `FOR UPDATE`; a no-op set records nothing)
- `payment_intent.funded` `created → escrowed`, `payment_intent.released` `escrowed → released`, `payment_intent.refunded` `escrowed → refunded` (metadata: order type, amount, asset code, escrow id, tx hash, contract id — public on-chain references only). The status write is now conditional on the observed state, so a racing second action gets `409` and records nothing.
- `payment_intent.prepared` `created → awaiting_signature`, `payment_intent.prepare_expired` `awaiting_signature → created` (issue #80). Actor is the patient for prepare and the system for expiry; metadata adds the prepared transaction hash.
- `referral.accepted`: `pending → accepted` (metadata: the appointment id the accept booked). Written by the referrals module in the same transaction as the accept, so the patient's decision and the appointment it produced are both recorded or neither is.
- `referral.declined`: `pending → declined`.
- `referral.reassign`: `null → null` — the referral is retargeted, not
  state-moved, so the transition is carried in the metadata (from/to
  doctor profile ids + the admin's reason, ≤ 200 chars) rather than in
  from_state/to_state.
- `referral.cancel`: previous status → `cancelled` (metadata: the admin's
  reason). The live appointment of an accepted referral is closed in the
  same transaction (through the appointments service).

Not yet recorded (open gap, not silently dropped): a referral's
*creation* (`null → pending`), and the two transitions the appointment
cascade drives — `accepted → completed` and `accepted → expired` (the
no-show path) — because the cascade fires from inside the appointment's
status transaction, which has no actor of its own to attribute. The
referral-creation and cascade rows are owed when Phase 4/6 wire the
remaining state changes; until then the trail shows the referral's
history only from acceptance onwards.

### 4.11 Patient data export (Phase 8, issue #40)
```
PatientExport
  id, patient_profile_id (FK -> PatientProfile, cascade — a derived copy)
  status (enum: pending|processing|ready|failed|expired)
  schema_version (nullable int — bundle format written), attempt (int, fencing token)
  started_at, generated_at, expires_at (nullable)
  size_bytes, chunk_count (nullable — set on ready)
  failure_code, failed_section (nullable — machine-readable only, never an error message)
  created_at, updated_at
  # Every transition is a conditional UPDATE on the expected status (and
    attempt), so two workers can't both generate one job and a stale claim
    can't publish over a newer one. One in-flight job per patient (request
    locks the PatientProfile row FOR UPDATE).
  # The row is kept after expiry (no patient data in it) so status reads
    answer "expired" rather than 404.

PatientExportChunk
  export_id (FK -> PatientExport, cascade), attempt, seq — composite PK
  data (text — one slice of the JSON bundle, ~PATIENT_EXPORT_CHUNK_BYTES)
  # Only chunks of the export's current attempt are ever served; the cleanup
    job deletes other attempts' and expired/failed exports' chunks.
```
Bundle format (schemaVersion 1): `{ format: "docforum.patient-export",
schemaVersion, exportId, generatedAt, sections: { <name>: { version, items } } }`
— see §3.1 for where sections come from.

### 4.12 Escrow chain event observations (issue #86)

EscrowEventCursor has one row per deployed escrow contract and persists the Soroban RPC pagination cursor and retention error. EscrowChainEvent is uniquely keyed by (contractId, eventId) and records the contract event, ledger, transaction hash, escrow id, match state, and alert timestamp. These are observations, not a source of payment state: matching checks the locally owned PaymentIntent; the poller never mutates a payment transition.
### 4.11 PHI read-access log (Phase 8, issue #45)
```
AccessLog
  id, accessed_by (nullable FK → User, SET NULL on delete — the row keeps
    its timestamp and entity while the PII pointer is removed)
  patient_profile_id (nullable FK → PatientProfile, CASCADE — the record
    owner, whose data was viewed; used by the patient-facing query)
  entity_type ('IntakeForm' | 'Consultation' | 'Prescription' |
    'PrescriptionItem' | 'LabOrder' | 'LabResult' | 'Referral' |
    'PaymentIntent' | 'PatientProfile' | 'Appointment'), entity_id
  route (nullable — the HTTP route that returned the payload),
    detail (nullable — context string, never PHI)
  accessed_at (default now)
  # indexes: (accessed_at), (accessed_by), (patient_profile_id,
    accessed_at), (entity_type, entity_id).
```
Answers "who looked at this" — distinct from `AuditEvent`'s "who changed
this" (§4.10). Reads are far higher volume than state changes, so:
- writes go through `auditService.recordAccess()`, which is
  **fire-and-forget** (never awaited on the read path — a unit test pins
  sub-50ms return with a hanging insert) and **fail-open** (a logging
  failure never fails the read, but is counted and surfaced via
  `GET /admin/access-logs/stats` for alerting);
- rows are **retention-managed**, not append-only: `pruneOldAccessLogs()`
  (wired into the prune interval in `src/server.ts`) deletes rows older
  than `ACCESS_LOG_RETENTION_DAYS` (default 365). That delete is the only
  one in the audit repositories and is bounded to the retention cutoff.
Patient-facing query (`GET /patients/me/access-log`) is scoped server-side
to the caller's own profile (resolved from the authenticated user, never
from the request) and strips all viewer PII to a role — a deleted viewer
surfaces as `deleted_user`.

### 4.13 Payments (Phase 5.5 — ADR 0004 custodial v1, ADR 0005 non-custodial)
```
PaymentIntent
  id, prescription_id / lab_order_id (exactly one typed FK — issue #85)
  status (enum: created|awaiting_signature|submitting|escrowed|released|refunded|failed)
  patient_profile_id (FK, RESTRICT), facility_id (FK)
  amount (bigint — smallest unit of asset_code; never scaled in this repo)
  asset_code, token_contract_id (SAC address; token_contract_id is nullable
    only for pre-#79 rows, which resolve ESCROW_TOKEN_ID as native XLM)
  escrow_id, stellar_tx_hash, soroban_contract_id (nullable — set on fund)
  prepared_tx_hash, prepared_xdr, prepared_expiry_ledger, prepared_expires_at,
    refund_after (nullable — live only in awaiting_signature; cleared on expiry)
  created_at, updated_at
  # Every status write is a conditional UPDATE on the observed state, in the
    same transaction as its AuditEvent (§4.10). Prepare is
    created -> awaiting_signature; expiry is awaiting_signature -> created.
    `submitting` is reserved for ADR 0005's submit half (not built). Orders
    are priced in XLM today, so issuance writes asset_code='XLM'.

PatientWalletLink
  patient_profile_id (unique FK -> PatientProfile, cascade)
  stellar_public_key, verified_at
  # The PAYER wallet (ADR 0005). Rows are written by the SEP-10 flow, which
    is not built yet; prepare requires one and returns 409
    WALLET_NOT_LINKED otherwise.

WalletLink
  facility_id (unique FK -> FacilityProfile, cascade)
  stellar_public_key
  # The PAYEE/payout wallet, facility-managed (ADR 0004). Unchanged by #79.
```
Assets are an environment allowlist (`PAYMENT_ASSETS`; testnet defaults XLM +
USDC SACs) rather than a fixed enum: an intent in any other asset is
rejected at creation. Before funding (and preparing) an issued asset, the
payee's Horizon account is checked for an authorised trustline
(`PAYEE_TRUSTLINE_MISSING`); native XLM needs none. Only assets without
clawback/transfer fees/rebasing belong on the list — escrow threat model
T5, enforced as a curated config policy.

## 5. Key flows (sequence-level, not code)

### 5.1 Booking (concurrency-safe)
1. Client requests open slots for a doctor.
2. Client attempts to book a specific `AvailabilitySlot` → backend runs this inside a DB transaction with a row-level lock / conditional update (`UPDATE ... WHERE status = 'open'`), so a second concurrent booking attempt on the same slot fails atomically instead of racing.
3. On success, `Appointment` is created referencing the now-`booked` slot.

### 5.2 Referral (Phase 3 — issues #5/#7/#65–#68)
1. Doctor records a `Consultation` against their own **completed** appointment, then creates one or more `Referral`s from it (`POST /referrals`, or the atomic batch `POST /referrals/from-consultation/:id` / `POST /consultations/:id/referrals`) — each target gets its own `snapshot_notes` copy. Multi-referral is a deliberate decision recorded in `docs/adr/0006-multiple-referrals-per-consultation.md`: independent lifecycles born in one transaction, grouped only for presentation. A target is a **named verified doctor** *or* **a specialty**, and a specialty-only target is routed to a concrete doctor at creation (`docs/adr/0008`): least-loaded among eligible doctors — verified, holds the specialty, not the referring doctor, active account — where load counts that doctor's `pending` + `accepted` referrals; ties break on doctor id. Zero eligible doctors is a `422 REFERRAL_NO_ELIGIBLE_TARGET` and writes nothing, so an unassigned referral cannot exist.
2. Creation is one transaction: gates (own consultation, completed appointment, no self-referral, target verified [+ in specialty], no duplicate target in this consultation), lineage lookup (`parent_referral_id` via consultation → appointment → referral), then the loop walk (PRD §8.1.2 / issue #65) — a repeat doctor/specialty in the chain **flags** the referral for the admin queue rather than blocking it; exceeding the hop limit (`REFERRAL_MAX_HOPS`, default 4) hard-rejects with 422.
3. Patient must **accept** (PRD OQ-3): `POST /referrals/:id/accept` does a conditional `pending → accepted` UPDATE (exactly one concurrent accept wins) and books a real `Appointment` against the target doctor through the appointments service — same `claimOpenSlot` path as a direct booking, `origin: 'referral'`, patient picks the slot, and no re-intake happens because the snapshot travels on the referral. Decline is `pending → declined`, terminal.
4. The appointment's own status transition then cascades back into the referral inside the same transaction (issue #67): `completed →` referral `completed`; `cancelled →` referral back to `pending` (slot released, re-bookable, same snapshot); `no_show →` count++ and back to `pending`, except at `NO_SHOW_EXPIRY_THRESHOLD` (2) where it becomes `expired` with `referring_doctor_notified_at` set. Every one of these writes is conditional on the referral still being `accepted` and still pointing at that appointment, so a hook firing twice is a no-op.
5. Admin override (issue #68): `GET /referrals/admin/queue` (stuck/aged/loop-flagged, with a derived reason), reassign a **pending** referral to another verified doctor (target column only — snapshot untouched), cancel a `pending`/`accepted` referral with a reason (closing its live appointment through the appointments service). Reassign and cancel each write an `AuditEvent` (§4.10), readable at `GET /referrals/admin/:id/audit-events`.
6. The "zero verified doctors in that specialty" dead end (PRD edge case 8.2.2) is surfaced **at creation**: routing finds no eligible doctor, the call fails `422 REFERRAL_NO_ELIGIBLE_TARGET`, and the referring doctor is told before the patient is handed anything. What is still not built is the patient-facing "waiting for a specialist" state — that needs a target-less referral to exist, which ADR 0008 deliberately rejects. A routed referral whose doctor never publishes a slot still sits `pending` until issue #8's time-based expiry or an admin (#68) picks it up.

### 5.3 Order issuance and fulfillment
1. Specialist issues `Prescription` and/or `LabOrder` from a `Consultation`.
2. Patient views eligible facilities filtered by `FacilityCapability` matching the order.
3. Patient selects a facility → `FulfillmentRecord` created (`pending`).
4. Facility updates its own `FulfillmentRecord` status; for labs, attaches `LabResult`.
5. Order's own `status` field is updated to `fulfilled` only via this facility-confirmed path — patient/doctor cannot self-mark it.

## 6. Hard questions (architecture-level — see PRD §8 for product-level)

### 6.1 What do we think would break?
1. Naive slot booking without the DB-level conditional update in §5.1 — the most likely first bug filed against this repo. **Resolved 2026-09-14:** implemented exactly as designed in §5.1 — see `backend/src/modules/availability/repositories/index.ts` (`claimOpenSlot`) and `backend/src/modules/appointments/services/index.ts` (`bookSlot`, the transaction wrapping it). Integration-tested with real concurrency in `backend/tests/integration/booking.test.mts`.
2. `Referral.target_doctor_id` left nullable with no fallback assignment logic — referrals to "a specialty" with no specific doctor need a real routing rule (round robin? load-based?) or they'll pile up unassigned. **Resolved 2026-10-21 (Phase 3, issue #6 — `docs/adr/0008-referral-routing-without-target-doctor.md`):** the column stays **required** and the fallback logic now exists at creation — a specialty-only target is routed to the **least-loaded eligible doctor** (verified, holds the specialty, not the referring doctor, active account; fewest `pending`+`accepted` referrals, ties by doctor id) inside the creation transaction. Zero eligible doctors fails the call with `422 REFERRAL_NO_ELIGIBLE_TARGET` instead of writing an unowned row, so the pile-up this item predicts remains impossible. Still deliberately absent: a patient-facing "waiting for a specialist" state (it requires a nullable target), availability-aware routing (needs doctor-side availability/discovery), and a per-doctor "accepting referrals" switch — all deferred in the ADR with revisit triggers.
3. Polymorphic `FulfillmentRecord.order_id` (§4.7) — polymorphic FKs are a known footgun for referential integrity in Postgres. Needs either two separate tables (`PrescriptionFulfillment`, `LabOrderFulfillment`) or a check-constraint + application-level guard. **Current schema sketch is a simplification that should be revisited before implementation**, not treated as final. **Resolved 2026-10-22 (Phase 5, issue #13 — `docs/adr/0012-fulfillment-record-typed-order-fks.md`):** neither option exactly as posed — `FulfillmentRecord` stays **one table**, but the `(order_type, order_id)` pair is gone. It is replaced by two real foreign keys (`prescription_id`, `lab_order_id`, each `UNIQUE`) with a PostgreSQL `CHECK` requiring exactly one, plus the `facility_id` FK the sketch left as a TODO. Referential integrity is now the database's job, and the CHECK only chooses between two already-validated columns — which is what an `order_type`+`order_id` guard could never do, since Postgres cannot make a bare `TEXT` conditionally reference one of two tables. Keeping one table (rather than splitting) is what keeps §5.3 step 5 a single transition implementation and the facility's assigned-orders queue a single indexed query; the discriminator mechanism is the one `PaymentIntent` already uses (issue #85). Deferred by that decision rather than invented around: re-routing an order to a different facility after a `rejected` fulfillment would need a partial unique index, so in v1 a `rejected` row is terminal for that order — a corrected order is a new `supersedes_*_id` row and gets its own fulfillment.
4. JWT refresh rotation without a revocation list — a stolen refresh token has no clean kill switch until this is added.
5. **Discovered 2026-10-15 while building email verification (Phase 8, issue #34):** the email/SMS provider is still undecided (Phase 6, issue #17), so verification links can't actually be delivered in a hosted environment yet — `backend/src/modules/auth/services/email-dispatcher.ts` is a no-op seam until a provider is integrated. Until then `backend/scripts/mark-email-verified.mjs` is the documented out-of-band path for an operator with DB access. Not a reason to skip the guard: the guard is what makes the flow safe once delivery exists, and shipping it locked-off would just mean shipping it untested.

6. **Discovered 2026-10-17 (issue #41):** after `DELETE /patients/me`, the caller's access token (stateless JWT, 15-minute TTL) still passes `authenticate` until it expires — there's no revocation list (item 4 above, issue #18). It can't reach anything: every patient route resolves the caller through `getMyPatientProfile`, which refuses an anonymised profile; booking/payments refuse it via `requireVerifiedEmail` (verification is cleared); refresh refuses `deleted_at`. Closing the window itself is #18's job. Also: Postgres reports `ON DELETE RESTRICT` as SQLSTATE 23001, which Prisma surfaces as an *unknown* request error, not `P2003` — `patients/services` `isForeignKeyRefusal` handles both; `middleware/error-handler.ts` currently maps neither to a 4xx.

### 6.2 What edge cases are we missing (architecture-level)?
1. What happens to `AvailabilitySlot.status = 'held'` if a booking transaction fails/times out mid-flight — is there a TTL to release the hold? (Needed or slots leak into permanent limbo.)
2. Referral `expired` status exists in the enum but no expiry job is designed yet — orphaned referrals (PRD 8.1.3 sibling problem). **Partly addressed 2026-10-17 (Phase 3, issue #67):** repeated no-shows now drive a referral to `expired` (`NO_SHOW_EXPIRY_THRESHOLD = 2`, with `referring_doctor_notified_at` set as the seam Phase 6's notification layer will read). What is still missing is **time-based** expiry — a pending referral nobody ever accepts, or one whose target doctor never offers a slot, has no TTL and no worker. Tracked as issue #8; per §6.3.2 it should ship as a simple interval/cron, not a queue.
3. No schema support yet for a doctor working across multiple facilities/locations (PRD edge case 6) — `AvailabilitySlot` currently assumes one calendar per doctor.
4. ~~No audit-log table~~ **Foundation resolved 2026-10-17 (issue #43):** `AuditEvent` (§4.10) + `audit.record()` in the same transaction as the change, append-only at the DB level, wired into booking (both booking paths), doctor verification, payment fund/release/refund, the patient's referral accept/decline and the referral admin actions (`referral.reassign`, `referral.cancel` — Phase 3, issue #68, written as `entity_type = 'Referral'` rows in the same table). **Still open:** the referral's creation and the cascade-driven `completed`/`expired` transitions (no actor to attribute them to yet), the remaining Phase 4 transitions (prescriptions, lab orders, fulfillment), the admin login-throttle clear (`/auth/login-attempts/clear`) still only logs to the console; the app connects as the database owner, which could disable the triggers — enforcing append-only against the owner needs a separate least-privilege DB role (deployment work, issue #22). PRD §7 auditability is therefore "a real mechanism exists" rather than "auditability is done"; remaining coverage stays an open gap.
5. CSRF on the cookie-authenticated routes — the refresh cookie has to be `SameSite=None; Secure` (the Pages frontend is a different site — see `docs/adr/0003`), which means any site the patient visits can make their browser send it to `/auth/refresh` and `/auth/logout`. **Resolved 2026-10-15 (issue #37):** a per-session CSRF token is bound into the refresh token and required in the `X-CSRF-Token` header, the `Origin` header is validated against an explicit allowlist, and CORS is now a per-environment allowlist (`CORS_ORIGINS`) instead of one configured string. The double-submit cookie pattern — the usual answer — is *not* usable here: a cookie set by this API is a third-party cookie to `docforum.github.io`, so the frontend's JavaScript can never read it; the token travels in the login/refresh response body instead. A request with no `Origin` (curl, server-to-server) is allowed through the Origin check but still needs the token. See `backend/src/middleware/csrf.ts`, and `docs/api/README.md` for what the client must send. Consequence: refresh cookies issued before this change carry no `csrf` claim and are rejected, i.e. existing sessions need one re-login.

### 6.3 What's overengineered (architecture-level, for v1)?
1. Polymorphic fulfillment design (§4.7) may itself be premature abstraction — two small, boring, separate tables might beat one clever polymorphic one at this stage. Flagged as a design smell to revisit, not shipped as-is. **Resolved 2026-10-22 (issue #13, `docs/adr/0012-fulfillment-record-typed-order-fks.md`):** the polymorphism was the premature part and it is gone. Splitting into two tables was weighed and rejected — it would give the §5.3 step-5 transition two implementations and the facility queue a cross-table union, i.e. *more* ceremony than the single typed-FK table, not less.
2. BullMQ/Redis job queue before there's a single job that needs it — fine to stub with a simple cron/interval check initially and introduce a real queue when reminder/expiry logic actually exists.
3. Designing for horizontal service extraction (module boundary purity, §3) before there's a single reason to split — worth doing lightly (it's cheap discipline), but not worth extra ceremony (e.g., separate repos, separate CI, internal API versioning) yet.
4. **Added 2026-10-17 (issue #40):** export bundles are stored as text chunks in Postgres (`PatientExportChunk`, §4.11), not in object storage as §2's file-storage row prescribes — no object-storage provider is integrated yet, and a filesystem store would break on Render's ephemeral disk and on any second instance. The chunks are read/written only by `patients/repositories`, are short-lived (`PATIENT_EXPORT_TTL_HOURS`, default 24) and are deleted by the cleanup job, so moving to S3 later swaps one storage seam rather than the design. Revisit when lab-result storage (Phase 5, issue #16) picks a provider.

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
