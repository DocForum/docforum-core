# ROADMAP.md — DocForum

Status: Phase 0, Phase 1, and Phase 5.5 (Payments, custodial v1 — see
`docs/adr/0004-custodial-payments-v1.md`) built and tested. Phase 3
(Referrals) is **in progress**: #5, #7 and #65–#68 implemented and
tested on branch `feat/referral-phase3-cascade-multi-loop-admin`, #6 and
#8 open. Phase 2 is partially unblocked by that work (#3/#4 minimal
slices). Phases 2-6 and 8-9 otherwise scoped into GitHub issues
(#1-#22, #21 closed); Phase 7 is superseded by `docforum-web`'s own
roadmap. Phase 9's end-to-end care-thread integration test is in progress
(scaffold + phase-gated steps). See each phase section below for status
and issue links.

> **Org note:** this repo (`docforum-core`) is the hub of a 3-repo `DocForum` org. Frontend work is tracked in `docforum-web`'s own roadmap. Stellar contract/SDK work is tracked in `docforum-escrow`'s own roadmap. This file tracks only what runs inside `docforum-core` — including the `payments` module, which *consumes* `docforum-escrow`'s published package but doesn't implement contract logic itself.

> **This file must be updated by every contribution that starts, completes, or blocks any item below.** No exceptions — see `AGENTS.md` / `CLAUDE.md`. If your PR doesn't touch this file and it touched roadmap-tracked work, the PR is incomplete.

## How to read this file
- Phases are meant to be worked **mostly in order** (each depends on Phase 0/1 being real), but **within a phase, items are designed to be independent** — see the per-phase GitHub issue breakdown (tracked separately once issues are created; this roadmap defines the work, issues execute it).
- Status values: `Not started`, `In progress`, `Blocked (reason)`, `Done`.
- Every phase must end with its docs (PRD/ARCHITECTURE/ARCHITECTURE_ESSENTIALS) reconciled — a phase isn't "Done" if the docs still describe the pre-phase state.

---

## Phase 0 — Foundations & scaffolding
**Status: Done**
- [x] PRD.md
- [x] ARCHITECTURE.md
- [x] ARCHITECTURE_ESSENTIALS.md
- [x] AGENTS.md / CLAUDE.md
- [x] Repo folder structure (backend modules, frontend, docs, infra, .github)
- [x] Prisma schema skeleton (models named, fields mostly TODO)
- [x] This ROADMAP.md

## Phase 1 — Identity, DB, and safe booking foundation
**Status: Built and tested. One item (Docker Compose) written but not verified running — see note.**
**Why first:** everything else depends on real users existing and on the booking concurrency guarantee (ARCHITECTURE.md §5.1) being real, not aspirational.

- [x] Flesh out `User`, `PatientProfile`, `DoctorProfile`, `FacilityProfile`, `Specialty`, `DoctorSpecialty`, `FacilityCapability` in `schema.prisma` with real fields/relations. Migrated: `backend/prisma/migrations/20260914110638_init/`.
- [x] Local dev DB via Docker Compose (`infra/docker`) — verified and exercised ([issue #27](https://github.com/DocForum/docforum-core/issues/27), Trivial, 100 pts). Containers defined in `infra/docker/docker-compose.yml` (Postgres 16 + containerized backend), migrations run cleanly, endpoints verified (`/health`, `/specialties`, auth signup/login). Documented in `infra/docker/README.md` and main `README.md`.
- [x] Auth module: signup/login, JWT access+refresh, role middleware. `POST /auth/signup` rejects `role: 'facility'`/`'admin'` server-side (PRD OQ-2), not just in docforum-web's UI. Refresh token travels as an httpOnly cookie — see `docs/api/README.md` for the local-dev-only cookie caveat (cross-origin `sameSite`/`secure` not verified end-to-end).
- [x] Doctor verification status workflow (admin-gated, manual in v1 per PRD §6.1 FR-3). `PATCH /doctors/:id/verification`, admin-only.
- [x] `AvailabilitySlot` model finalized **with the DB-level constraint/transaction strategy** that prevents double-booking (ARCHITECTURE.md §5.1 / §6.1.1 — this is the single highest-priority correctness item in the whole roadmap). **Resolved, not just implemented** — see the integration test below.
- [x] Basic slot generation for a doctor (fixed-length, no recurrence engine — ARCHITECTURE.md §6.3.6). `POST /availability/doctors/:id/slots/generate`, idempotent re-runs.
- [x] Integration test: two concurrent booking attempts on the same slot — exactly one must succeed. `backend/tests/integration/booking.test.mts` — 8 genuinely concurrent requests via `Promise.all`, self-contained (spins up its own throwaway Postgres, no pre-existing DB needed), passing. Also manually verified end-to-end via a full curl walkthrough (signup → generate slots → book → second booking attempt correctly gets `409`).
- [x] Doc reconciliation: PRD §8.1.1 and ARCHITECTURE §6.1.1 marked resolved in place.

## Phase 2 — Intake, appointments, consultations
**Status: In progress — #1, #3, #4 and #23 done (check-in + live queue position landed as an issue #3 extension); booking-before-intake (#2) remains. Scoped into issues #1–#4 and #23.**
- [x] `IntakeForm` model + structured symptom entry (not free-text-only, per PRD FR-5). Tracked as [issue #1](https://github.com/DocForum/docforum-core/issues/1) (Medium, 150 pts) — patient-owned symptom records with self-only create/history endpoints and patient-export registration.
- [ ] Booking flow requires intake before confirmation. Tracked as [issue #2](https://github.com/DocForum/docforum-core/issues/2) (Medium, 150 pts) — depends on #1.
- [x] `Appointment` lifecycle (`scheduled → completed/cancelled/no_show`) + doctor's today view. Tracked as [issue #3](https://github.com/DocForum/docforum-core/issues/3) (Medium, 150 pts) — lifecycle transitions were already implemented; this change adds `GET /appointments/doctor/today`, limited to the caller's doctor profile and scheduled appointments for the server-local day. Admin-on-behalf transitions remain out of scope.
- [x] `Consultation` record + outcome (`resolved | referred | follow_up_needed`). Tracked as [issue #4](https://github.com/DocForum/docforum-core/issues/4) (High, 200 pts) — **Done.** One writer (`consultationsService.createConsultation`) reached from three addresses — `POST /consultations` (Phase 3's slice), `POST /appointments/:id/consultation` (this issue's close route) and the orders flow's consultation step — all doctor-only, own- and `completed`-appointment-only, all requiring a verified email. `Consultation.appointmentId` `UNIQUE` is what makes "closed once" a DB constraint rather than app logic (`P2002` → `409`); notes are stored encrypted (issue #46) and decrypted on read; every write carries one `consultation.closed` audit event in the same transaction. The column/unique index/FK already exist from `20261020000000_order_payment_intents`, so this PR adds no migration. No amendment/edit path in v1 — that stays an open question for when amendment work lands (docs/adr/0009). Integration test: `backend/tests/integration/consultation.test.mts` (scheduled → `409`, closed once, second close `409` via either address, one row, decrypted read for doctor + patient, other-doctor read `403` / close `404`, patient close `403`). **Verification note:** the checked-in integration suites cannot run in this sandbox (embedded Postgres `initdb` is refused); they run in CI on the merge.
- [x] Doctor discovery: `GET /specialties`, `PUT /doctors/me/specialties`, and public verified-only `GET /doctors` with specialty, typo-tolerant name/specialty search, and keyset pagination. Tracked as [issue #23](https://github.com/DocForum/docforum-core/issues/23) and extended by [issue #128](https://github.com/DocForum/docforum-core/issues/128). `docforum-web` issue #1 can fetch slot details separately by doctor id.
- [ ] Patient-facing view: my intake history. Not yet split into its own issue — small enough to fold into whichever of the above lands last, or split out later if it grows.
- [x] In-person check-in + live queue position for the day's appointments. `POST /appointments/:id/check-in` (patient, own appointment, only within a window around the start — records `checkedInAt`), doctor start/complete transitions extended with `startedAt`/`completedAt` timestamps, and `GET /appointments/:id/queue` returning the patient's own position and an explainable estimated wait from the doctor's running-average delay (simple running average, not ML). Queue changes are exposed for polling; the notification stream (Phase 6) is not built yet, so no push path exists. Patients see only their own position — never other patients' details. Schema additions (`Appointment.checkedInAt`, `startedAt`, `completedAt`) recorded in ARCHITECTURE.md §4.2; endpoint docs in `docs/api/README.md`. Tracked as [issue #3](https://github.com/DocForum/docforum-core/issues/3) extension (High, 200 pts).
- [x] Integration tests for the doctor's day view and the appointment status machine (issue #358): `GET /appointments/doctor/today` returns only the caller's own scheduled appointments that hold a slot, ordered by slot start, with the day taken from `DoctorProfile.timeZone` rather than the server or UTC; every legal transition out of `scheduled`, each illegal one (terminal status, too early, an unassignable status), an unknown id at 404 and another doctor at 403, and concurrent double transitions where exactly one request wins and the slot is freed once. `vi.useFakeTimers({ toFake: ['Date'] })` pins the clock so the suite does not depend on when CI runs. `backend/tests/integration/doctor-day-view-and-status-transitions.test.mts`.
- [x] Symptom-to-specialty mapping for "search by symptom" ([issue #60](https://github.com/DocForum/docforum-core/issues/60)): a curated `Symptom` → `SymptomSpecialty` vocabulary (weights 1–5, admin-managed, starter set in the migration), `GET /symptoms?q=` autocomplete, `GET /doctors?symptom=` ranked by mapping strength, and admin CRUD at `/admin/symptoms`. Explicitly not ML (PRD §8.3.3) and never presented as medical advice; an unknown/retired/unmapped symptom is an empty result plus a `hint`, not an error. Models documented in ARCHITECTURE.md §4.15.
- [x] Async consultation message thread between the patient and treating
  doctor ([issue #61](https://github.com/DocForum/docforum-core/issues/61)).
  Append-only `ConsultationMessage` with an encrypted body, cursor pagination,
  participant-only access, a configurable closing window and a notification
  outbox hook.
- [x] Message attachments with access-checked, short-lived download URLs
  ([issue #62](https://github.com/DocForum/docforum-core/issues/62)). JPEG/PNG/PDF
  only with byte sniffing, EXIF/GPS stripping, per-user quota, signed URLs.
- [x] Follow-up outcome creates a pre-filled follow-up booking request
  ([issue #63](https://github.com/DocForum/docforum-core/issues/63)).
  `FollowUpRequest` + immutable note snapshot, booking through the standard
  conditional slot claim with origin `follow_up`, expiry sweep.
- [x] Consultation note sign-off with append-only addenda
  ([issue #64](https://github.com/DocForum/docforum-core/issues/64)).
  `signedAt`, DB-level immutability after sign-off, `ConsultationAddendum`,
  auto sign-off sweep.

## Phase 3 — Referrals
**Status: In progress — issues #5, #7 and #65–#68 are implemented and tested (unit + 5 self-contained integration suites); #6 (routing ADR) and #8 (time-based expiry job) remain open. Original scope was #5–#8; #65–#68 were opened later against the same phase for loop detection, multi-referral, cascade and admin overrides.**
- [x] `Referral` model with **immutable snapshot** of intake + notes (ARCHITECTURE.md §4.4 design note — do not implement as a live pointer), plus the "zero verified doctors in target specialty" edge case (PRD §8.2.2). Tracked as [issue #5](https://github.com/DocForum/docforum-core/issues/5) (Medium, 150 pts) — **fully closed**: deviation (a) resolved — `Referral.snapshotIntake` (`String?`, AES-256-GCM encrypted JSON) added in migration `20261126155359_referral_snapshot_intake`; captured from the patient's most-recent `IntakeForm` inside the creation transaction, never reachable by any post-creation write; null when no intake form exists at referral time (issue #2 not yet enforced). Deviation (b) remains by design per ADR 0008: zero eligible doctors fails creation with `422 REFERRAL_NO_ELIGIBLE_TARGET`, which is the distinct documented state the DoD asked for; a nullable-target "waiting for specialist" row was explicitly rejected by the ADR and is still flagged as a known gap. Creation is an explicit `POST /referrals` from a consultation rather than an implicit trigger on outcome `referred`; the outcome still records intent and the API enforces a completed appointment.
- [x] Referral creation from a `Consultation` with outcome `referred` — folded into issue #5 above.
- [x] Routing rule for referrals with no specific `target_doctor_id` (ARCHITECTURE.md §6.1.2 — resolved by ADR 0008, below). Tracked as [issue #6](https://github.com/DocForum/docforum-core/issues/6) (High, 200 pts) — an ADR. **Done, and the gap is closed:** [`docs/adr/0008-referral-routing-without-target-doctor.md`](docs/adr/0008-referral-routing-without-target-doctor.md) decides that a specialty-only referral is routed **at creation** to the least-loaded eligible doctor (verified, holds the specialty, not the referring doctor, active account; fewest `pending`+`accepted` referrals, ties by doctor id), keeping `target_doctor_id` NOT NULL so an unassigned referral still cannot exist. Zero eligible doctors fails the creation with `422 REFERRAL_NO_ELIGIBLE_TARGET` and writes no row. Implementation: `referrals/routing.ts` + the eligible-candidate lookup in `doctors/services`, wired into creation and the atomic batch (a batch never routes onto a doctor it names explicitly). Still not built, deliberately: PRD §8.2.2's patient-facing "waiting for a specialist" state (it needs a nullable target, which the ADR rejects) — flagged, not silently substituted.
- [x] Patient accept/decline flow (PRD OQ-3 resolved: patient must confirm). Tracked as [issue #7](https://github.com/DocForum/docforum-core/issues/7) (Medium, 150 pts) — depends on #5. **Done:** `POST /referrals/:id/accept` (conditional `pending → accepted`, one winner under concurrency) and `POST /referrals/:id/decline` (pending-only, terminal).
- [x] Accepted referral auto-generates a pre-populated `Appointment` against the target doctor/specialty — patient does not re-enter intake (PRD FR-8, the core value prop) — folded into issue #7 above. **Done:** accept books through `appointments`' `bookForReferral` → the same `claimOpenSlot` conditional UPDATE as a direct booking (`origin: 'referral'`), with the slot belonging to the target doctor enforced; no shortcut writes an `Appointment` row.
- [x] Referral expiry job (addresses PRD §8.1.3 "orphaned" pattern for referrals specifically). Tracked as [issue #8](https://github.com/DocForum/docforum-core/issues/8) (Medium, 150 pts) — depends on #5. **Done:** an interval sweep (`src/jobs/referral-expiry.ts`, no queue) expires `pending` referrals untouched for `REFERRAL_PENDING_TTL_DAYS` (default 14) via one conditional UPDATE; `expired` + `expiredReason = 'ttl'` is distinct from `declined`/`cancelled`, and the no-show cascade now records `no_show`. `accepted` referrals are never swept. Flagging the patient waits on Phase 6 notifications (the referring doctor's `referringDoctorNotifiedAt` seam is set).
- [x] Referral loop detection + max-hop limit (PRD §8.1.2). Tracked as [issue #65](https://github.com/DocForum/docforum-core/issues/65) (High, 200 pts). **Done:** lineage via `parent_referral_id`, bounded CTE walk, strict rule (repeat doctor/specialty anywhere in the chain — including the GP return — flags for the admin queue), hard `422` on self-referral and on chains over `REFERRAL_MAX_HOPS` (default 4).
- [x] Multiple simultaneous referrals from one consultation (PRD §8.2.4). Tracked as [issue #66](https://github.com/DocForum/docforum-core/issues/66) (High, 200 pts). **Done, including its ADR:** [`docs/adr/0017-multiple-referrals-per-consultation.md`](docs/adr/0017-multiple-referrals-per-consultation.md) records the decision (allowed; independent lifecycles, atomic all-or-none creation, grouped only for the patient view; no bundle table). Implementation: one snapshot copy per target, duplicate-specialty/doctor rejection, independent per-referral acceptance, patient list grouped by source consultation.
- [x] Cascade rules when a referral-origin appointment is cancelled or no-shows (PRD §8.2.3). Tracked as [issue #67](https://github.com/DocForum/docforum-core/issues/67) (High, 200 pts). **Done:** run inside the appointment's status transaction; cancelled → referral back to `pending` with the slot released, first no-show → `pending` + `noShowCount`, second → `expired` + `referringDoctorNotifiedAt` (threshold is a v1 default, not a tuned value); all writes conditional so a doubled hook no-ops.
- [x] Admin referral operations: queue, reassign stuck referrals, override routing, audited. Tracked as [issue #68](https://github.com/DocForum/docforum-core/issues/68) (Medium, 150 pts). **Done:** `GET /referrals/admin/queue` (status / `olderThan` / `loopFlagged` filters, derived reason + age), `POST /referrals/admin/:id/reassign` (pending only, target column only — snapshot untouched), `POST /referrals/admin/:id/cancel` (closes a live appointment through the appointments service), `GET /referrals/admin/:id/audit-events`; reassign/cancel write the first `AuditEvent` rows (new table — ARCHITECTURE.md §4.10).
- [x] Doc reconciliation: ARCHITECTURE.md §4.2/§4.3/§4.4/§4.10/§5.2/§6, ARCHITECTURE_ESSENTIALS.md data model map + known gaps, PRD §8.1.2/§8.1.3/§8.1.4/§8.2.1–§8.2.4, `docs/api/README.md`. Done in this change — #6's ADR is *not* part of it and the gap is deliberately left noted.
- [x] Incoming referrals inbox for target doctors (issue #306): `GET /referrals/incoming` is doctor-only, scoped to the caller's current `targetDoctorId`, defaults to `pending`/`accepted` with an explicit `status` filter for terminal referrals, and is keyset-paginated via `(createdAt, id)`. Snapshot notes are decrypted for the intended reader and each returned row writes a PHI access log; admin reassignment moves rows between inboxes automatically. Closes [issue #306](https://github.com/DocForum/docforum-core/issues/306).
- [x] Referring doctor can withdraw their own pending referral (issue #308): `POST /referrals/:referralId/withdraw` requires a bounded reason and performs one conditional `pending → cancelled` update (guarding `resultingAppointmentId IS NULL`) plus a `referral.withdraw` AuditEvent in the same transaction. The existing `cancelled` status and `cancelledReason` column are reused, so no schema change; withdraw/accept race and authorisation are covered by integration tests. Closes [issue #308](https://github.com/DocForum/docforum-core/issues/308).

## Phase 4 — Orders: prescriptions & lab orders
**Status: Partially implemented (issue #76: facility-side fulfillment proof, patient confirm/dispute, unconfirmed order expiry, admin dispute queue implemented and tested).**
- [ ] `Prescription` + `PrescriptionItem` models, **append-only** (issuance creates a row; corrections use `supersedes_prescription_id` — ARCHITECTURE.md §4.5, hard rule in ARCHITECTURE_ESSENTIALS.md). Tracked as [issue #9](https://github.com/DocForum/docforum-core/issues/9) (High, 200 pts), which also covers `LabOrder`/`LabResult` (same append-only rule).
- [ ] `LabOrder` + `LabResult` models, same append-only rule — folded into issue #9 above.
- [x] Specialist UI: issue prescription/lab order from a consultation. Tracked as [issue #10](https://github.com/DocForum/docforum-core/issues/10) (Medium, 150 pts) — depends on #9. **Backend done:** `POST /orders/consultations/:consultationId/{prescriptions,lab-orders}` go through the append-only issuance path, are limited to the consultation's treating doctor (verified profile), and refuse consultations whose appointment isn't `completed` (409) or an unknown/wrong-type facility (400). Tested in `backend/tests/integration/orders-issuance.test.mts`. The doctor screen is tracked in `docforum-web`.
- [ ] Patient UI: view active/past orders. Tracked as [issue #11](https://github.com/DocForum/docforum-core/issues/11) (Medium, 150 pts) — depends on #9.
- [x] Facility fulfillment proof & patient confirmation/dispute workflow. Tracked as issue #76. Facility fulfillment requires reference number and optional attachment. Patient confirm-receipt/dispute are mutually exclusive via DB conditional update. Derived `confirmedSignal` boolean. Idempotent expiry job for unconfirmed orders. Admin dispute queue and append-only resolution logs.
- [x] Medication catalog: a controlled prescription vocabulary imported from
  openFDA NDC (public domain; `backend/scripts/import-medications.mjs`,
  licence-checked before import) with `GET /medications?q=` autocomplete over
  a trigram index, and `PrescriptionItem.medicationId` plus a
  pharmacist-review flag for the explicit unlisted-medication path. The
  issued `drugName` stays a display snapshot, so catalog edits never rewrite
  an issued prescription. The 30k-row autocomplete p95 is asserted under
  500 ms in `backend/tests/integration/medications.test.mts`. Tracked as
  [issue #69](https://github.com/DocForum/docforum-core/issues/69)
  (High, 200 pts) — **Done**. The catalog is a picker, not an interaction
  checker (PRD §8.2.8 stays deferred).
- [x] Abnormal lab result escalation and doctor acknowledgement tracking (PRD §8.2.7), tracked as [issue #72](https://github.com/DocForum/docforum-core/issues/72) — **Done.** `LabResult.abnormality` (`normal|abnormal|critical`) is set by the fulfilling facility at attach time; abnormal/critical results create one `LabResultAcknowledgement` for the ordering doctor in the same transaction and notify them. `POST /lab-results/:id/acknowledge` is a one-shot conditional write with a `lab_result.acknowledged` audit event; `GET /lab-results/unacknowledged` is the doctor's list and (for admins) the escalation queue. An interval sweep marks overdue tasks escalated (`lab_result.escalated`), and `overdue` is derived from `escalationDueAt` so a missed tick cannot hide a task. Critical results are deliberately **not** withheld from the patient (decision recorded in PRD §8.2.7). Migration: `20261120120000_lab_result_abnormality_acknowledgement`.

## Phase 5 — Facilities & fulfillment
**Status: In progress — #13 (typed `FulfillmentRecord` order FKs, ADR 0012) and #14 (admin-only facility creation + fail-closed capability matching) are done; #15 (facility fulfillment UI/transition) and #16 (lab result attachment) are still open. Two independently-scoped items added later — #73 (partial fulfillment) and #74 (facility distance sorting) — have landed ahead of them, built on ADR 0012's `FulfillmentRecord` shape.**
- [x] Resolve the polymorphic `FulfillmentRecord` design smell flagged in ARCHITECTURE.md §6.1.3 **before** building this phase — decide: keep polymorphic with constraints, or split into `PrescriptionFulfillment` / `LabOrderFulfillment`. Record the decision as an ADR in `docs/adr/`. Tracked as [issue #13](https://github.com/DocForum/docforum-core/issues/13) (High, 200 pts) — the prerequisite for the rest of this phase. **Done — decision: one table, no polymorphism** (`docs/adr/0012-fulfillment-record-typed-order-fks.md`): `order_type`/`order_id` are replaced by real `prescription_id`/`lab_order_id` FKs (each `UNIQUE`, a PostgreSQL `CHECK` requires exactly one — the mechanism `PaymentIntent` got in #85) plus the `facility_id` FK §4.7 left as a TODO, all three `RESTRICT`. Splitting was weighed and rejected: two tables mean two implementations of the §5.3 step-5 transition and a cross-table union for a facility's queue. Schema + migration landed; no code reads the row yet — #14 creates it, #15 owns the transition, #16 attaches `LabResult` through its existing table.
- [x] Facility account creation (admin-invited only per PRD OQ-2 — no self-serve facility signup in v1) + `FacilityCapability` matching (patient sees only qualified facilities for their specific order, PRD FR-13). Tracked as [issue #14](https://github.com/DocForum/docforum-core/issues/14) (Medium, 150 pts) — depends on #13. **Done —** admin-only `POST /facilities` (User + profile + capabilities + `facility.created` audit row, one transaction; `POST /auth/signup` still refuses the role) and fail-closed capability matching in `GET /facilities/eligible` + `listEligibleFacilitiesForOrderKind`: facilities missing/mismatching capability data show for nothing. ADR 0012's "`#14 creates the row at selection`" is **not** in this issue — no selection endpoint exists yet; the `FulfillmentRecord` write and the `→ fulfilled` transition land with #15. See `changelog.d/14-facility-creation-capability-matching.md`.
- [ ] Facility fulfillment UI: view assigned orders, mark in-progress/fulfilled/rejected, enforcing that `status` transitions to `fulfilled` **only** via the facility-confirmed path (ARCHITECTURE.md §5.3 step 5 — patient/doctor cannot self-mark). Tracked as [issue #15](https://github.com/DocForum/docforum-core/issues/15) (Medium, 150 pts) — depends on #13/#14.
- [x] Lab result attachment (object storage integration — ARCHITECTURE.md §2 File/result storage row). Tracked as [issue #16](https://github.com/DocForum/docforum-core/issues/16) (Medium, 150 pts) — depends on #13. **Done —** provider: Amazon S3, private SSE bucket (`docs/adr/0018`), behind `utils/object-storage.ts`. `POST /orders/lab-orders/:labOrderId/result` lets only the order's own facility attach, once. `GET` on the same path serves the file to the patient, the ordering doctor and the fulfilling facility only, with no public or presigned URL. The response is access-logged and audited. The `LabOrder` and its `FulfillmentRecord` are untouched (`fulfilled` stays #15's). New scope noted in ARCHITECTURE.md §6.2.6: the export doesn't include the file bytes, and guardians can't read results. See `changelog.d/16-lab-result-attachment.md`.
- [ ] Address PRD §8.1.6 (facility fulfillment integrity) — at minimum, restrict which facilities can be selected to the curated/admin-invited list; document what's still unresolved if full anti-fraud isn't in scope for v1 — addressed by issue #14's admin-only gating; document any remaining gap in that issue's PR.
- [x] **Partial fulfillment: item-level dispensing for multi-item prescriptions.** Tracked as [issue #73](https://github.com/DocForum/docforum-core/issues/73) — **Done**. `FulfillmentItem` rows under a `FulfillmentRecord` now carry dispensed quantity + status per routed item; order status derives from items (`partially_fulfilled` / `fulfilled`) via a forward-only conditional update applied through the prescriptions/lab-orders module services; the patient can route remaining items to a second facility; a DB unique index on `(orderType, dispensedKey)` makes double-dispense by two facilities a constraint-level 409 (proven under concurrency in `backend/tests/integration/fulfillment.test.mts`). Payment-release rule documented in ARCHITECTURE.md §5.3: no release until the whole order derives `fulfilled`. Re-seated onto #13's resolved ADR 0012 shape (typed order FKs, not the old polymorphic pair); the ADR's "one record per order" UNIQUE became one per **(order, facility)** so a split order can hold a record at each facility — see the ADR's 2026-10-26 amendment.
- [x] **Facility location and distance-sorted facility selection.** Tracked as [issue #74](https://github.com/DocForum/docforum-core/issues/74) — **Done**. `FacilityProfile.address/latitude/longitude` (nullable) + composite index; `GET /facilities/eligible?near=lat,lng&radiusKm=` with an indexed bounding box + haversine (PostGIS rejected — justification and the privacy/no-storage rule in ARCHITECTURE.md §5.5); facilities without coordinates appear, sorted last; seeded fictional coordinates via `npx prisma db seed`; measured over ~3 000 facilities in `backend/tests/integration/facility-distance.test.mts` (single-digit-millisecond p50/p95, well inside the test's 500 ms ceiling).
- [x] **Remove direct cross-module table access** (issue #318, Medium, 150 pts) — **Done.** `lab-orders`, `pharmacy-orders`, and `payments` modules no longer query `facilityProfile`, `patientProfile`, or related tables directly. All cross-module reads are routed through the owning module's service layer. See `changelog.d/318-remove-cross-module-table-access.md`.
- [x] **Admin management of facility capabilities** (issue #320, Medium, 150 pts) — **Done.** `POST /facilities/:facilityId/capabilities` and `DELETE /facilities/:facilityId/capabilities/:capabilityId`, admin-only. Both operations record `FacilityCapability` audit events. See `changelog.d/320-admin-facility-capabilities.md`.
- [x] **Retire a facility price-list item** (issue #321, Medium, 150 pts) — **Done.** New `retired` boolean on `FacilityPrice` (append-only). `resolveCurrentPrice` returns `{ retired: true }` for retired items; `requireCurrentPrice` throws `ITEM_RETIRED` (422). `POST /facilities/me/prices/retire` endpoint. See `changelog.d/321-retire-facility-price-item.md`.
- [x] **Patient read access for fulfillment records** (issue #323, Medium, 150 pts) — **Done.** `getFulfillment` now allows patient/guardian access (ownership checked via `FulfillmentRecord` → typed FK → prescriptions/lab-orders service). Added `GET /pharmacy-orders/orders/:orderId/fulfillments` list endpoint. See `changelog.d/323-patient-read-fulfillment-records.md`.

## Phase 5.5 — Payments (consumer side)
**Status: Payment order linkage, automatic intent issuance, configuration hardening, and platform signer abstraction are implemented; fulfillment-triggered release remains pending.** See docs/adr/0004-custodial-payments-v1.md. Verified against **live testnet**, not mocked — `npm run test:integration:payments-testnet` (3/3 passing): fund→release, fund→refund, and reject-when-no-wallet-linked.
- [x] `PaymentIntent` + `WalletLink` models finalized (relational metadata only — no PHI). `WalletLink` scoped to the **facility** (payee), not the patient — see ADR 0004. Amount is the asset's smallest unit (`BigInt`), with `assetCode` + `tokenContractId` per intent after #79 (native XLM plus an allowlisted USDC), not the originally-scaffolded `Decimal`+implicit `"USDC"`.
- [x] Added `@docforum/escrow-sdk` as a real dependency (via the GitHub Release tarball URL — see `docforum-escrow`'s ADR 0003); wired `payments/services` to call it through a dynamic `import()` (`escrow-sdk-loader.ts` — the SDK is ESM-only, this backend is CommonJS).
- [x] On order issuance, create a `PaymentIntent` (`created` status) automatically with a typed order FK. Manual intent creation was removed. Corrections move created intents; funded intents remain attached to the immutable original.
- [x] [Issue #88] Harden payments configuration: typed network/RPC/contract/asset settings, mainnet opt-in guard, startup reachability check, and intent-recorded contract ids for release/refund.
- [x] Soroban contract-event poller, per-deployment persisted cursors, unmatched release/refund alerts, and admin event view (issue #86). Contract deployments must include their deployment ledger; RPC retention gaps are surfaced for operator reconciliation.
- [x] On patient funding action, call SDK to move funds into escrow (`escrowed` status), store `stellarTxHash` — except it's not a *patient* action in this design (custodial v1, ADR 0004): `POST /payments/intents/:id/fund`, admin-triggered, funds from `docforum-core`'s own platform payer identity.
- [x] Automatic escrow release when fulfillment is confirmed (issue #83) — **done**: the order's `fulfilled` transition publishes `order.fulfilled` in the same transaction; the transactional-outbox worker calls SDK `release` with bounded retries/backoff and a conditional intent update, so a killed worker resumes rather than losing or duplicating the task. Only a whole order (all items across every facility) releases — partial fulfillment never does. `POST /payments/intents/:id/release` remains an audited admin override; `NotFunded` is a terminal reconcile. See `docs.d/83-automatic-settlement.md`.
- [x] Automatic refund for rejected or expired orders (issue #84) — **done**: a wholesale rejection with nothing dispensed (and no still-open fulfillment record) and a lab order expiring unfulfilled each publish `order.rejected`/`order.expired` in their own transaction; the same durable worker refunds through the releaser (consistent audit trail) and notifies the patient on completion. Escrow already released is never refunded — the conditional status update is the guard. `POST /payments/intents/:id/refund` remains an audited admin override.
- [x] Idempotent escrow funding + on-chain reconcile job (`fundPaymentIntent` is check-then-act — docforum-escrow threat model §5). Tracked as [issue #24](https://github.com/DocForum/docforum-core/issues/24) (High, 200 pts) — **Done:** the intent is claimed `created -> funding` by one conditional UPDATE that commits before `create_escrow`, so N concurrent fund requests make exactly one chain call (integration test, 8 concurrent requests); a failed chain call returns it to `created` (audited), and a crash between the call and the settle write is resolved explicitly with `npm run reconcile:escrows` (`--adopt` an escrow the event poller observed, or `--abandon` a claim that never reached the chain) — never by retrying the chain call. New `funding` status + `fundingStartedAt` column; no on-chain list API exists in SDK 0.2.0, so the report reads the `EscrowChainEvent` observations the poller already records.
- [x] ADR: releaser key custody — multisig, KMS, or per-period rotation (threat model T1/T2). Tracked as [issue #25](https://github.com/DocForum/docforum-core/issues/25) (Medium, 150 pts) — **Done:** [`docs/adr/0016-releaser-key-custody.md`](docs/adr/0016-releaser-key-custody.md) chooses a 2-of-4 Stellar multisig releaser for production escrows (three custodied signers + offline master, medium/high threshold 2), records the expiry deadline is met by ADR 0015's paid database, rejects KMS/HSM for v1 and per-period rotation as the primary control, and lists the code follow-ups (SDK multi-signer support, `PaymentIntent`-recorded releaser public key, two-step settlement approval). Staging/preview keep a single-signer testnet releaser.
- [x] Checksum-validate facility wallet keys, not just regex. Tracked as [issue #26](https://github.com/DocForum/docforum-core/issues/26) (Trivial, 100 pts) — validated via `StrKey.isValidEd25519PublicKey` in payments Zod schemas (`backend/src/modules/payments/validation.ts`), rejecting invalid CRC16 checksums, malformed prefixes and bad lengths.
- [x] Patient payment history and facility payout ledger APIs, with ownership-scoped pagination, on-chain references, and BigInt-safe SQL totals. Tracked as [issue #90](https://github.com/DocForum/docforum-core/issues/90) — **implemented; `refundAfter` remains null until a payment model/contract version supports deadlines**.
- [x] Nightly/manual testnet payment verification with fresh Friendbot-funded identities and deduplicated failure tracking. Tracked as [issue #91](https://github.com/DocForum/docforum-core/issues/91).
- [x] Payout privacy prototype: testnet-only pooled payout support in the escrow funding path, with direct facility payouts as the default in production/local environments. Tracked as [issue #92](https://github.com/DocForum/docforum-core/issues/92).
- [ ] Non-custodial patient payments (v2): patients fund escrows from their own Stellar wallet, custodial kept as fallback. **Proposed** in `docs/adr/0005-non-custodial-patient-payments.md`; implementation issues to be opened once it's Accepted.
- [x] Multi-asset intents (USDC + native XLM per-environment allowlist, payee trustline checks) and the patient-signed prepare half of ADR 0005. Tracked as [issue #79](https://github.com/DocForum/docforum-core/issues/79) and [issue #80](https://github.com/DocForum/docforum-core/issues/80). Prepare returns `503 ESCROW_SDK_PREPARE_UNSUPPORTED` against SDK 0.2.0 until #32 lands; submit/fee-bump is out of scope for #80.
- [ ] Upgrade to `@docforum/escrow-sdk` 0.3.0 and the current testnet contract (`refund_after`, balance-delta check, `getEscrow`) — step 1 of ADR 0005's plan, but worth doing regardless. Tracked as [issue #32](https://github.com/DocForum/docforum-core/issues/32) (Medium, 150 pts); depends on `docforum-escrow` publishing `sdk-v0.3.0`. **Blocked (2026-11-20): `sdk-v0.3.0` is still unpublished** (only `sdk-v0.1.0` and `sdk-v0.2.0` exist), so the bump cannot be made. Core-side capability that issue #32 depends on is covered meanwhile: release/refund pin the contract id recorded on the intent, proven for legacy-contract intents in `backend/tests/integration/payments-assets.test.mts`.
- [ ] Doc reconciliation: PRD §8.1.6 (facility fulfillment integrity) — not marked resolved; this phase proves the payment *mechanism* works, not the fulfillment-integrity question, which still needs real `FulfillmentRecord`/facility-matching (Phase 5) to actually address.
- [x] Integration tests for the escrow-events admin endpoint (issue #327): access, `state` filter, ordering, cursor pagination (`cursor`/`nextCursor` added), `catchupError` and unmatched-event flags, no network. `backend/tests/integration/escrow-events.test.mts`.
- [x] Audit and cool-down for facility payout-wallet changes ([issue #328](https://github.com/DocForum/docforum-core/issues/328)): every link is audited (old + new address) in its own transaction; a facility re-link becomes the payee only after `WALLET_LINK_COOLDOWN_HOURS` (first-ever link immediate); `GET /admin/payments/wallet-links/pending` lists changes in the window.
- [x] CSV export of the facility payout ledger ([issue #329](https://github.com/DocForum/docforum-core/issues/329)): `GET /payments/facility/ledger.csv`, same filters as the JSON ledger, streamed in keyset pages, formula-injection-safe cells.
- [x] Operator runbook for the escrow event alerts and RPC retention gaps this phase produces (issue #356): `docs/runbooks/escrow-event-alerts.md` covers reading `GET /admin/payments/escrow-events` (items, cursors, `catchupError`), triaging an `unmatched` release or refund through the intent, audit trail, dead letters and `npm run reconcile:escrows`, when to pause `payments.wallet_funding` and what pausing does not stop, and how to recover a contract whose cursor stalled behind the RPC's retained history. Every step cites the code path it relies on, and the runbook ends with the operator controls that do not exist yet so nobody hunts for them. Linked from `ARCHITECTURE_ESSENTIALS.md`'s escrow monitoring section and from the docs site, which now syncs `docs/runbooks/`.

## Phase 6 — Notifications
**Status: In progress. The owner-scoped in-app inbox, provider-agnostic dispatch interface, and booking transactional outbox are implemented. Email/SMS provider work remains blocked on issue #17's provider decision.**
- [x] `Notification` model + dispatch interface (provider-agnostic, per ARCHITECTURE.md §2), plus authenticated in-app inbox API — issue #93.
- [ ] Trigger points per PRD FR-15/FR-16 (booking confirmed, referral created/accepted/declined, order ready, results available, new booking, lab results returned) — still blocked by Phases 3/4.
- [x] Transactional outbox for domain events, starting with booking confirmed — [issue #94](https://github.com/DocForum/docforum-core/issues/94). Events publish in the booking transaction; a `SKIP LOCKED` worker retries at least-once handlers and dead-letters after five attempts.
- [ ] Pick and integrate a real provider (email/SMS) behind the interface — provider choice is currently undecided (ARCHITECTURE.md §8). Tracked as [issue #17](https://github.com/DocForum/docforum-core/issues/17) (Trivial, 100 pts) — a decision task, unblocked now.
- [x] Email adapter, templates, and signed bounce/complaint webhook — [issue #95](https://github.com/DocForum/docforum-core/issues/95); depends on #17 and #93.
- [x] SMS adapter, delivery callbacks, consent/opt-out, and send cap — [issue #96](https://github.com/DocForum/docforum-core/issues/96); depends on #17 and #93.
**Status: In progress — provider decision made (see `docs/adr/0013-notification-provider.md`, issue #17). Trigger-point build-out still blocked by Phases 3 & 4 and deliberately left unscoped until those land.**
- [ ] `Notification` model + dispatch interface (provider-agnostic, per ARCHITECTURE.md §2) — part of the trigger-point work, still blocked.
- [ ] Trigger points per PRD FR-15/FR-16 (booking confirmed, referral created/accepted/declined, order ready, results available, new booking, lab results returned) — still blocked by Phases 3/4.
- [x] Pick and integrate a real provider (email/SMS) behind the interface — **decided:** email via Postmark (SMS deferred, no provider chosen); the adapter stays behind the provider-agnostic dispatch interface and no provider calls live in business logic. Tracked as [issue #17](https://github.com/DocForum/docforum-core/issues/17) (Trivial, 100 pts) — decision recorded in `docs/adr/0013-notification-provider.md`; integration itself is still to be built.
- [x] Cross-instance real-time fan-out ([issue #330](https://github.com/DocForum/docforum-core/issues/330)): `notify()` publishes ids-only events with `pg_notify`; each instance `LISTEN`s on a dedicated connection, reconnects with backoff (clients get `resync`), and reports the listener state in `/health/ready`. Tested with two app instances on one Postgres.
- [x] Integration tests for the notification SSE endpoint (issue #331): 401, exact per-user cap (`429 STREAM_LIMIT`), heartbeats, published-event delivery, `token-expired`, unsubscribe on disconnect. `backend/tests/integration/notification-stream.test.mts`.

## Phase 7 — Frontend: core flows end-to-end
**Status: Superseded.** This phase predates the 3-repo org split (see the org note at the top of this file) — all frontend work described below is actually tracked in `docforum-web`'s own `ROADMAP.md` (Phases W2–W5, issues opened there). Left in place as a historical record rather than deleted, but no issues are or will be opened against it here.
- [ ] ~~Patient: search doctors by specialty/availability, book, submit intake.~~ → `docforum-web` Phase W2.
- [ ] ~~Patient: view referral status, accept/decline.~~ → `docforum-web` Phase W2.
- [ ] ~~Patient: view orders, select fulfilling facility.~~ → `docforum-web` Phase W2.
- [ ] ~~Doctor: manage availability, view bookings, run consultation, issue referral/orders.~~ → `docforum-web` Phase W3.
- [ ] ~~Facility: view assigned fulfillment queue, update status, attach results.~~ → `docforum-web` Phase W4.
- [ ] ~~Shared: auth screens (signup/login per role).~~ → already built, `docforum-web` Phase W1.

## Phase 8 — Hardening (safety, audit, security)
**Status: In progress. In addition to the original five items (#18–#20 scoped, two still blocked), four auth-hardening items are scoped as #34, #35, #37 and #39 — #34 and #35 are merged; #37 and #39 are open PRs. An access-control test suite (#44) is built and tested, and `Idempotency-Key` replay protection (#48) is in review. Each is independent of the others and of Phases 3–7, and each carries its own schema/doc updates.**

- [x] Admin success-metrics endpoint for available booking lead-time and no-show measures; unsupported PRD metrics are explicitly marked unavailable. Definitions and suppression policy: `docs/success-metrics.md`. Tracked as [issue #124](https://github.com/DocForum/docforum-core/issues/124).

- [x] Email verification on signup, with restricted access for unverified accounts. `User.emailVerifiedAt` + `EmailVerificationToken` (hashed, expiring, single-use), `POST /auth/verify-email`, `POST /auth/verify-email/resend`, and a `requireVerifiedEmail` guard on booking + payment mutations (never on login/browsing). Migration backfills existing rows as verified. Tracked as [issue #34](https://github.com/DocForum/docforum-core/issues/34) (High, 200 pts) — **Done**, merged as PR #137. Found a real dependency while building it: the email *provider* is still an open decision (Phase 6, issue #17), so links can't be delivered on a hosted deployment yet — see `backend/src/modules/auth/services/email-dispatcher.ts` and ARCHITECTURE.md §6.1.5.
- [x] Login brute-force protection: per-account and per-IP throttling with backoff. Postgres-backed buckets (`LoginAttempt`), a single conditional upsert so concurrent failures are counted atomically, exponential backoff with `Retry-After`, a bounded temporary lock, an admin clear endpoint, a prune interval in `src/server.ts`, and a `TRUST_PROXY` setting so the IP isn't Render's proxy address. Tracked as [issue #35](https://github.com/DocForum/docforum-core/issues/35) (High, 200 pts) — **Done**, merged as PR #138.
- [ ] CSRF protection for the cookie-authenticated refresh/logout endpoints, plus an explicit per-environment CORS allowlist. A per-session CSRF token bound into the refresh token (not a double-submit cookie — a cookie set by this API is third-party to `docforum.github.io`, so the web client can't read it), a required `X-CSRF-Token` header on `/auth/refresh` + `/auth/logout`, an `Origin` allowlist check, and `CORS_ORIGINS` replacing the single configured origin. Tracked as [issue #37](https://github.com/DocForum/docforum-core/issues/37) (High, 200 pts) — **in progress**, branch `feat/csrf-protection-for-cookie-authenticated-refresh`.
- [ ] Admin account lifecycle: secure bootstrap CLI, admin invites, and account deactivation. Tracked as [issue #39](https://github.com/DocForum/docforum-core/issues/39) (High, 200 pts) — **in progress**.
- [ ] PostgreSQL row-level security for patient-scoped reads: policies for appointments, payment intents, and consultations; transaction-local Prisma context; and a dedicated bypass role for trusted maintenance work. `IntakeForm` is deferred until the schema has a real patient ownership relation. Decision: [ADR 0014](docs/adr/0014-postgres-row-level-security.md). Tracked as [issue #116](https://github.com/DocForum/docforum-core/issues/116) (High, 200 pts) — in progress.
- [ ] Patient data export (right of access) as a complete, machine-readable bundle. `POST /patients/me/export` + `GET /patients/me/export/:id` (+ `/download`), owner-only; an exporter registry where each module contributes its own section through its service (ARCHITECTURE.md §3.1 — `account`, `profile`, `appointments`, `payments` today); versioned JSON with `generatedAt`; generated by an interval worker in `src/jobs/patient-exports.ts` and stored as bounded chunks in Postgres (`PatientExport`/`PatientExportChunk`, §4.11 — no object-storage provider exists yet, see §6.3.4); expiry + cleanup after `PATIENT_EXPORT_TTL_HOURS`. Tracked as [issue #40](https://github.com/DocForum/docforum-core/issues/40) (High, 200 pts) — **in review**, branch `feat/40-patient-data-export`. Later modules (referrals, prescriptions, lab orders) must register their own section when they land; a verified guardian exporting a dependent's data is left to issue #42's model.
- [ ] `AuditEvent` table and write path — **foundation done, Phase 3/4 wiring pending.** Append-only `AuditEvent` (DB triggers reject UPDATE/DELETE/TRUNCATE), `auditService.record()` that must run inside the state change's own transaction, request ids on every response, and `GET /admin/audit-events` (entity/actor/date filters, keyset cursor). Wired into appointment booking (both the direct and the referral-origin path), doctor verification, payment fund/release/refund, the patient's referral accept/decline and the referral admin actions (`referral.reassign` / `referral.cancel`, Phase 3 issue #68 — recorded as `entityType: 'Referral'` rows in this one table, not a second referral-specific table). Still unaudited: the referral's *creation* and the cascade-driven `completed`/`expired` transitions (no actor to attribute them to), the remaining Phase 4 order transitions, and the login-throttle admin clear (console-only). Tracked as [issue #43](https://github.com/DocForum/docforum-core/issues/43) (High, 200 pts) — **in review**, branch `feat/43-auditevent-foundation`.
- [ ] Account deletion with clinical-record retention: `DELETE /patients/me` (password re-confirmation, throttled) anonymises the identity in place and keeps appointments + payment intents intact; `PatientProfile.userId` FK CASCADE → RESTRICT (migration); interval purge of record-free tombstones (`src/jobs/account-purge.ts`, holds in `src/retention-holds.ts`). Decisions in `docs/adr/0010` — the **legal retention period for clinical/order/payment records stays an open decision** (kept indefinitely until set). Tracked as [issue #41](https://github.com/DocForum/docforum-core/issues/41) (High, 200 pts) — **in review**, branch `feat/41-account-deletion-retention`. Follow-up when #40 also merges: delete a deleted patient's `PatientExport` rows inside the anonymisation transaction (ADR 0010 table).
- [ ] Guardian and dependent accounts: booking on behalf of a minor. Dependents are guardian-owned `PatientProfile`s with no login, linked through a real `Guardianship` relation that replaces the unenforced `guardianUserId` string (migration refuses to run over legacy values); `POST`/`GET /patients/me/dependents` (create-only — no linking of existing profiles); `patientProfileId` on `POST /appointments` (and `GET /appointments/mine`) authorised in the service layer before the unchanged booking transaction; access ends automatically at `AGE_OF_MAJORITY_YEARS` (default 18). Decisions in `docs/adr/0011`; PRD §8.2.5 marked resolved/re-scoped. Tracked as [issue #42](https://github.com/DocForum/docforum-core/issues/42) (High, 200 pts) — **in review**, branch `feat/42-guardian-dependent-accounts`. Follow-ups: majority account-claim flow, guardian/admin revoke endpoints, guardianship verification beyond self-assertion.
- [x] JWT refresh revocation list (ARCHITECTURE.md §6.1.4). Tracked as [issue #18](https://github.com/DocForum/docforum-core/issues/18) (Medium, 150 pts). Done: the `RefreshSession` store that `POST /auth/refresh` checks (#143) plus `User.tokenVersion` (#140).
- [x] Held-slot TTL/release job (ARCHITECTURE.md §6.2.1). Tracked as [issue #19](https://github.com/DocForum/docforum-core/issues/19) (Medium, 150 pts) — **investigated, not applicable as currently designed.** Phase 1's `claimOpenSlot` claims a slot directly via a single conditional `UPDATE ... WHERE status = 'open'` inside the booking transaction (proven by `backend/tests/integration/booking.test.mts`: 8 concurrent attempts, exactly 1 wins) — there is no intermediate `held` status, so an abandoned hold cannot exist and there is nothing for a TTL job to release. No hold state was introduced to give this issue something to do. Revisit if a multi-step booking flow (e.g. reserving a slot while a patient fills out Phase 2 intake) introduces a `held` state; that flow would need a `heldAt`/`holdExpiresAt` column plus a sweep job, and this issue should be reopened then.
- [x] Access-control test suite: who may read intake, consultation and payment data. Integration tests (`tests/integration/access-control.test.mts`) establishing the test harness and access-control patterns for the three PHI data categories; intake/consultation test cases are scaffolded as placeholders until Phase 2/3 routes exist, payment-intent access cases exercise the live admin-gated routes. Tracked as [issue #44](https://github.com/DocForum/docforum-core/issues/44) — **Done**.
- [ ] Privacy access-control audit: confirm intake/consultation notes are visible only per PRD §7 (patient, treating doctor(s) in-thread, fulfilling facility for that specific order only) — write tests, not just code review. Still blocked — meaningfully auditable only once Phase 3/4/5 access paths exist. **One Phase 3 access path is now worth auditing (`GET /consultations/:id` — treating doctor + that appointment's patient only, and referral snapshot exposure on `GET /referrals/mine` / `/created` / `/incoming` — issue #306 logs target-doctor reads), but intake and orders remain unbuilt, so the audit as scoped stays blocked.** Not yet scoped into an issue.
- [ ] Decide and document what's explicitly out of scope for v1 launch vs. genuinely blocking (e.g., drug-interaction checking, PRD §8.2.8 — needs an explicit go/no-go, not silence). Tracked as [issue #20](https://github.com/DocForum/docforum-core/issues/20) (Trivial, 100 pts) — a decision task, unblocked now.
- [x] Feature flags for staged rollouts (DB-backed, per environment and per user cohort). Tracked as [issue #132](https://github.com/DocForum/docforum-core/issues/132) (High, 200 pts) — **Done:** `FeatureFlag` table + `modules/flags` (boolean and sticky hash-percentage flags, role and user-id targeting, in-memory cache with a short TTL, evaluation that never throws and defaults to off), `GET /admin/feature-flags` and `PATCH /admin/feature-flags/:key` with a `feature_flag.*` audit event per change, `GET /me/flags` for the frontend, and the wallet payment mode (`payments.wallet_funding`, seeded off) as the first flag user.
- [x] TOTP two-factor authentication (RFC 6238) with single-use recovery
  codes. Enrolment returns a provisioning URI and confirms with one valid
  code; login becomes two-step (`mfaRequired` + a short-lived `mfa_pending`
  token that no other route accepts). Replay is blocked by claiming the
  TOTP time step with one conditional `updateMany`, not by a client flag.
  Secrets are encrypted with the existing field-encryption key; recovery
  codes are SHA-256 hashed and single-use. `TOTP_REQUIRE_FOR_ADMIN` can
  force enrolment for admin accounts through a narrow `mfa_enrollment`
  token that only the setup/enable routes accept. Implemented without a new
  dependency (`node:crypto`). Tracked as
  [issue #36](https://github.com/DocForum/docforum-core/issues/36)
  (High, 200 pts) — **Done**. Tests:
  `backend/tests/unit/totp.test.ts` (RFC 4226/6238 vectors) and
  `backend/tests/integration/two-factor.test.mts`.
- [x] Admin user directory: `GET /admin/users` with role / active / deactivated / deleted filters, indexed email-prefix search and keyset pagination; account-level fields only, tombstones marked `deleted` with a null email. Tracked as [issue #275](https://github.com/DocForum/docforum-core/issues/275) — **Done.**
- [x] Auth-artifact retention: a batched, configurable prune for expired/consumed `EmailVerificationToken`, `PasswordResetToken` and `AdminInvite` rows, revoked `RefreshSession` rows and stale `Sep10Challenge` rows (`src/jobs/auth-token-prune.ts`). Live tokens and active sessions are never touched. Tracked as [issue #276](https://github.com/DocForum/docforum-core/issues/276) — **Done.**
- [x] Admin invite list/revoke: `GET /admin/invites` and `DELETE /admin/invites/:id` (conditional revoke vs. redeem, audited), so an unredeemed invite can be cancelled. Tracked as [issue #277](https://github.com/DocForum/docforum-core/issues/277) — **Done.**
- [x] Active refresh-session cap: `MAX_ACTIVE_SESSIONS_PER_USER` (default 10), enforced atomically with session creation by evicting the least recently used sessions under a per-user advisory lock. Tracked as [issue #278](https://github.com/DocForum/docforum-core/issues/278) — **Done.**
- [x] Guardian read access to a dependent's consultations, referrals and lab results (issue #305): an optional `patientProfileId` on consultation detail, referral list/accept/decline and lab-result download authorises through `patientsService.resolveActingProfile`; ended guardianships get `403 GUARDIANSHIP_INACTIVE`, unrelated profiles `404`, and guardian reads are PHI-access-logged. Existing caller-only behaviour is unchanged. Closes [issue #305](https://github.com/DocForum/docforum-core/issues/305).
- [x] Security response headers and `X-Powered-By` removal (issue #332): nosniff, `Referrer-Policy: no-referrer`, restrictive CSP, `X-Frame-Options: DENY`, `Cache-Control: no-store` on every response, HSTS in production only; unmatched routes return a JSON 404. `backend/src/middleware/security-headers.ts`.

## Phase 9 — Deploy & CI
**Status: In progress. Structured JSON logging (request IDs + PHI redaction) landed; load tests (k6) for search, slot listing and booking contention added; automated Postgres backups with a tested restore drill are now implemented (issue #107). A Render free-tier preview exists — see note. Production deploy still Not started. Remaining items scoped into issues #21–#22.**
- [x] Localization foundation ([issue #133](https://github.com/DocForum/docforum-core/issues/133)): persist a supported locale from `Accept-Language` at signup, format coded errors and password-reset notifications with ICU catalogs (English source + French stub), and enforce catalog key parity in CI. Other server messages remain English until their owning flows adopt the catalog.
- [x] **PR malware scan** — `.github/workflows/pr-malware-scan.yml` + `.github/scripts/pr-malware-scan.cjs`, on every PR push. Flags editor/devcontainer autorun tasks, npm install hooks, typosquatted packages and Actions, non-registry dependency sources, payloads disguised as fonts/images, base64/whitespace obfuscation, exfiltration endpoints, reverse shells and miners. HIGH findings fail the `Malware scan` check, label the PR `security-review` and @mention the author; one comment per PR, updated in place. Reads the PR as data only (never checks out or runs it). Added 2026-10-20 after a VS Code autorun payload (escrow #163) and a typosquatted action (escrow #176). Manual backfill (Actions → PR malware scan → Run workflow, `prs: all`) scans PRs opened before the scanner and records a `Malware scan` commit status, which satisfies the required check.
- [ ] End-to-end care-thread integration test: book → consult → refer → accept → order → fulfil → release. A single self-contained test (`backend/tests/integration/care-thread.test.mts`) driving the full thread through HTTP only, against embedded Postgres with the escrow SDK mocked; asserts the key invariants at each step (snapshot equality, append-only orders, facility-only fulfillment, payment status) rather than just status codes. Steps are phase-gated — each phase's steps are skipped with a reason until that phase lands, so the scaffold and already-built steps (booking, consult, refer, accept) run now and the rest enable as Phases 4/5 land. Runs as part of `test:integration` in CI, runtime kept under a minute. Tracked as [issue #69](https://github.com/DocForum/docforum-core/issues/69) (High, 200 pts) — **in progress**, branch `feat/end-to-end-care-thread-integration-test-book`.
- [x] Choose deployment target (ARCHITECTURE.md §8 open decision) — record as an ADR. **Done:** [`docs/adr/0015-production-deployment-target.md`](docs/adr/0015-production-deployment-target.md) decides **Render, paid tier** (one Pro workspace, Blueprint-defined `docforum-core-staging` + `docforum-core-production`, one paid Render Postgres per environment, secrets in per-environment environment groups with the password manager as source of record). Paid Postgres removes the free-tier 30-day expiry (the 2026-12-04 deadline is the last one), gives 7-day PITR, and ADR 0007's encrypted off-platform dumps + weekly restore drill now target a real environment. The free preview from `docs/adr/0003-render-preview-deployment.md` is unchanged and stays preview-only. Tracked as [issue #22](https://github.com/DocForum/docforum-core/issues/22) (Medium, 150 pts). Alternative recorded, not chosen: Fly.io + Neon, and AWS with Secrets Manager for a later KMS/audit story.
- [x] Real CI pipeline (replaced `.github/workflows/ci.yml` placeholder — was `pull_request`-only, `echo "TODO"`, never once run). Now runs on push to `main` and on PRs: `npm audit --omit=dev` at high severity (`audit:prod`, Phase 8 issue #47) → `prisma:generate` → `typecheck` → unit tests → **integration tests (the self-contained embedded-Postgres double-booking proof)** → `build`. Verified locally end-to-end before pushing (14 unit + 1 integration test passing) and confirmed green in Actions. The "no lint script exists yet" gap was closed by [issue #28](https://github.com/DocForum/docforum-core/issues/28) (Trivial, 100 pts): `npm run lint` runs ESLint 9 with type-aware `typescript-eslint` from an isolated `backend/tools/lint` toolchain (pinned to the TypeScript 6 compatibility API — TS 7 has no compiler API for it to load), and CI runs it after `typecheck`. Closes [issue #21](https://github.com/DocForum/docforum-core/issues/21) (Medium, 150 pts).
- [ ] Staging environment. **Unblocked:** issue #22's decision landed (ADR 0015 — Render paid, Blueprint-defined staging service + paid staging Postgres). Provisioning it is the next item; not yet scoped into its own issue.
- [ ] Production environment + secrets management. **Unblocked:** ADR 0015 decides the topology and the environment-group/password-manager secret handling. Provisioning, 2FA/access review and the rotation runbook are the remaining work; not yet scoped into its own issue.
- [x] **Automated Postgres backups with a tested restore drill** — `scripts/backup-postgres.sh` takes an encrypted logical backup (`pg_dump --format=custom` piped through `gpg --symmetric`, so the plaintext dump never touches disk) with a retention window; `scripts/restore-drill.sh` restores the latest backup into a scratch database with explicit confirmation and name guards (the target must end in `_drill`/`_scratch` and must not be the source database), then runs integrity checks (row counts, `_prisma_migrations`, a sample booking query). `.github/workflows/backup-restore-drill.yml` runs the round-trip daily (and on demand) against a seeded throwaway Postgres service. It does not touch the Render preview database yet, because there's no production target (see the deployment decision above). Design and RPO/RTO notes are in `docs/adr/0007-postgres-backups-and-restore-drill.md` and `infra/backup/README.md`. Tracked as [issue #107](https://github.com/DocForum/docforum-core/issues/107) — **Done**.
- [x] Docs site deployed — `docs/site/` (VitePress) via `.github/workflows/deploy-docs.yml`, live at https://docforum.github.io/docforum-core/. Unrelated to the production-deploy decision above; this is a static site with no backend of its own.
- [x] Cross-repo docs-site rebuild ([issue #29](https://github.com/DocForum/docforum-core/issues/29)): `.github/workflows/deploy-docs.yml` accepts `repository_dispatch` (`upstream-docs-updated`, `docs-sync`) from sibling repositories (`docforum-web`, `docforum-escrow`); token setup and dispatch workflow documented in `docs/site/README.md`.
- [x] **PR conflict notifier** — `.github/workflows/pr-conflict-notifier.yml` + `.github/scripts/pr-conflict-notifier.cjs`. On every push to `main` (and every 3h) it labels open PRs that conflict with `main` as `needs-rebase` and @mentions the author once per push with rebase steps; the label clears itself when the conflict is resolved. Runs from `main` only and never checks out PR code.
- [x] Structured JSON logging with request IDs and automatic PHI redaction. A `pino` logger (`backend/src/logger.ts`) with per-environment level (`LOG_LEVEL`, default `silent` under `NODE_ENV=test`), a request-scoped child logger carrying a request id (incoming `X-Request-Id` accepted or one generated, echoed on the response), and a redaction config covering auth headers, cookies, passwords, tokens and a list of PHI field paths. A custom `BigInt`-safe serialiser so `BigInt` values (payment amounts) log instead of crashing. The error handler routes through the request-scoped logger — stacks server-side, safe envelope to the client. Redaction unit tests assert each configured path is redacted. Still open (follow-up scope, not blocking): the remaining `console.*` call sites in `src/` (jobs, auth, users, audit) are not yet converted, and the `no-console` lint/grep gate described in the original plan is not implemented. Closes [issue #30](https://github.com/DocForum/docforum-core/issues/30) (High, 200 pts).
- [x] **Load tests (k6)** — `backend/tests/load/` (`search.js`, `slots.js`, `booking-contention.js`), `backend/scripts/seed-load-test.mjs` (thousands of doctors + slots), and `.github/workflows/load-tests.yml` (manual/nightly, never against the shared Render preview). Thresholds enforce p95 latency on read paths and zero double-bookings; the contention scenario asserts correctness from the database afterwards (exactly one booking per slot), not just response codes. First results committed in `backend/tests/load/REPORT.md`.

- [ ] Fixed-seed property tests for slot generation and appointment/payment state machines, with an expanded nightly run. Tracked as [issue #120](https://github.com/DocForum/docforum-core/issues/120).
- [x] Generated OpenAPI 3.1 contract with CI drift detection and non-production `/openapi.json` serving ([issue #112](https://github.com/DocForum/docforum-core/issues/112)).
- [x] Supply-chain security gates for CodeQL, high-severity dependency review, gitleaks, and SHA-pinned security actions ([issue #111](https://github.com/DocForum/docforum-core/issues/111)).
- [x] Body-parser errors return 400/413/415 with stable codes instead of 500, logged at `warn` without the raw body ([issue #333](https://github.com/DocForum/docforum-core/issues/333)).
- [x] Prisma not-found (`P2025` → 404) and foreign-key (`P2003` → 422) errors no longer surface as 500, with generic messages; referral creation answers `422 SPECIALTY_NOT_FOUND` for an unknown specialty (issue #334).

## Explicitly deferred (not on this roadmap, tracked so they aren't forgotten)
- In-app video/voice consultation (PRD OQ-1 — v1 assumes in-person + async messaging).
- Insurance/billing.
- HL7/FHIR interoperability export.
- Native mobile apps.
- Multi-facility doctor calendars (PRD §8.2.6 / ARCHITECTURE §6.2.3).
- ML-based doctor/symptom matching.

---

## Changelog (append, don't rewrite history)

> New entries go in `changelog.d/`, one file per PR — see
> `changelog.d/README.md`. Maintainers fold them in here with
> `node scripts/fold-changelog.mjs`. Please don't append to this section
> directly.

- 2026-09-09 — Initial roadmap created alongside Phase 0 scaffolding.
- 2026-09-14 — Resolved the open risk in `docs/adr/0002-stellar-escrow-for-fulfillment-payout.md`: confirmed against the real Drips Wave docs that this repo and `docforum-web` are not ecosystem-relevant to a Stellar-only Wave and will not be submitted. Only `docforum-escrow` will apply, once it has enough real GitHub activity — see its Phase E1–E4 work.
- 2026-09-14 — Phase 1 built: Express 5 API, Prisma schema for the Phase 1
  models + migration, JWT auth (signup/login/refresh/logout, role
  middleware), admin-gated doctor verification, fixed-length slot
  generation, and the booking-concurrency guarantee — implemented and
  proven with a real, self-contained integration test (real Postgres, 8
  concurrent requests, exactly 1 succeeds). PRD §8.1.1 and ARCHITECTURE
  §6.1.1 marked resolved. Not done: Docker Compose file exists but wasn't
  exercised (no Docker in this environment) — see the note under Phase 1
  above and `infra/docker/README.md`.
- 2026-09-14 — Deployed `backend/` to Render (free tier, preview only —
  ADR 0003) so `docforum-web`'s GitHub Pages preview has a live API.
  Fixed the refresh-cookie `secure`/`sameSite` to be genuinely
  environment-aware (was a documented local-dev-only placeholder) and
  added `credentials: 'include'` in `docforum-web`'s api-client. Free
  Postgres expires 2026-10-14 — needs recreating/upgrading before then.
- 2026-09-14 — Added `docs/site/`: a VitePress documentation site for the
  whole org, deployed to GitHub Pages
  (https://docforum.github.io/docforum-core/) via
  `.github/workflows/deploy-docs.yml`. Content is synced at build time
  (`docs/site/scripts/sync-docs.mjs`) — this repo's PRD/architecture/
  essentials/roadmap/ADRs/API-reference copied locally, `docforum-web`'s
  and `docforum-escrow`'s README/architecture-essentials/roadmap (and
  escrow's ADR 0001) fetched from their `main` branch — nothing is a
  hand-maintained duplicate, so the site can't drift from what each repo
  actually says the way a copied-and-forgotten doc would. Relative links
  in the fetched READMEs are rewritten to absolute GitHub URLs (they were
  written relative to their own repo root, meaningless in this site's
  structure — `vitepress build`'s dead-link check catches this if it's
  ever skipped). Same pine/brass/Fraunces identity as `docforum-web`, for
  visual consistency across the org's public surfaces. **Known gap:**
  only rebuilds on a push to this repo — a docs change landing only in
  `docforum-web` or `docforum-escrow` doesn't trigger a rebuild here yet;
  noted in both `deploy-docs.yml` and `docs/site/README.md`, not silently
  accepted. (Now tracked as [issue #29](https://github.com/DocForum/docforum-core/issues/29).)
- 2026-09-14 — Removed all remaining "DripsWave" naming (the product's
  original codename before the org became `DocForum`): `PRD.md`/
  `ARCHITECTURE.md`/`ROADMAP.md` titles and PRD.md's opening line, plus
  ADR 0002's context paragraph. `docforum-web` and `docforum-escrow` were
  already clean (checked). Also removed two stale, unreferenced,
  never-committed leftovers from the top-level workspace (not this repo)
  that still carried the old name: a superseded draft `ROADMAP.md` and an
  early superseded ADR draft — moved aside rather than hard-deleted.
- 2026-09-14 — Added `.github/ISSUE_TEMPLATE/bug_report.md`, deployed
  identically across all three repos (same convention as the existing
  `good-first-issue.md`). Built from a user-supplied bug-report structure
  plus drips.network's "Creating Meaningful Issues" guide (fetched
  directly, not from memory) — complexity/points tagging, honest sizing,
  and "why it matters" context apply to bug reports the same way they do
  to task issues, not just repro mechanics.
- 2026-09-14 — Scoped Phase 2 into four real GitHub issues (#1–#4),
  following the same shape already used on `docforum-escrow`'s issues:
  why it matters, what to do, files likely involved, edge cases, DoD, how
  it'll be reviewed. #2 explicitly depends on #1 (intake before booking
  confirmation); #3 and #4 are independent of each other and of #1/#2.
  Complexity: #1/#2/#3 Medium (150 pts), #4 (`Consultation` record) High
  (200 pts) — it's the one that resolves the `resolved | referred |
  follow_up_needed` outcome model that Phase 3's referral creation will
  depend on. Phase 2 checklist above updated to link each item to its
  issue.
- 2026-09-14 — Scoped the rest of the roadmap that's actually actionable
  right now into 18 more real GitHub issues (#5–#22): Phase 3 Referrals
  (#5–#8, including a dedicated ADR issue for the unresolved
  target-doctor routing rule, ARCHITECTURE.md §6.1.2), Phase 4 Orders
  (#9–#12), Phase 5 Facilities & fulfillment (#13–#16, led by an ADR
  issue resolving the polymorphic `FulfillmentRecord` smell before the
  rest of the phase builds on it), Phase 6's notification-provider
  decision (#17 — the only part of Phase 6 not blocked by Phases 3/4),
  three of Phase 8's five hardening items that don't actually depend on
  unbuilt phases (#18 JWT revocation, #19 held-slot TTL, #20 v1 scope
  decision doc — `AuditEvent` and the privacy audit stay unscoped, they
  need Phase 3/4/5 models to audit), and Phase 9's CI pipeline + a
  dedicated production-deployment ADR (#21–#22, distinct from ADR 0003
  which only covers the current preview).

  Deliberately **not** scoped into issues: Phase 5.5 Payments (blocked on
  `docforum-escrow` publishing its SDK — issues #4/#5 there are still
  open; opening issues here now would hand a contributor work that
  can't start) and Phase 7 Frontend, which is marked **superseded** in
  place — it predates the 3-repo split and duplicates what's actually
  tracked in `docforum-web`'s own roadmap (Phases W2–W5); left as a
  historical record rather than deleted, but no issues will be opened
  against it here. Every dependency between these issues (e.g., #7/#8
  depend on #5; #10/#11/#12 depend on #9; #14/#15/#16 depend on #13) is
  stated explicitly in each issue body, same convention as #2's
  dependency on #1.
- 2026-09-14 — Closed issue #21 directly (a maintainer fix, not left for
  a Wave contributor): replaced the placeholder `ci.yml` with a real
  workflow — `prisma:generate` → `typecheck` → unit tests → integration
  tests → `build`, on push to `main` and on PRs. Companion fix applied
  identically in `docforum-web` and (separately, already done) in
  `docforum-escrow` — all three repos now have CI that actually runs
  their real test suites instead of an `echo "TODO"` stub. Done ahead of
  the Drips Wave application: a prospective contributor or organizer
  landing on any of these repos now sees actual passing checks, not a
  placeholder.
- 2026-09-15 — General workspace-audit fixes, applied identically to all
  three org repos:
  - This file's own top status line was stale (dated 2026-09-09, said
    "Phase 0 complete, Phase 1 not started" while the body below showed
    Phases 1-9 built/scoped) — corrected.
  - Added `CONTRIBUTING.md` — `AGENTS.md` is written for coding agents,
    not a quick human onboarding path; this covers clone/install/test,
    how to claim an issue, and the PR checklist.
  - Branch protection enabled on `main` for all three repos: the real CI
    check must pass and one approval is required before merge, force
    pushes and deletion are disabled. `enforce_admins` left `false` so
    the maintainer isn't blocked — this protects against a bad external
    PR landing unreviewed/uncheck-passing, not against the maintainer's
    own direct pushes.
  - Added GitHub topics to `docforum-core` and `docforum-web`
    (`docforum-escrow` already had them) for discoverability.
- 2026-09-15 — Built Phase 5.5 (Payments) for real, ahead of Phase 4/5,
  via docs/adr/0004-custodial-payments-v1.md: `docforum-core` holds its
  own Stellar payer + releaser identities (custodial v1) rather than
  patients signing with their own wallet — the only design consistent
  with `docforum-web`'s existing "no direct Stellar calls" hard rule.
  `PaymentIntent`/`WalletLink` filled in from the Phase 0 scaffold with
  real FKs to `PatientProfile`/`FacilityProfile` (both Phase 1, already
  real); `orderType`/`orderId` stay opaque rather than hard FKs to
  `Prescription`/`LabOrder`, which don't exist yet — this is what let
  the phase build independently instead of waiting on Phase 4/5.
  `@docforum/escrow-sdk` added as a real dependency (the GitHub Release
  tarball from `docforum-escrow`'s ADR 0003), wired through a dynamic
  `import()` (CJS backend, ESM-only SDK — same interop pattern as
  `embedded-postgres`). New `POST /payments/wallet-link`,
  `POST /payments/intents`, `POST /payments/intents/:id/{fund,release,
  refund}` endpoints — the latter three admin-only in v1, since there's
  no `FulfillmentRecord` yet to trigger them automatically (ADR 0004
  "Consequences" — explicitly not the final design).

  Verified against **live testnet**, not mocked:
  `npm run test:integration:payments-testnet` — 3/3 passing (full fund→
  release lifecycle, full fund→refund lifecycle, reject-when-no-wallet).
  Kept out of the default `test`/`test:integration`/CI, same reasoning
  as `docforum-escrow`'s own SDK test (depends on testnet + the platform
  payer's balance, not self-contained). Caught and fixed a real bug
  while wiring this up: vitest's CLI path filter matches by substring,
  so a `tests/integration-testnet/` directory got silently swept into
  `test:integration`'s `tests/integration` filter — renamed to
  `tests/testnet-integration/` to avoid the collision, confirmed via
  actually re-running both scripts and checking which files each picked
  up, not just reasoning about it.

  Real testnet identities generated for this: a platform payer + a
  platform releaser, both funded via Friendbot. Generated and written
  directly to `backend/.env` by `scripts/gen-platform-identities.mjs` —
  the secrets were never printed to any visible output, only the public
  keys were (this repo's sandbox correctly refused an attempt to reveal
  a stored `stellar` CLI identity's secret directly; the fix was
  generating fresh keys via the SDK's own `Keypair.random()` and writing
  them straight to a file instead of asking to view them).

  Also: bumped `@docforum/escrow-sdk` to v0.2.0 (a small but real
  addition made while building this — `createEscrow`/`release`/`refund`
  now return the transaction hash instead of discarding it, since this
  module needs to persist `stellarTxHash`). See `docforum-escrow`'s own
  changelog for that side of it.
- 2026-09-15 — Updated the hand-authored overview pages in
  `docs/site/repos/` (`core.md`, `escrow/overview.md`, `web/overview.md`)
  — these are the one part of the docs site NOT synced automatically at
  build time, and had gone stale describing Phase E1-only /
  Phase-W1-only states that no longer matched reality. Added
  `sync-docs.mjs` entries for the new ADRs (this repo's 0004,
  `docforum-escrow`'s 0002/0003) and matching sidebar nav entries.

  Caught and fixed a real bug while verifying this, not just trusting
  the workflow ran: `docforum-escrow`'s ADR 0003 contained angle-bracket
  placeholder text that VitePress's Vue-based markdown compiler
  misreads as an unclosed HTML tag, failing this site's build entirely.
  Confirmed by actually building the site locally against the exact
  content, not by inspecting text and guessing. Two rounds were needed
  — the first fix addressed one instance, a second (different) instance
  in the same file was still breaking the build; both are now fixed at
  the source in `docforum-escrow`.
- 2026-09-26 — Refreshed this file's stale top status line (still said
  Phase 5.5 was unscoped/blocked on the escrow SDK, though it shipped
  2026-09-15). Opened [issue #23](https://github.com/DocForum/docforum-core/issues/23)
  (doctor discovery): a repo-wide check found no code path creating,
  assigning, or reading `Specialty`/`DoctorSpecialty`, and no doctor
  list endpoint, which `docforum-web` issue #1 assumes. Also noted, not
  yet fixed: `npm audit --omit=dev` reports 3 high-severity findings via
  `prisma` → `@prisma/config` → `deepmerge-ts <8`; the suggested
  `npm audit fix --force` downgrades Prisma (breaking), so not applied.
- 2026-10-07 — Fixed Phase 2's stale status line (said "blocked by
  Phase 1", though Phase 1 has been done since 2026-09-14) — contributors
  browsing #1–#4/#23 via the docs site were told they were blocked. Added
  a "Renewing the free database" runbook to ADR 0003: the Render preview
  Postgres expires 2026-10-14 and the steps to recreate it lived nowhere.
- 2026-10-07 — Renewed the Render preview Postgres per ADR 0003's
  runbook (old instance deleted, new free instance created, migrations
  applied on deploy, admin account recreated). New expiry: 2026-11-06.
- 2026-10-07 — Opened issues #24–#29: idempotent escrow funding +
  reconcile (#24) and releaser key custody ADR (#25), both from
  `docforum-escrow`'s threat model §5/T1–T2; wallet key checksum
  validation (#26); Docker Compose verification (#27); ESLint in CI
  (#28); cross-repo docs-site rebuild (#29).
- 2026-10-08 — Proposed ADR 0005 (non-custodial patient payments v2):
  `docforum-core` builds and submits transactions, the browser only asks
  the patient's wallet to sign, which removes ADR 0004's objection while
  keeping all Stellar network calls in this repo. Patient becomes the
  escrow `payer`, with `refund_after` as their protection; SEP-10 wallet
  linking for patients and facilities; USDC; platform fee-bump
  sponsorship. Custodial v1 stays as a fallback. Status: Proposed, not
  yet Accepted. Added to the docs site.
- 2026-10-09 — Opened issue #32: upgrade to escrow SDK 0.3.0 and the
  current testnet contract.- 2026-10-16 — Implemented issue #77 (SEP-10 Stellar Web Authentication server, Phase 5.5 / ADR 0005 step 4): `GET
  /payments/sep10/challenge` builds a server-signed challenge (SDK
  helper — Manage Data nonce, 5-minute time bounds, home domain +
  web_auth_domain) and records the issuance binding; `POST
  /payments/sep10/verify` walks the full SEP-10 server verification
  list (structure, time bounds, server signature, client signatures
  with multisig weight thresholds loaded from Horizon, and the
  spec's master-key rule for unfunded accounts), then consumes the
  nonce with ONE conditional UPDATE so concurrent replays can't both
  succeed — same DB-level pattern as booking. New `Sep10Challenge`
  model (unique nonce, userId, account, expiry) with a migration; a
  dedicated `SEP10_SIGNING_SECRET` (never the payer/releaser keys,
  validated at startup, never logged). Horizon is behind an injectable
  seam so the 15 unit + 18 integration tests run with zero network.
  Docs updated: ARCHITECTURE §4.10, essentials data-model map,
  docs/api/README.md (endpoints + errors + unfunded behaviour).
- 2026-10-16 — Implemented issue #78 (verified wallet links, stacked on
  #77's branch): `WalletLink` generalized from facility-only/typed-in to
  an owner (patient | facility) with `verificationMethod` /
  `verifiedAt` / `replacedAt`, one active link per owner enforced by a
  DB unique sentinel (Prisma can't express a partial index — noted in
  the schema), and the migration backfills existing facility rows as
  `unverified_legacy` (proven by a real migration test that inserts an
  old-shape row first). `POST /payments/wallet-link` now takes only a
  signed SEP-10 challenge (strict body — a raw address is a 400) and
  creates the link inside the same transaction that consumes the nonce;
  the only `sep10`-row writer is that flow. Patient link responses
  carry ADR 0005's on-chain privacy notice verbatim (unit-tested
  against the ADR file). Funding refuses unverified legacy links after
  `WALLET_LINK_UNVERIFIED_FUNDING_CUTOFF` (default 2027-01-01,
  startup-validated, `409 WALLET_LINK_UNVERIFIED`) and snapshots
  `PaymentIntent.fundedWalletAddress` so re-linking can't rewrite an
  escrow's payee. 8 unit + 12 integration tests (fake Horizon + fake
  escrow SDK — no network). ADR 0005 unchanged (no factual conflict).
- 2026-10-15 — Started Phase 8's auth-hardening work, scoped as issues #34 (email verification), #35 (login brute-force throttling), #37 (CSRF
  for the cookie-authenticated endpoints + per-environment CORS allowlist) and #39 (admin account lifecycle). All four are independent of Phases
  3–7 and of each other. #34 merged as PR #137: `User.emailVerifiedAt` +
  a hashed/expiring/single-use `EmailVerificationToken` table (backfilled
  as verified for existing rows), `POST /auth/verify-email`,
  `POST /auth/verify-email/resend` (account-scoped, rate-limited), and a
  `requireVerifiedEmail` guard on booking + payment mutations — never on
  login/browsing. Also added
  `backend/scripts/mark-email-verified.mjs` as the documented interim for
  operating a deployment before an email provider exists (issue #17), and
  flagged that dependency in ARCHITECTURE.md §6.1.5.

  #35 merged as PR #138: a Postgres `LoginAttempt`
  table with per-email and per-IP buckets, moved by a single conditional
  upsert (`INSERT ... ON CONFLICT DO UPDATE`) so concurrent bad logins are
  counted atomically, exponential backoff with a `Retry-After` header, a
  bounded temporary lock that hammering can't extend, an admin
  `/auth/login-attempts/clear` escape hatch, a prune interval, and a
  `TRUST_PROXY` setting so throttling keys on the real client IP. Also
  closed a related timing leak: an unknown email now pays the same bcrypt
  comparison cost as a known one.

  #37 has landed as a PR: the refresh cookie is
  `SameSite=None` cross-site, so `/auth/refresh` and `/auth/logout` now
  require an `X-CSRF-Token` header whose value is a per-session claim
  inside the refresh JWT (rotating with it), an `Origin` allowlist check,
  and a per-environment CORS allowlist (`CORS_ORIGINS`). The classic
  double-submit cookie was rejected for a concrete reason — a cookie set
  by this API is third-party to `docforum.github.io`, so the web client
  could never read it; the token travels in the response body. Integration
  tests assert a
  forged cross-origin request is rejected while the legitimate cross-site
  client still succeeds.
- 2026-10-17 — Issue #40 (patient data export, right of access) opened as a
  PR: export job + status + streamed download routes under
  `/patients/me/export`, owner-only (doctors/admins `403`, someone else's id
  `404`). An exporter registry (`src/export-sections.ts`) where each module
  contributes its own section through its service — documented in
  ARCHITECTURE.md §3.1 so new modules know to register. Bundles are written
  page by page into bounded Postgres chunks (no object-storage provider yet
  — recorded as ARCHITECTURE.md §6.3.4), expire after 24 h by default, and
  are deleted by an interval cleanup job. Job state moves only through
  conditional UPDATEs with an attempt fencing token, so concurrent workers
  and crashed claims can't publish a partial bundle.
- 2026-10-17 — Issue #43 (AuditEvent foundation) opened as a PR: the
  `AuditEvent` table (append-only, enforced by DB triggers; no FKs on
  purpose), an `audit` module whose `record()` refuses to run outside a
  transaction, an `X-Request-Id` middleware, and `GET /admin/audit-events`
  with a keyset cursor. Wired into booking (inside `bookSlot`'s existing
  transaction, after the slot claim — the concurrency guarantee is
  unchanged), doctor verification (previous status read `FOR UPDATE`) and
  payment fund/release/refund (status writes now conditional on the
  observed state, so a racing second action gets 409 instead of silently
  overwriting). Rollback coupling proven with a real injected DB failure,
  not a mock. Phase 4 wiring explicitly left pending.
- 2026-10-20 — Added the PR conflict notifier workflow (see the CI item above): maintainers no longer need to manually ask authors to rebase after each merge.
- 2026-10-20 — Rebased the Phase 3 referral branch onto the current `main`
  and resolved the merge by hand. The earlier merge commit had resolved
  conflicts by taking `main`'s model definitions wholesale, which dropped
  the branch's own work (the appointment lifecycle the referral cascade
  depends on, the `Referral` relation fields, and the `Consultation`↔
  appointment link) and left two `AuditEvent` models in one schema — the
  `prisma generate` failure CI reported (P1012). The branch is now
  `main` + two commits (Phase 3 referral core, ADR 0017) with the union of
  both sides' work, and the referral audit events go into `main`'s single
  `AuditEvent` table instead of a second one.
- 2026-10-17 — Built the Phase 3 referral core on branch
  `feat/referral-phase3-cascade-multi-loop-admin`: issues #5, #7 and
  #65–#68 (plus the minimal #3/#4 slices they depend on — appointment
  status transitions and a one-per-appointment `Consultation` record).
  Schema: `Referral` filled in from its sketch, `Consultation` linked to
  its appointment, `Appointment.availabilitySlotId` made nullable so a
  cancellation can release a slot. The referral↔appointments cycle is
  service-to-service in both directions (accept books through
  `bookForReferral` → `claimOpenSlot`; status transitions call back into
  `applyAppointmentOutcome` inside the same transaction) — never a
  repository import across the boundary. 42 unit tests + 55 integration
  tests pass, including 8 genuinely concurrent accepts on one referral
  (exactly one wins — the same proof shape as the booking test), batch
  rollback, loop chains, cascade idempotency and admin-role gating.

  **One deliberate re-scope to review, not silently absorbed:** (1)
  `target_doctor_id` is required, so the routing gap (ARCHITECTURE.md
  §6.1.2 / issue #6) is closed for v1 by making unassigned referrals
  impossible — and with it, PRD §8.2.2's distinct "waiting for a
  specialist" state is unreachable rather than implemented. The ADR is
  still owed. (2) `Referral.snapshotIntakeId` has no column, because
  `IntakeForm` (issue #1) doesn't exist yet — the notes half of the
  snapshot rule is real and enforced, the intake half is structurally
  impossible to enforce and is noted as such rather than faked.
  Issue #8 (time-based expiry) remains open: only the no-show cascade
  reaches `expired`. The multi-referral decision (#66's ADR requirement)
  is recorded as `docs/adr/0017-multiple-referrals-per-consultation.md`,
  and the referral status machine is drawn out in ARCHITECTURE.md §4.4
  (#67's state-diagram DoD). Docs reconciled in the same change:
  ARCHITECTURE.md §4.2–§4.4/§4.10/§5.2/§6.1.2/§6.2.2/§6.2.4,
  ARCHITECTURE_ESSENTIALS.md data-model map + known gaps, PRD
  §8.1.2–§8.1.4 and §8.2.1–§8.2.4, `docs/api/README.md` (which also still
  listed `payments` as unimplemented — corrected), and this file's
  Phase 2/3 status.

  **Audit trail (re-scoped 2026-10-20):** the referral admin actions are
  recorded in the *existing* `AuditEvent` table (issue #43) as
  `entity_type = 'Referral'` rows written through `auditService.record()`
  in the same transaction as the referral change — not in a second,
  referral-specific table. One audit trail, one set of append-only
  triggers, one writer; `GET /referrals/admin/:id/audit-events` reads the
  same rows the admin-wide `GET /admin/audit-events` serves.

- 2026-10-20 — Closed an audit gap the Phase 3 referral work had
  introduced: the referral **accept** path created an `Appointment`
  through `bookForReferral` without writing an audit row, so it was the
  one way to create an appointment that left no trail — and the existing
  `appointment.booked` event's `origin` metadata (always `direct` until
  then) was clearly built to tell the two booking paths apart. Fixed by
  having the appointments module write `appointment.booked` for the
  referral-origin booking too (`origin: 'referral'`, plus the referral id
  it came from), and by recording the patient's own state change on the
  referral as `referral.accepted` / `referral.declined` — both inside the
  accept's transaction, so the decision and the appointment it produced
  are recorded together or not at all. `declineReferral` now runs in a
  transaction (it previously used the root client, which the audit helper
  refuses by design).

  Two referral transitions are still **not** audited, and are recorded as
  an open gap in ARCHITECTURE.md §4.10 rather than silently dropped: the
  referral's *creation* (`null → pending`) and the two the appointment
  cascade drives (`accepted → completed`, `accepted → expired`), because
  the cascade fires from inside the appointment's status transition, which
  has no actor of its own to attribute. Both are owed when Phase 4/6
  wire the remaining state changes. Tests: two new integration cases
  asserting the audit rows (the accept's two events, the decline's one)
  against the real `AuditEvent` table.
- 2026-10-20 — Docs site: `docs/site/scripts/sync-docs.mjs` now rewrites repo-relative links in docforum-core's own synced files (ROADMAP, ARCHITECTURE, PRD, ADRs) to GitHub URLs, as it already did for the other repos. #153 added a relative link to `docs/adr/0017-multiple-referrals-per-consultation.md` in ROADMAP.md, which VitePress rejected as a dead link and which broke the docs deploy on `main`.
- 2026-10-21 — Phase 2: in-person check-in and live queue position. `POST /appointments/:id/check-in` records `checkedInAt` within a window around the appointment start (patient, own appointment only); the doctor's start/complete transitions now stamp `startedAt`/`completedAt`; `GET /appointments/:id/queue` returns the patient's own position and an estimated wait derived from the doctor's running-average delay (explainable, not ML). Patients never see other patients' details through the queue endpoint. Queue changes are pollable — the notification stream is Phase 6 and doesn't exist yet, so no push path was added. Schema: `Appointment.checkedInAt`/`startedAt`/`completedAt` (ARCHITECTURE.md §4.2), endpoints in `docs/api/README.md`. Unit tests cover position and estimate calculations; integration tests cover check-in window enforcement and queue access control.
- 2026-10-21 — Fixed a syntax error in `backend/src/modules/appointments/routes/index.ts` (TS1109/TS1161: an unterminated regular expression literal at line 29) that failed the local syntax check before push. No roadmap-tracked behavior changed; the check-in/queue work described above is unaffected.
- 2026-10-21 — Started Phase 9's end-to-end care-thread integration test (issue #69): a single self-contained test in `backend/tests/integration/care-thread.test.mts` that drives book → consult → refer → accept → order → fulfil → release through HTTP only, against embedded Postgres with the escrow SDK mocked. Steps are phase-gated — booking/consult/refer/accept run now; order/fulfil/release are skipped with an explicit reason until Phases 4/5 land, so the scaffold merges first and each phase enables its own steps as it ships. Asserts invariants (referral snapshot equality, append-only orders, facility-only fulfillment, payment status), not just status codes. Runs as part of `test:integration` in CI, runtime under a minute.
- 2026-10-21 — Phase 9 structured logging landed: `pino` logger with a request-scoped child logger (`X-Request-Id` accepted or generated, echoed on the response), a redaction config for auth headers, cookies, passwords, tokens and PHI field paths (with unit tests asserting each is redacted), a `BigInt`-safe serialiser, and the error handler routed through the request-scoped logger (stacks server-side, safe envelope to the client). Log level is per-environment (`LOG_LEVEL`), quiet by default under test. The remaining `console.*` call sites and the `no-console` lint gate are follow-up scope, recorded in the Phase 9 item above. Phase 9 status updated to In progress; production deploy (issue #22) remains open.
- 2026-10-21 — Fixed the structured-logging change's syntax errors that failed local checks before push: a malformed string literal in `backend/tests/unit/logging-redaction.test.ts` and an invalid character in `backend/src/config/index.ts`. No behaviour change; the logging/redaction implementation described above is unchanged.
- 2026-10-21 — Fixed PR #189's CI failures: the missing `backend/src/logger.ts` (the module `request-id.ts`, `error-handler.ts` and the redaction tests import — implemented as the pino logger, redaction list, BigInt serialiser and request-child factory they expect), the `pino-logger` import typo (`from 'pino'`), a corrupted `package.json` (nonexistent `pg@^2.23.1` breaking `npm ci`, a `DATABASE_URL_TEST==` double equals, the `prisla:mygrate` script name, an `ARCHITECTURE0.md` typo, and a `lint:no-console` script pointing at a file that doesn't exist), `app.get('health')` → `'/health'` (the missing slash 404'd the deploy health check), a mangled error-envelope comment in `error-handler.ts`, and the Phase 9 roadmap entry above (wrong logger path; overbroad "console.* replaced / ESLint rule / CI grep" claims). `pino-http` was dropped from the new dependencies: nothing imports it. Lockfile updated for `pino`.
- 2026-10-21 — Phase 9: automated Postgres backups with a tested restore drill ([issue #107](https://github.com/DocForum/docforum-core/issues/107)): `scripts/backup-postgres.sh` (gpg-encrypted `pg_dump`, retention), `scripts/restore-drill.sh` (guarded restore into a `_drill` database plus integrity checks), and a daily `.github/workflows/backup-restore-drill.yml`. ADR 0007. No schema or endpoint changes, so `ARCHITECTURE.md` §4 and `docs/api/README.md` are untouched.
- 2026-10-20 — Fixed the backup drill shipped above, which had never run. `backup-restore-drill.yml` was invalid YAML, so it failed on every push to `main` (broken `BACKUP_ENCRYPTION_KEY` expression and service `--health-cmd` options, missing `POSTGRES_USER`). Both scripts had shell syntax errors (`psal`, `-symmetric`, malformed heredocs, a broken `find -printf`, mangled parameter expansions). Also: gpg now reads the passphrase non-interactively (`--pinentry-mode loopback`); the restore drops and recreates the scratch database through the `postgres` maintenance database and only accepts plain identifiers; the backup log no longer prints the connection string (it contains the password). Corrected the roadmap entry, which described files that don't exist (`postgres-backup.yml`, `restore-drill.mjs`, `age`, `docs/backups.md`). Separately, `tests/integration/sessions.test.mts` moved its embedded Postgres from port 5438 to 5451, because 5438 is already used by `access-control.test.mts` and vitest runs integration files in parallel.
- 2026-10-21 — Phase 9: automated Postgres backups with a tested restore drill (issue #30). Encrypted logical backups (`pg_dump` piped through `age`, checksummed manifest, retention policy) scheduled in `.github/workflows/postgres-backup.yml`; a restore script (`scripts/restore-drill.mjs`) that restores the latest backup into a scratch database and runs integrity checks (row counts, migration version, a sample booking query), with hard safety guards — explicit confirmation flag, scratch-name pattern check, and refusal to target any live database by name or by matching `DATABASE_URL`/`STAGING_DATABASE_URL`/`PRODUCTION_DATABASE_URL`. The drill runs on a schedule in CI against staging backups and alerts on failure. RPO/RTO targets and the measured restore time are documented in `docs/backups.md`. Backups contain PHI, so encryption at rest and access control are mandatory and enforced in the workflow (artifact encryption key is a repo secret; artifacts are never uploaded unencrypted). No schema or endpoint changes, so `ARCHITECTURE.md` §4 and `docs/api/README.md` are untouched.
- 2026-10-20 — Hardened the PR automation against transient GitHub API errors. Today a single 500/503 response aborted a whole conflict-notifier run, so no PR after it got labelled. Both `pr-conflict-notifier.yml` and `pr-malware-scan.yml` now set `retries: 3` on `actions/github-script`, so 5xx responses are retried. The notifier also isolates each PR: a PR whose API calls still fail is skipped with a warning, listed as "API error, retried next run" in the run summary, and the remaining PRs are processed normally.
- 2026-10-19 — Issues #93/#94: added the owner-scoped notification inbox and
  typed provider-agnostic dispatch interface, then the transactional outbox
  with `appointment.booked` as its first producer. Booking, audit and outbox
  rows commit or roll back together; dispatch is at least once using
  `FOR UPDATE SKIP LOCKED`, idempotent notifications keyed by source event,
  bounded exponential retries, and sanitized admin-visible dead letters.
- 2026-10-21 — Added Phase 9 load tests (k6): doctor search, slot listing, and a booking-contention scenario (many VUs against a small slot pool). A seeding script creates realistic volumes (thousands of doctors and slots); a manual/nightly workflow runs them against a seeded local stack with enforced thresholds (p95 latency, zero double-bookings, error budget) and never against the shared Render preview. The contention scenario verifies exactly one booking per slot from the database after the run. First results and any motivated index/query fixes recorded in `backend/tests/load/REPORT.md`.
- 2026-10-22 — Fixed syntax errors in the Phase 9 k6 load scripts (`backend/tests/load/search.js`, `slots.js`, `booking-contention.js`) that failed the local syntax check before push (unterminated string literal, missing commas, stray identifier). No behaviour change to the scenarios or thresholds; the load-tests workflow and `REPORT.md` are unchanged.
- 2026-10-19 — Implemented issue #90's patient payment-history and facility
  ledger APIs. Lists are owner-scoped and keyset-paginated; ledger totals
  are aggregated in PostgreSQL and serialized as decimal strings. The
  existing custodial v1 model has no `refund_after` field, so the API
  returns `refundAfter: null` rather than implying a deadline exists.
- 2026-10-19 — Implemented issue #91's scheduled and manually dispatched
  testnet payment workflow. Every run generates new test identities,
  retries Friendbot with bounded jitter, reports infrastructure/contract
  reset failures separately from assertion failures, and updates one open
  tracking issue instead of posting repeated reports.
- 2026-10-19 — Implemented issue #92's pooled payout prototype. The call path
  applies a testnet-only pool address override while keeping direct facility
  payouts as the default in production and local environments, with the
  configuration controlled by `PAYOUT_PRIVACY_MODE` and
  `PAYOUT_PRIVACY_POOL_ADDRESS`.
- 2026-10-22 — Closed issue #19 (held-slot TTL/release job) as **not applicable as currently designed**, per the issue's own allowance for that outcome. Investigation: Phase 1's `claimOpenSlot` claims a slot directly with a conditional `UPDATE` inside the booking transaction and has no intermediate `held` status, so there is no abandoned-hold risk to bound — confirmed against `backend/tests/integration/booking.test.mts` (8 concurrent attempts, exactly 1 succeeds) and the absence of any `held`/`holdExpiresAt` field in `schema.prisma`. No hold state was introduced just to have something to release. Documented in the Phase 8 checklist; revisit if a multi-step booking flow (e.g. reserving a slot during Phase 2 intake) introduces a hold.
- 2026-10-22 — Fixed the syntax error in `backend/src/modules/availability/repositories/index.ts` (TS1110, "Type expected" at line 31) that failed the local syntax check before push. The malformed type annotation in the repository's export was corrected in place; no other identifiers, exports, or formatting in that file were touched, and the held-slot investigation above is unchanged.
- 2026-10-20 — Contributing: changelog entries now go in `changelog.d/` (one new file per
  PR) instead of being appended to this section, which used to put most open
  PRs into merge conflict on every merge. Maintainers fold them in with
  `node scripts/fold-changelog.mjs`. Also dropped the "Last updated" line,
  made the `docs/api/README.md` intro phase-agnostic, and documented the
  "edit only your own lines" rule in `AGENTS.md`, `CLAUDE.md` and
  `CONTRIBUTING.md`. The conflict notifier now points authors at
  `changelog.d/`.
- 2026-10-20 — Bumped `follow-redirects` 1.16.0 → 1.16.1 in `backend/package-lock.json`
  (lockfile only; it comes in through `axios`, which allows `^1.15.x`). This
  fixes GHSA-8r9p-f939-6h3c (high: credential headers can leak on redirect),
  published 2026-10-20, which made the `audit:prod` CI gate fail on every PR.
  No code changes.
- 2026-10-21 — Phase 9: exercise slot-generation invariants and appointment/payment state
  transitions with fixed-seed property tests, plus a larger nightly run
  ([issue #120](https://github.com/DocForum/docforum-core/issues/120)).
- 2026-10-21 — Phase 2: add the specialty catalog and doctor-owned specialty assignment,
  plus a verified-only paginated doctor directory with trigram matching for
  names and specialties ([issues #23](https://github.com/DocForum/docforum-core/issues/23)
  and [#128](https://github.com/DocForum/docforum-core/issues/128)).
- 2026-10-21 — Phase 9: added user locale preference, request and recipient locale resolution, ICU-formatted coded errors and password-reset notifications, English/French message catalogs, and a CI key-parity check ([issue #133](https://github.com/DocForum/docforum-core/issues/133)). Existing uncatalogued server messages still use their English fallback.
- 2026-10-21 — Phase 2 (issue #4): an appointment's consultation can be closed exactly
  once. `Consultation` is one-to-one with its `Appointment`
  (`Consultation.appointmentId` UNIQUE, `docs/adr/0009`), so "closed once" is
  a database constraint (`P2002` → `409`) rather than an app-level
  read-then-write check. All three writers — `POST /consultations`,
  `POST /appointments/:appointmentId/consultation`, and the orders flow's
  consultation step — now go through one service
  (`consultationsService.createConsultation`), so note encryption
  (AES-256-GCM, issue #46), the own-`completed`-appointment rule and the
  single `consultation.closed` audit event apply to every address.
  `outcome` stays nullable in the schema (a record can exist before
  sign-off); the close route requires it at the boundary. Integration test:
  `backend/tests/integration/consultation.test.mts`.
- 2026-10-21 — Phase 2: added a doctor-scoped `GET /appointments/doctor/today` view over scheduled appointments for the current server-local day ([issue #3](https://github.com/DocForum/docforum-core/issues/3)). Existing lifecycle transitions and referral cascades remain unchanged.
- 2026-10-21 — Phase 8: account deletion with clinical-record retention
  ([issue #41](https://github.com/DocForum/docforum-core/issues/41)), with ADR
  0010's per-model retention table. `DELETE /patients/me` anonymises in place
  rather than cascading: `User.deletedAt` + `PatientProfile.anonymizedAt`,
  tombstoned email (frees the address for a new signup), unusable password,
  cleared verification; appointments and payment intents are untouched and keep
  their FK. The migration flips `PatientProfile.userId` from CASCADE to
  RESTRICT (the only FK changed — inventory in the ADR). An interval purge
  removes only tombstones no module holds records for. Found while testing:
  Postgres reports RESTRICT as SQLSTATE 23001, which Prisma surfaces as an
  unknown error rather than P2003 — recorded in ARCHITECTURE.md §6.1.6. The
  legal retention period for clinical records is explicitly left open (an open
  decision in the ADR), not invented.
  Rebased onto `main` after #40 (patient export), #45 (access log) and the
  Phase 3/4 referral and order models landed: the purge now also holds back for
  prescriptions, lab orders, referrals and access-log rows (each through its
  own module's service), and a patient's exports are deleted inside the
  anonymisation transaction, as the ADR's wiring note required of whichever of
  #40/#41 merged second. ADR renumbered 0007 → 0010 (0007 is now the backups
  ADR).
- 2026-10-21 — Issue #42 (guardian and dependent accounts) opened as a PR
  with ADR 0011: dependents are guardian-owned patient profiles
  (`PatientProfile.userId` now nullable, a CHECK requires a DOB when it's
  null) linked by a new `Guardianship` table (real FKs, unique per pair,
  `revokedAt`, never deleted). The bare `guardianUserId` string is dropped;
  the migration aborts if any row still holds a value instead of silently
  discarding it (tested both ways). `POST`/`GET /patients/me/dependents` are
  create-only; `POST /appointments` takes `patientProfileId`, authorised by
  `patientsService.resolveActingProfile` before the booking transaction,
  which is otherwise byte-for-byte unchanged — re-proven with a concurrent
  race that includes a guardian booking. Guardian access ends at the age of
  majority (default 18). PRD §8.2.5 marked resolved/re-scoped.
  Reconciled with #41 (account deletion), which merged first:
  `PatientProfile.userId` is nullable but keeps #41's `ON DELETE RESTRICT`;
  deleting a guardian's account revokes their guardianships in the same
  transaction (dependents and their records untouched), a deleted account
  acts for no one through `resolveActingProfile`, and the account purge holds
  a guardian's tombstone while guardianship rows name it (hold
  `guardianships`). ADR 0010's retention table and ADR 0011 updated.
- 2026-10-21 — Phase 3: specialty-only referral routing decided and implemented
  ([issue #6](https://github.com/DocForum/docforum-core/issues/6)).
  [`docs/adr/0008-referral-routing-without-target-doctor.md`](docs/adr/0008-referral-routing-without-target-doctor.md)
  closes the ARCHITECTURE.md §6.1.2 gap: a referral may name a doctor *or* a
  specialty, and a specialty-only target is resolved **at creation** to the
  least-loaded eligible doctor (verified, holds the specialty, not the
  referring doctor, active account; fewest `pending`+`accepted` referrals,
  ties by doctor id). `Referral.targetDoctorId` stays NOT NULL, so nothing
  is ever created unassigned; zero eligible doctors is a `422
  REFERRAL_NO_ELIGIBLE_TARGET` and writes no row. No schema or migration
  change — the new surface is the optional `targetDoctorId` in the existing
  referral create/batch bodies and the `targetDoctorId` the response now
  carries for a routed referral.
  Not built, deliberately: PRD §8.2.2's patient-facing "waiting for a
  specialist" state — it requires a target-less referral, which the ADR
  rejects. Issue #8's time-based expiry is still the answer for a routed
  referral whose doctor never offers a slot.
  Note for the next contributor: this change also restores the referrals
  table in `docs/api/README.md`, which an earlier commit had truncated
  mid-row (along with the payments/orders/audit sections after it — still
  missing, and not restored here).
- 2026-10-21 — Phase 5.5: multi-asset payment intents and the patient-signed prepare half
  of ADR 0005 ([issue #79](https://github.com/DocForum/docforum-core/issues/79),
  [issue #80](https://github.com/DocForum/docforum-core/issues/80)).
  `PaymentIntent.amountStroops` is renamed to the token-agnostic `amount`
  (a column rename in the migration, so existing values are preserved), and
  each intent now records an allowlisted `assetCode` + `tokenContractId`
  (native XLM + USDC on testnet, configured per environment via
  `PAYMENT_ASSETS`). Funding and prepare check the payee's trustline before
  any SDK call, and facility totals are grouped per asset rather than summed
  across them. `POST /payments/intents/:id/prepare` builds and simulates the
  patient-as-payer `create_escrow`, stores the unsigned XDR/hash and moves the
  intent `created -> awaiting_signature`; an interval job expires stale
  prepared transactions back to `created`. The real SDK call still returns
  `503 ESCROW_SDK_PREPARE_UNSUPPORTED` until `@docforum/escrow-sdk` 0.3.0
  ([issue #32](https://github.com/DocForum/docforum-core/issues/32)) ships;
  submit/fee-bump is not part of #80.
- 2026-10-21 — Malware scan: `.vue`, `.svelte`, `.astro`, `.less`, `.sass`, `.go`,
  `go.mod` and `go.sum` files are now scanned as code. Before this, a Vue
  single-file component was flagged HIGH as "disguised code" (JavaScript
  inside a file with a non-code extension), which wrongly blocked
  docforum-core #207. The same line rules still apply to these files.
- 2026-10-21 — Malware scan: closed three gaps found in the malicious docforum-web #137,
  which only had three of its nine problems flagged. Code pushed off-screen by
  leading whitespace is now flagged (`api.js` hid its payload behind 315 tabs).
  A `package.json` script such as `dev` or `build` that now also runs
  `node <file>` (or bun, deno, sh, bash, python) alongside its original command
  is flagged as `script-hijack`. The `global['!'] = …` marker of the loader used
  in escrow #163 and web #137 is flagged as `known-payload`. The whole-line
  heuristics no longer stop the per-line rules from running on the same file.
- 2026-10-21 — Malware scan: TLA+ specifications (`.tla`) are now scanned as text, like
  other source files. Before this, a TLA+ spec was flagged HIGH as "disguised
  code", which wrongly blocked docforum-escrow #225. Every line rule still
  applies to `.tla` files.
- 2026-10-22 — Phase 5 prerequisite: resolved the polymorphic `FulfillmentRecord` design smell
  flagged in ARCHITECTURE.md §6.1.3 and §6.3.1
  ([issue #13](https://github.com/DocForum/docforum-core/issues/13)) with
  `docs/adr/0012-fulfillment-record-typed-order-fks.md`. Decision: keep **one**
  table, drop the polymorphism — the Phase 0 `(order_type, order_id)` TEXT pair is
  replaced by real `prescription_id` / `lab_order_id` FKs (each `UNIQUE`, a
  PostgreSQL `CHECK` requires exactly one, the same mechanism `PaymentIntent` got
  in issue #85) and `facilityId` becomes a real FK to `FacilityProfile`. All three
  are `RESTRICT`, so deleting an order or a facility account cannot erase the
  fulfillment trail (ADR 0010). Splitting into `PrescriptionFulfillment` /
  `LabOrderFulfillment` was weighed and rejected: it would give ARCHITECTURE.md
  §5.3 step 5 two implementations to keep in sync and a facility's assigned-orders
  queue a cross-table union.
  No endpoints, services or module code changes: the placeholder had no readers,
  so this ships as schema + migration + docs. #14 creates the row, #15 owns the
  `→ fulfilled` transition (the only path per hard rule 5), #16 attaches
  `LabResult` through its existing table. Two things the ADR decides rather than
  invents: one fulfillment row per order, ever — re-routing after a `rejected`
  fulfillment needs a partial unique index and stays deferred; and `facilityId` is
  denormalised from the order at creation, the equality invariant owned by #14's
  service, not a DB trigger.
- 2026-10-22 — Phase 5: admin-only facility account creation + `FacilityCapability` matching
  ([issue #14](https://github.com/DocForum/docforum-core/issues/14)).
  `POST /facilities` (admin-gated at the route, mirroring Phase 1's admin-gated
  doctor verification) creates the `facility`-role `User`, its `FacilityProfile`
  and its `FacilityCapability` rows in one transaction, plus a
  `facility.created` `AuditEvent` (ids and counts only — never the email or the
  credential). There is still no self-serve facility signup: `POST /auth/signup`
  refuses the role, so this endpoint is the only creation path (PRD OQ-2 — a
  curated partner list is what protects FR-13 / §8.1.6). Deliberate defaults,
  flagged rather than hidden: the admin sets the initial password out of band
  (same posture as the bootstrap admin CLI) and `emailVerifiedAt` is set at
  creation because the email provider (#17) can't deliver a link, and an
  unverified curated partner would otherwise never be able to publish prices
  (`requireVerifiedEmail` gates `POST /facilities/me/prices`). Capabilities must
  match the facility type (`lab` ↔ `lab_test`, `pharmacy` ↔
  `medication_dispense`) and at least one is required, so an account created
  through this path can never be un-qualifiable data. Capability management
  after creation (edit/retire a capability) has no endpoint yet — that surface
  is still pending.
  Matching (PRD FR-13): `GET /facilities/eligible` now returns only facilities
  of the requested type that *hold* the matching `FacilityCapability` row, and
  the services export `listEligibleFacilitiesForOrderKind('lab_order' |
  'prescription')` for callers that start from an order instead of a facility
  type. **Fail closed** — a facility with no capability rows, or only rows of
  the wrong capability type, shows for nothing; under-showing is an operator
  fix, over-showing is the fraud/safety concern §8.1.6 names. Consequence for
  existing data: Phase-1 facilities seeded without capabilities disappear from
  `/eligible` until an admin creates/repairs their qualification data — the
  integration tests that predate #14 needed capability rows added to their
  fixtures for exactly this reason.
  Not in this issue, stated plainly because ADR 0012 assigns it to #14: the
  `FulfillmentRecord` row *at facility selection* is not created here — no
  selection endpoint exists yet (orders name their facility at issuance,
  `Prescription.facilityProfileId` / `LabOrder.facilityProfileId`), and issuance
  currently does not capability-check it. That wiring, and the
  `→ fulfilled` transition, land with #15 on top of this matching rule.
  No schema or migration changes: `FacilityProfile`, `FacilityCapability` and
  `FulfillmentRecord` were already modeled (Phase 1 / #13) and the relations
  proved sufficient. Tests:
  `backend/tests/integration/facility-creation-matching.test.mts` (admin gate
  enforced server-side at 401/403, no self-serve path, one-transaction creation
  + audit, fail-closed matching across four facilities with different
  capability data).
- 2026-10-22 — Phase 3: referral expiry job
  ([issue #8](https://github.com/DocForum/docforum-core/issues/8)). One interval
  sweep (`src/jobs/referral-expiry.ts`, started from `server.ts` like the other
  jobs — no queue) moves `pending` referrals untouched for
  `REFERRAL_PENDING_TTL_DAYS` (default 14; sweep every
  `REFERRAL_EXPIRY_SWEEP_INTERVAL_SECONDS`, default 3600) to the terminal
  `expired` state through one conditional UPDATE in the referrals module, so it
  is safe across processes and re-runs, and a concurrent patient accept/decline
  either wins or finds the referral expired — never both. The age clock is
  `updatedAt`, so a referral the cascade (#67) or an admin (#68) returned to
  `pending` gets a fresh window. `accepted` referrals are never swept.
  Schema: new `Referral.expiredAt` and `Referral.expiredReason`
  (`ttl` | `no_show`), migration `20261022090000_referral_expiry`, which also
  backfills existing `expired` rows as `no_show` (the only way to expire until
  now) and adds a `(status, updatedAt)` index. `expired` stays distinct from
  `declined` and `cancelled`; `expiredReason` tells the two ways into `expired`
  apart, and the no-show cascade now records `no_show`. The TTL sweep also sets
  `referringDoctorNotifiedAt`, the existing seam Phase 6 reads.
  Not built: flagging the *patient* — there is no notification layer until
  Phase 6. When it lands, it can select `status = 'expired' AND expiredReason =
  'ttl'`; no marker for "patient notified" exists yet.
- 2026-10-22 — Fixed env-mode platform signing (`PLATFORM_SIGNER_MODE=env`), which couldn't sign any payment transaction after the signer abstraction (#175). `EnvPlatformSigner` wrapped a bare `Keypair`, which has no `signTransaction`, and both signer adapters returned a string where stellar-sdk reads `{ signedTxXdr }`. Env signers are now built with stellar-sdk's `basicNodeSigner`, and `PlatformSigner` returns the SEP-43 shapes (the remote adapter included). New unit tests sign a real transaction and auth entry with a real keypair. Found by the first nightly testnet payments run.
- 2026-10-23 — Phase 8: admin operations overview
  ([issue #123](https://github.com/DocForum/docforum-core/issues/123)).
  `GET /admin/overview` (admin-only) returns the count and oldest-item age for
  each queue listed in `src/admin-overview-sections.ts`, with a drill-down path.
  Each section comes from its owning module's service. A failing section is
  reported as `unavailable` and does not fail the response. The result is cached
  for 60 seconds. Only the doctor-verification queue is listed so far. Payments
  in intermediate states, failed jobs, stale referrals and unrouted orders still
  need their own sections.
- 2026-10-23 — Phase 5: webhook security primitives for facility notifications
  ([issue #126](https://github.com/DocForum/docforum-core/issues/126), partial).
  `src/utils/webhook-security.ts` adds HTTPS-only URL validation, blocks
  private, loopback, link-local and metadata IP literals, signs payloads with
  HMAC-SHA256 over `timestamp.body`, and computes capped exponential retry
  delays. Registration, the outbox, the delivery log and the schema are not
  included yet.
- 2026-10-23 — Publish @docforum/api-client as a versioned, generated TypeScript package derived from the OpenAPI spec. Removes hand-mirrored backend shapes in docforum-web, turns contract changes into compile errors, and publishes via GitHub Release tarball (same mechanism as @docforum/escrow-sdk). Generated types are never hand-edited; client has no Node-only dependencies.
- 2026-10-23 — Phase 6: real-time notification stream over Server-Sent Events
  ([issue #97](https://github.com/DocForum/docforum-core/issues/97), partial).
  `GET /notifications/stream` (authenticated) sends a `retry` hint, a heartbeat
  every 15 seconds, and a `token-expired` event before the access token expires,
  then closes. Each user is capped at five open streams (429 beyond that). An
  in-process hub fans out events to the user's streams. Persisted replay via
  `Last-Event-ID` and cross-instance delivery through Postgres LISTEN/NOTIFY are
  not included. They need the `Notification.userId` schema field.
- 2026-10-24 — Phase 4: a doctor issues a prescription or lab order from a consultation
  ([issue #10](https://github.com/DocForum/docforum-core/issues/10)).
  `POST /orders/consultations/:consultationId/{prescriptions,lab-orders}` now
  also refuse consultations whose appointment isn't `completed` (409, via the
  new `consultationsService.assertConsultationAcceptsOrders`, checked after the
  treating-doctor check) and check the facility up front
  (`facilitiesService.requireFacilityForOrderKind`: unknown or wrong-type
  facility → 400 instead of a foreign-key 500). Both still write through the
  append-only issuance path from #9. New HTTP integration suite
  `backend/tests/integration/orders-issuance.test.mts` (embedded Postgres, port
  5467) covers both order types, corrections, treating-doctor-only access and
  invalid consultation states. No schema or migration changes.
- 2026-10-24 — Updated backend production dependencies to clear new high-severity advisories that failed the CI audit gate: `@stellar/stellar-sdk` 16.3.1 → 16.4.1 (pulls axios 1.18.0 → 1.20.0, which fixes the prototype-pollution, header-injection, ReDoS and SSRF advisories), `zod` 4.6.5 → 4.6.7 (GHSA-mrhx-c7xc-m3w5), `body-parser` 2.3.0 → 2.4.0, and `fast-uri` 3.1.8 → 3.1.9. All are within the existing semver ranges.
- 2026-10-27 — Phase 9: add cached readiness checks for configuration, Postgres, Prisma
  migrations and optional Stellar RPC health, plus liveness endpoints and
  graceful HTTP/job/database shutdown ([issue #104](https://github.com/DocForum/docforum-core/issues/104)).
- 2026-10-27 — Phase 9: JWT key rotation with key ids
  ([issue #106](https://github.com/DocForum/docforum-core/issues/106)).
  Access and refresh tokens are signed with the current key and carry its
  `kid`. Verification accepts a previous key during an overlap window
  (`JWT_*_SECRET_PREVIOUS`), so rotation does not log users out. Tokens with an
  unknown `kid` are rejected. The rotation procedure is in
  `docs/runbooks/secret-rotation.md`. Loading secrets from a secrets manager and
  the staging rotation are still open.
- 2026-10-27 — Phase 9: add typed test data factories for Phase 1 and payment models, an
  idempotent synthetic preview seed, and a booking test fixture using the
  factories ([issue #118](https://github.com/DocForum/docforum-core/issues/118)).
- 2026-10-27 — Phase 8: DB-backed feature flags for staged rollouts
  ([issue #132](https://github.com/DocForum/docforum-core/issues/132)). New
  `FeatureFlag` table and `modules/flags`: boolean flags with an optional
  percentage rollout, targeted by role or user-id allowlist. The percentage is a
  sticky `sha256(flagKey:userId)` bucket, so a user gets the same answer on every
  request and raising the percentage never switches anyone off. Evaluation never
  throws and defaults to off (unknown flag, bad row, database down with nothing
  cached); flags are cached in memory for `FEATURE_FLAG_CACHE_TTL_SECONDS`
  (default 15).
  `GET /admin/feature-flags` lists them, `PATCH /admin/feature-flags/:key`
  creates/changes one and records a `feature_flag.created` / `feature_flag.updated`
  `AuditEvent` in the same transaction (the percentage and counts only, never the
  allowlisted user ids), and `GET /me/flags` returns the caller's evaluated flags
  for the frontend. First user: wallet funding (`payments.wallet_funding`, seeded
  **off**) now gates `POST /payments/intents/:id/prepare` with `403
  FEATURE_DISABLED` — an admin has to enable it, so existing environments stop
  offering it until they do. Migration `20261022100000_feature_flags`. "Per
  environment" is by construction: each environment has its own database and so
  its own flag rows.
- 2026-10-27 — Phase 5.5: Validate Stellar public keys with checksum-accurate StrKey validation ([issue #26](https://github.com/DocForum/docforum-core/issues/26)).
  Replaces the basic regex shape gate in `backend/src/modules/payments/validation.ts` with `StrKey.isValidEd25519PublicKey` from `@stellar/stellar-sdk`, ensuring invalid CRC16 checksums, malformed prefixes, non-base32 characters, and incorrect lengths are rejected at input validation time while preserving helpful validation error messages. Comprehensive unit test suite added in `backend/tests/unit/stellar-validation.test.mts`.
- 2026-10-27 — Phase 1: verify Docker Compose local dev setup ([issue #27](https://github.com/DocForum/docforum-core/issues/27)).
  Verified and updated `infra/docker/docker-compose.yml` (Postgres 16 + containerized backend) and `backend/Dockerfile` (ensuring Prisma client generation in container). Added missing startup environment variables (`SEP10_*`, `FIELD_ENCRYPTION_*`) and defaults in `backend/.env.example`. Tested clean execution (`docker compose up --build`), migration deployment, and endpoint functionality (`/health`, `/specialties`, auth endpoints). Updated `infra/docker/README.md` and root `README.md` with verified commands.
- 2026-10-27 — Phase 9: rebuild docs site on upstream changes ([issue #29](https://github.com/DocForum/docforum-core/issues/29)).
  Configured `.github/workflows/deploy-docs.yml` to accept `repository_dispatch` events (`upstream-docs-updated`, `docs-sync`) so docs changes landing in `docforum-web` or `docforum-escrow` can trigger automatic rebuilds of the cross-repo VitePress docs site. Removed the known-gap notes from `deploy-docs.yml` and `docs/site/README.md`, and documented the minimum-scope GitHub Personal Access Token (PAT) / GitHub App token requirements along with an example dispatch sender workflow for sibling repositories.
- 2026-10-27 — Phase 8: PostgreSQL row-level security for patient-scoped reads
  ([issue #116](https://github.com/DocForum/docforum-core/issues/116)). Adds transaction-local request identity for policies on appointments, payment intents, and consultations, a trusted maintenance bypass role, and denial coverage for unfiltered reads. `IntakeForm` remains deferred until its schema establishes patient ownership. See ADR 0014.
- 2026-10-27 — Added the admin-only `GET /admin/metrics` endpoint with UTC date windows, a minimum-cell suppression threshold, and current booking lead-time/no-show aggregates. Metrics requiring missing or unapproved instrumentation are reported as unavailable.
- 2026-10-28 — Phase 5: lab result attachment on object storage
  ([issue #16](https://github.com/DocForum/docforum-core/issues/16)).
  Provider decision, recorded in `docs/adr/0018-lab-result-object-storage.md`:
  **Amazon S3**, one private, SSE-S3-encrypted bucket per environment, reached
  through the official `@aws-sdk/client-s3` (new dependency). The SDK is wrapped
  by `backend/src/utils/object-storage.ts` and nothing else imports it. Any
  S3-compatible endpoint (MinIO locally) works through
  `OBJECT_STORAGE_ENDPOINT`. Files are never addressed by URL. The `LabResult`
  row stores an opaque, server-generated key (`lab-results/<uuid>`) that is
  never returned to a client, and the API serves the bytes after an access
  check on every read. Presigned URLs were rejected because they are bearer
  credentials, they can't be revoked, and reads through them skip the access log.
  Endpoints, both in the `orders` module (which owns `LabOrder`):
  `POST /orders/lab-orders/:labOrderId/result` takes a raw PDF/PNG/JPEG body
  (the bytes must match the declared type; size limit `LAB_RESULT_MAX_BYTES`,
  default 10 MiB). Only the facility the order was issued to can attach. Other
  facilities get `404`. The attach is create-once (`409`), refused on a
  superseded order (`409`), and audited as `lab_result.attached`.
  `GET /orders/lab-orders/:labOrderId/result` serves the file (`no-store`,
  `nosniff`, attachment) to the patient, the ordering doctor and the
  fulfilling facility only (PRD §7). Everyone else, including admins, gets the
  same `404` as a missing order, and every read is written to the PHI access
  log. The `LabOrder` row and its status are not touched (hard rule 1), and
  neither is `FulfillmentRecord` (hard rule 5; the `fulfilled` transition is
  still #15).
  Schema: `LabResult` gains `resultObjectKey` (unique), `resultContentType` and
  `resultByteSize` (migration `20261024090000_lab_result_object_storage`).
  `resultFileUrl` stays in place but is not written.
  Config: `OBJECT_STORAGE_DRIVER` (`s3`/`memory`/`none`; `memory` is refused in
  production), `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION`, and the
  optional endpoint/path-style settings. With no bucket configured the server
  still starts and these endpoints return `503 OBJECT_STORAGE_NOT_CONFIGURED`.
  Known gaps, added to ARCHITECTURE.md §6.2: the right-of-access export lists
  the result row but not the file bytes, and read access mirrors consultation
  notes, so guardians of dependents and later doctors in a referral thread
  can't read a result. The existing `utils/storage.ts` stub used by the #76
  fulfillment-proof `attachmentUrl` is unchanged and still stores nothing.
  Tests: `backend/tests/integration/lab-result-attachment.test.mts`
  and `backend/tests/unit/object-storage.test.ts`.
- 2026-10-28 — Consolidate idempotency-Key support (issue #48) and optimistic concurrency with
  version fields and `If-Match` (issue #49) into one PR. Adds the
  `IdempotencyKey` model with a unique `(userId, key)` constraint and the shared
  `optimistic-concurrency` middleware (`setVersionEtag`, `requireIfMatch`,
  `expectedVersion`, `versionConflict`), plus `version Int @default(1)` on `User`,
  `PatientProfile`, `DoctorProfile`, `FacilityProfile`, `FacilityCapability`,
  `Appointment` and `PaymentIntent`. `PATCH /doctors/me` is the reference
  implementation; system-driven updates (email verification, payment transitions)
  also bump the version. Existing status-conflict `409` behavior is preserved.
- 2026-11-01 — Phase 5: landed issues #73 (partial fulfillment, item-level dispensing for
  multi-item prescriptions) and #74 (facility location + distance-sorted
  eligible-facility query) together
  ([issue #73](https://github.com/DocForum/docforum-core/issues/73),
  [issue #74](https://github.com/DocForum/docforum-core/issues/74)).
  New `FulfillmentItem` model + `partially_fulfilled` order/record statuses,
  `FacilityProfile` location fields + composite `(latitude, longitude)` index,
  `/pharmacy-orders` fulfillment routes and the `GET /facilities/eligible`
  `near`/`radiusKm`/`limit`/`capabilityType` params (bounding box + haversine,
  no PostGIS — justification and the never-store-the-patient's-point rule are
  in ARCHITECTURE.md §5.5), a dev seed of fictional facility coordinates
  (`npx prisma db seed`), and two new integration test files
  (`fulfillment.test.mts`, `facility-distance.test.mts`). Payment-release rule
  decided and documented in ARCHITECTURE.md §5.3: no release until the whole
  order derives `fulfilled`; proration stays an open question in §6.2.
  Two things the merge with `main` forced, worth knowing before you touch this
  area:
  - Both records now hang off ADR 0012's typed order FKs rather than the old
    polymorphic `(orderType, orderId)` pair, and ADR 0012's "one record per
    order" UNIQUE became one record per **(order, facility)** — split routing
    needs a record at each facility. See the ADR's 2026-10-26 amendment and
    migration `20261026000000_fulfillment_record_per_order_facility`.
  - The Phase 5 migration no longer adds `PrescriptionItem.prescriptionId` or
    `FulfillmentRecord.facilityId`: main's `20261020000000_order_payment_intents`
    and `20261022090000_fulfillment_record_typed_order_fks` own those columns,
    and a second definition made `prisma migrate deploy` fail (42701) in every
    integration test.
- 2026-11-03 — Issue #116 follow-up: migration `20261024120000_patient_row_level_security` failed on Render with `permission denied to create role`, because only a role that already has `BYPASSRLS` can grant it. `docforum_rls_bypass` no longer has that attribute; explicit policies admit it on `Appointment`, `PaymentIntent` and `Consultation`. The test suite now connects as a non-superuser owner, which is what exposed the gap. This edits an already-merged migration, so a local database that applied the old version keeps working, but `prisma migrate dev` will ask to reset it. Admin success metrics now run in a transaction, because without the RLS context they would count no appointments on such a host.
- 2026-11-04 — Renewed the Render preview database (now expires 2026-12-04) and deployed current `main`. ADR 0003's renewal guide now covers the settings the service needs at startup, `/health/ready`, and creating the admin with `create-admin.mjs`.
- 2026-11-05 — Fixed the backup restore drill, which had failed since GitHub's `ubuntu-latest` runners moved to Postgres 18 client tools while the drill's server stayed on 16. The drill now runs Postgres 18, matching the Render database, installs the client version it declares, and stops with a clear error if the versions differ.
- 2026-11-18 — Phase 2: added patient-owned structured symptom intake records, self-only create/history endpoints, and the intake patient-export section ([issue #1](https://github.com/DocForum/docforum-core/issues/1)). Appointment linkage and requiring intake before booking remain issue #2.
- 2026-11-19 — Shared docs now take new content as fragments: a PR adds a file under
  `docs.d/` naming the doc and the heading (or line) its text goes under,
  instead of adding lines to `ROADMAP.md`, `ARCHITECTURE.md`,
  `ARCHITECTURE_ESSENTIALS.md`, `PRD.md`, `README.md` or `docs/api/README.md`. Maintainers fold them with
  `node scripts/docs-fragments.mjs fold`. The new `Docs fragments` CI job fails
  PRs that add lines to those docs directly or whose fragments don't fold.
- 2026-11-19 — Fixed drift between the committed migrations and the schema: migration
  `20261119090000_fix_schema_drift` converts `DoctorSpecialty.verificationStatus`
  from `VARCHAR(191)` to the `VerificationStatus` enum (and `reviewer` /
  `rejectionReason` to `TEXT`), and gives `RateLimitRecord` the
  `(key, scope, consumedAt)` index and no `updatedAt` default, as the schema
  declares. The schema now declares the existing trigram search indexes and the
  truncated `FacilityPrice` index names, so Prisma no longer wants to drop or
  rename them. `scripts/check-migration-drift.mjs` now exits non-zero on drift
  (it used to print FAILED and exit 0), and CI runs it on every PR.
- 2026-11-19 — Modules now register themselves instead of every PR editing the same two
  files: each module mounts its routes in `src/modules/<module>/mount.ts`
  (listed once, alphabetically, in `src/mounts.ts`), and each config section
  lives in its own file under `src/config/sections/` (listed in
  `sections/index.ts`). `app.ts` and `config/index.ts` no longer change when a
  feature adds routes or settings. No route, setting or default changed.
- 2026-11-19 — The Prisma schema is now a folder, `backend/prisma/schema/`, with one `.prisma`
  file per module (see its README) instead of one `schema.prisma` that every
  feature PR edited. Models and enums moved unchanged.
- 2026-11-20 — Phase 9: ESLint now runs in CI ([issue #28](https://github.com/DocForum/docforum-core/issues/28)).
  `backend/tools/lint` holds an isolated ESLint 9 + type-aware
  `typescript-eslint` toolchain pinned to the TypeScript 6 compatibility API
  (`@typescript/typescript6`), because `typescript-eslint` cannot load
  TypeScript 7 — which has no compiler API — while the app stays on `tsc` 7.
  `npm run lint` and a CI lint step after `typecheck` use it; the baseline turns
  `no-floating-promises` on as an error and leaves `no-explicit-any`,
  `no-console` and `no-unused-expressions` off (reasons in the config header).
  Adopting it surfaced real defects, now fixed: a literal-backspace regex in
  `patients/services` that never matched SQLSTATE 23001, `@ts-ignore` in
  `payments/validation.ts` that could hide an unrelated error, an undefined
  `iteration`/`__VU_ITER` in the k6 load scripts, and `kf6/*` imports in those
  scripts (they were loading nothing). No runtime or schema change.
- 2026-11-20 — Phase 5.5: escrow contract pinning tested ahead of the SDK 0.3.0 upgrade
  ([issue #32](https://github.com/DocForum/docforum-core/issues/32)).
  **The upgrade itself is blocked**: `docforum-escrow` has never published
  `sdk-v0.3.0` (the only releases are `sdk-v0.1.0` and `sdk-v0.2.0`), and this
  issue depends on that release. Nothing here fabricates the bump. What is
  done: release and refund already build the `EscrowClient` from the contract id
  recorded on the intent (`requireRecordedContractId`), so intents funded before
  a contract rotation still settle against their own contract; a new integration
  case in `tests/integration/payments-assets.test.mts` funds an intent, points
  it at `ESCROW_LEGACY_CONTRACT_IDS`, and asserts both release and refund use
  that legacy id rather than the active one. The roadmap item stays unchecked
  until `sdk-v0.3.0` exists.
- 2026-11-20 — Phase 8: TOTP two-factor authentication
  ([issue #36](https://github.com/DocForum/docforum-core/issues/36)).
  Dependency-free RFC 6238 implementation (`node:crypto`) with enrolment,
  two-step login, single-use recovery codes and `TOTP_REQUIRE_FOR_ADMIN`
  enforced admin enrolment. `User` gains `totpSecret` (encrypted with the
  existing field-encryption key), `totpEnabledAt` and `totpLastUsedStep`, plus a
  `TwoFactorRecoveryCode` table (SHA-256 hashes, single-use). Replay is blocked
  by claiming the accepted time step with one conditional `updateMany`, not by
  client state. Half-authenticated `mfa_pending`/`mfa_enrollment` tokens carry a
  `typ` claim and are rejected by `verifyAccessToken`, so they cannot be used as
  access tokens. New routes: `POST /auth/2fa/{setup,enable,verify,disable}` and
  `GET /auth/2fa/status`; `POST /auth/login` now returns `mfaRequired` +
  `mfaToken` (or `enrollmentRequired` + `enrollmentToken`) for such accounts.
  Settings: `TOTP_ISSUER`, `TOTP_REQUIRE_FOR_ADMIN`,
  `TOTP_MFA_TOKEN_TTL_MINUTES`. Tests: RFC vectors in
  `tests/unit/totp.test.ts`, full flow in
  `tests/integration/two-factor.test.mts`.
- 2026-11-20 — Phase 4: medication catalog
  ([issue #69](https://github.com/DocForum/docforum-core/issues/69)).
  New `medications` module with `GET /medications?q=` autocomplete (trigram
  index, 30k-row p95 asserted under 500 ms) and a `Medication` model imported by
  `backend/scripts/import-medications.mjs` from openFDA NDC — public-domain
  source, licence checked before import; RxNorm is deliberately not used because
  its CUIs are not openly licensed. `PrescriptionItem` gains `medicationId` and
  `flaggedForPharmacistReview`: prescribing from the catalog snapshots
  "generic name + strength + form" into the unchanged `drugName` display field,
  while an unlisted medicine keeps the prescriber's free text and is flagged for
  pharmacist review. An unknown `medicationId` is a `400` before any row is
  written, and catalog edits never rewrite an issued prescription. The catalog
  is a picker, not an interaction checker (PRD §8.2.8 stays deferred). Migration
  `20261120111332_medication_catalog` creates `pg_trgm` and the GIN index; tests
  in `backend/tests/integration/medications.test.mts`.
- 2026-11-20 — Phase 5.5: automatic escrow settlement — release on confirmed fulfillment
  (issue #83) and refund on rejection or expiry (issue #84). The order
  transition writes `order.fulfilled` / `order.rejected` / `order.expired` in
  its own transaction; the existing transactional-outbox worker (issue #94,
  verified still in place) claims it with `FOR UPDATE SKIP LOCKED`, retries with
  bounded backoff, and its lease recovers a killed worker without losing or
  duplicating the task. Release requires a whole order to derive `fulfilled`
  (partial fulfillment never releases); rejection refunds only when nothing was
  dispensed and no record is still open; lab-order expiry refunds inside the
  expiry update. Intent updates are conditional, so release and a timeout refund
  cannot both commit locally, and an on-chain `NotFunded` is a terminal `failed`
  reconcile with an audit row rather than a retry loop. Refund completion
  notifies the patient in-app. The admin `release`/`refund` endpoints stay as
  audited manual overrides.
  Phase 4: abnormal lab result escalation and doctor acknowledgement
  (issue #72, PRD §8.2.7). `LabResult.abnormality` is set by the facility at
  attach time; abnormal/critical results open one acknowledgement task for the
  ordering doctor (same transaction), notify them, and escalate to the admin
  queue after `LAB_RESULT_ESCALATION_HOURS` (default 24). New endpoints
  `POST /lab-results/:id/acknowledge` and `GET /lab-results/unacknowledged`;
  acknowledgement and escalation are one-shot conditional writes with audit
  events, and `overdue` is derived from the deadline so a missed job tick is
  visible. Migration adds the enum, the `LabResult` column and the
  `LabResultAcknowledgement` table. Critical results are **not** withheld from
  the patient.
- 2026-11-20 — CI: fork PRs' workflow runs are now approved automatically once they pass
  security review (`PR CI auto-approval`, the same workflow docforum-web uses
  since #350). The workflow runs after `PR malware scan` succeeds. It re-runs
  the scanner, then checks the diff and every commit in the PR's history for
  workflow, editor-config, font, payload-loader, npm-script, lockfile
  (npm/crates.io) and Go `replace` changes, and requires every commit to come
  from the PR author, a known AI coding tool account or a GitHub update merge. A
  PR that fails any check is labelled `ci-needs-manual-approval` and waits for a
  maintainer, as before.
- 2026-11-20 — Tests: `medications` and `two-factor` integration tests move to their own
  embedded-Postgres ports (5472, 5473). They had reused 5470 and 5471, already
  taken by `automatic-settlement` and `lab-result-escalation`, so whichever test
  started second could time out in `beforeAll`.
- 2026-11-20 — Phase 2: preserve verified doctor specialties on update ([issue #279](https://github.com/DocForum/docforum-core/issues/279)).
  `PUT /doctors/me/specialties` diffs requested specialties against existing assignments in a single transaction: removed specialties are deleted, only genuinely new specialties start as `pending`, and unchanged specialties retain their verification status, reviewer and review date intact. Re-adding a previously removed specialty starts fresh as pending. Removing a specialty does not alter or reroute existing referrals already routed to that doctor. Integration tests in `tests/integration/specialty-verification.test.mts`.
- 2026-11-20 — Phase 8: trustworthy and audited specialty verification decisions ([issue #280](https://github.com/DocForum/docforum-core/issues/280)).
  `PATCH /doctors/:id/specialties/:specialtyId/verification` derives reviewer identity directly from authenticated admin credentials (`req.user.id`) rather than untrusted request bodies, sets `reviewDate` server-side, and requires a bounded `rejectionReason` (up to 200 characters) when status is `rejected`. The update and an `AuditEvent` (`doctor_specialty.verification_changed`) commit together in a single transaction; same-status requests are safe no-ops and skip audit event emission.
- 2026-11-20 — Phase 2: admin queue of doctors and specialties awaiting verification ([issue #281](https://github.com/DocForum/docforum-core/issues/281)).
  New endpoint `GET /admin/doctors/verification-queue` lists pending doctor profiles and pending `DoctorSpecialty` links, ordered oldest first, with keyset pagination (`nextCursor`). Queries utilize existing indexes on `verificationStatus`. Responses include decision-relevant data (doctor name, requested specialties, queue age in seconds) with zero clinical details, filter by kind (`profile` vs `specialty`) and by specialty, and flag deactivated doctor accounts (`isDeactivated`).
- 2026-11-20 — Phase 2: admin management of the specialty catalog ([issue #282](https://github.com/DocForum/docforum-core/issues/282)).
  Admins can create specialties (`POST /admin/specialties`), rename them (`PATCH /admin/specialties/:id` with immutable slugs), and retire them (`POST /admin/specialties/:id/retire`). The `Specialty` model gains an `isRetired` boolean flag; retired specialties disappear from public `GET /specialties` and cannot be newly assigned to doctors, while existing doctor assignments and referrals remain intact. All catalog mutations record transactional `AuditEvent` entries (`specialty.created`, `specialty.renamed`, `specialty.retired`). Migration `20261120195109_admin_specialties_and_verification_queue`.
- 2026-11-20 — Phase 2: async consultation message thread
  ([issue #61](https://github.com/DocForum/docforum-core/issues/61)).
  Adds an append-only `ConsultationMessage` (encrypted body) with cursor
  pagination, participant-only read/write derived from the consultation's
  appointment, a configurable closing window, and a `consultation.message.created`
  outbox event as the Phase 6 notification hook. Messages and addenda are
  append-only at the DB level.
- 2026-11-20 — Phase 2: message attachments with access-checked short-lived URLs
  ([issue #62](https://github.com/DocForum/docforum-core/issues/62)).
  JPEG/PNG/PDF only, byte-sniffed, EXIF/GPS and PNG text metadata stripped on
  upload, per-message cap and per-user quota. Downloads require thread membership
  to mint an HMAC-signed URL that expires after `CONSULTATION_ATTACHMENT_URL_TTL_SECONDS`;
  object keys are never returned.
- 2026-11-20 — Phase 2: follow-up outcome creates a pre-filled booking request
  ([issue #63](https://github.com/DocForum/docforum-core/issues/63)).
  `follow_up_needed` now creates a `FollowUpRequest` with an immutable encrypted
  note snapshot and the patient's latest intake id. `GET /follow-ups/mine` and
  `POST /follow-ups/:id/book` let the patient book through the existing
  conditional slot claim (new appointment origin `follow_up`); an interval sweep
  expires unbooked requests past their window.
- 2026-11-20 — Phase 2: consultation note sign-off with append-only addenda
  ([issue #64](https://github.com/DocForum/docforum-core/issues/64)).
  Adds `Consultation.signedAt`; notes are editable only while unsigned, enforced
  by a conditional UPDATE and a DB trigger, then corrections are append-only
  `ConsultationAddendum` rows. Adds an RLS UPDATE policy for the note workflow
  (the RLS migration previously only had SELECT/INSERT on `Consultation`) and an
  hourly auto sign-off sweep.
- 2026-11-21 — Phase 8: read-only admin user directory (issue #275). `GET /admin/users`
  filters by role, active/deactivated/deleted state and an indexed email
  prefix, with audit-style keyset pagination. The response uses an explicit
  account-level allowlist (no credentials, tokens, TOTP secrets or clinical
  data), and tombstoned accounts are marked `deleted` with a null email
  instead of exposing their internal placeholder address. Migration adds
  `User_email_prefix_idx` (trigram GIN) so the prefix search is index-backed
  under any collation.
- 2026-11-21 — Phase 8: batched retention prune for auth artifacts (issue #276). A new
  `src/jobs/auth-token-prune.ts` deletes expired/consumed
  `EmailVerificationToken`, `PasswordResetToken` and `AdminInvite` rows,
  revoked `RefreshSession` rows and stale `Sep10Challenge` rows once they are
  past `AUTH_TOKEN_PRUNE_GRACE_HOURS`. Each table drains in
  `AUTH_TOKEN_PRUNE_BATCH_SIZE`-row `DELETE ... LIMIT` statements, up to
  `AUTH_TOKEN_PRUNE_MAX_BATCHES_PER_RUN` per tick. Every delete is conditional
  on expiry/consumption/revocation, so live tokens and active sessions are
  never removed (integration-tested). Logs counts only.
- 2026-11-21 — Phase 8: list and revoke admin invites (issue #277). `GET /admin/invites`
  returns pending/redeemed/expired/revoked invites without token hashes;
  `DELETE /admin/invites/:id` marks an unredeemed invite revoked with one
  conditional UPDATE and writes an `admin_invite.revoked` audit event in the
  same transaction. Revoke and redeem race on the same condition, so exactly
  one wins: a revoked invite can't be redeemed, and revoking a redeemed invite
  returns 409. Migration adds `AdminInvite.revokedAt`; revoked rows are later
  removed by the #276 prune.
- 2026-11-21 — Phase 8: cap active refresh sessions per user (issue #278).
  `MAX_ACTIVE_SESSIONS_PER_USER` (default 10) is enforced inside the session
  creation transaction: a per-user `pg_advisory_xact_lock` serialises logins,
  then the least recently used sessions beyond the cap are revoked with
  `revokedReason = 'max_active_sessions'`. The newly issued session is never
  evicted, concurrent logins cannot leave the account above the cap, and an
  evicted refresh token gets a 401 at refresh. Migration adds
  `RefreshSession.revokedReason`.
- 2026-11-21 — Phase 2: input guard rails for slot generation ([issue #288](https://github.com/DocForum/docforum-core/issues/288)).
  `POST /availability/doctors/:doctorProfileId/slots/generate` enforces bounds on `slotLengthMinutes` (5–240 minutes, configurable via `SLOT_MIN_DURATION_MINUTES` and `SLOT_MAX_DURATION_MINUTES`) and rejects windows where `(endHour - startHour) * 60` is not cleanly divisible by `slotLengthMinutes`. Dates in the past in the doctor's stored time zone are rejected (`SLOT_DATE_IN_PAST`), as are dates beyond a configurable horizon (`SLOT_MAX_HORIZON_DAYS`, default 365, `SLOT_DATE_BEYOND_HORIZON`). When generating for today in the doctor's time zone, slots whose start time has already passed are skipped. Documented partial-window remainder omission behavior in `buildSlotRanges`.
- 2026-11-21 — Phase 2: date-range filter for doctor open slots ([issue #289](https://github.com/DocForum/docforum-core/issues/289)).
  `GET /availability/doctors/:doctorProfileId/slots` adds optional `from` and `to` ISO date-time query parameters. Defaults to the next 14 days (`SLOTS_DEFAULT_RANGE_DAYS`); caps the requested span to at most 31 days (`SLOTS_MAX_RANGE_DAYS`); and clamps a past `from` timestamp to `now`. Replaced `(doctorProfileId, status)` index on `AvailabilitySlot` with composite `(doctorProfileId, status, startTime)` for index-backed range scans. Migration `20261120214621_slot_query_and_appointment_indexes`.
- 2026-11-21 — Phase 2: doctor today view uses doctor's time zone ([issue #290](https://github.com/DocForum/docforum-core/issues/290)).
  `GET /appointments/doctor/today` calculates calendar day boundaries (`00:00:00` to midnight next day) in the doctor's profile `timeZone` rather than server-local time, resolving midnight shifts for doctors in UTC+1 (Lagos) and UTC-5 (New York). Validates stored IANA time zone strings (`INVALID_TIME_ZONE`) and handles DST transition days with 23 or 25 hours.
- 2026-11-21 — Phase 2: doctor schedule endpoint for arbitrary date range ([issue #291](https://github.com/DocForum/docforum-core/issues/291)).
  New endpoint `GET /appointments/doctor?from=&to=&status=` lets authenticated doctors inspect their own appointments over an arbitrary date range (interpreted in their profile `timeZone`, capped at 31 days) and filter by `AppointmentStatus`. Returns slot start/end times and patient display name with zero clinical details. Cancelled appointments that released their slot return with `slot: null`. Added `(doctorProfileId, status)` index on `Appointment` in migration `20261120214621_slot_query_and_appointment_indexes`.
- 2026-11-21 — Phase 2: route POST /appointments/:id/cancel through the appointment state machine ([issue #292](https://github.com/DocForum/docforum-core/issues/292)).
  Both cancellation routes (`POST /:id/cancel` and `PATCH /:appointmentId/cancel`) now share conditional transitions through `applyScheduledTransition`, releasing future booked slots through `availabilityService` and dropping the slot reference to allow re-booking. Cancellations within the configurable cutoff window (`config.appointments.cutoffHours`) transition to `late_cancelled` with the slot kept booked while triggering referral cascades.
- 2026-11-21 — Phase 2: fix inverted reschedule cutoff check and add concurrency/validations ([issue #293](https://github.com/DocForum/docforum-core/issues/293)).
  `rescheduleSlot` now correctly evaluates the cutoff window using `config.appointments.cutoffHours`, rejecting last-minute attempts within the window and permitting far-future reschedules. Added validations requiring `scheduled` status, matching doctor profile, and future slot timing. Both old and new slots are updated conditionally through `availabilityService` in one transaction.
- 2026-11-21 — Phase 2: fix waitlist leave authorization and conditional expiry ([issue #294](https://github.com/DocForum/docforum-core/issues/294)).
  `leaveWaitlist` now resolves caller identity via patient profile IDs (and active guardianships) instead of user IDs, preventing false 403 authorization failures. The status transition to `expired` is now conditional on active waitlist states, preventing accepted entries from being cancelled.
- 2026-11-21 — Phase 2: partial unique index for active waitlist entries and typed status enum
  ([issue #295](https://github.com/DocForum/docforum-core/issues/295)).
  Replaced `WaitlistEntry` table-wide unique constraint with a partial unique index
  covering active entries (`pending`, `on_hold`) using PostgreSQL `NULLS NOT DISTINCT`
  for null-safe doctor/specialty deduplication. Converted `status` to `WaitlistStatus` enum.
  Patients can now re-join waitlists after leaving or acceptance, and concurrent duplicate
  joins are prevented at the database level.
- 2026-11-21 — ---
  type: added
  issue: 296
  ---
  Added role-scoped `GET /appointments/:id` detail endpoint with strong ETag, slot times, and doctor summary, accessible only by the patient, guardian, or treating doctor (non-participants and admins receive 404). Replaced list-and-find pattern in appointment check-in and queue controllers.
- 2026-11-21 — ---
  type: changed
  issue: 297
  ---
  Authorised appointment cancellation (both `POST /appointments/:id/cancel` and `PATCH /appointments/:appointmentId/cancel`) and rescheduling (`POST /appointments/:id/reschedule`) for guardians of dependent minors via `patientsService.resolveActingProfile`, recording the guardian as the actor and the dependent's profile in audit metadata.
- 2026-11-21 — ---
  type: added
  issue: 298
  ---
  Added indexes for unindexed foreign keys and filter columns on `Appointment` (`patientProfileId, createdAt` and `doctorProfileId, status`), `Prescription` (`prescribingDoctorId` and `facilityProfileId`), `LabOrder` (`facilityProfileId`), and `LabResult` (`fulfillingFacilityId`).
- 2026-11-21 — Phase 2: prevent premature appointment completion and no-show marking before slot start time ([issue #299](https://github.com/DocForum/docforum-core/issues/299)).
  `updateStatusByDoctor` now refuses `completed` and `no_show` status updates before the slot's `startTime` or when the appointment has a released slot, returning HTTP 409 with code `APPOINTMENT_NOT_STARTED`. Pre-start cancellation remains permitted.
- 2026-11-21 — Phase 2: public doctor detail endpoint ([issue #301](https://github.com/DocForum/docforum-core/issues/301)).
  Added `GET /doctors/:doctorProfileId`, returning public doctor fields (`id`, `fullName`, `specialties`, `nextAvailableAt`) for a single verified, active doctor without requiring authentication. Unverified, deactivated, deleted, or unknown doctor profiles return 404, matching search visibility rules.
- 2026-11-21 — Phase 2: show each doctor's next available slot in search results and add availableBefore filter ([issue #302](https://github.com/DocForum/docforum-core/issues/302)).
  `GET /doctors` now returns `nextAvailableAt` per item via a batched availability lookup and supports an optional `availableBefore` query filter while preserving keyset pagination.
- 2026-11-21 — Phase 2: allow closing an open consultation record ([issue #303](https://github.com/DocForum/docforum-core/issues/303)).
  `POST /appointments/:id/consultation` can now close a consultation opened earlier without an outcome via a conditional database update matching `outcome IS NULL`, retaining existing encrypted notes if new notes are not provided.
- 2026-11-21 — Phase 2: list consultations for the patient and the treating doctor ([issue #304](https://github.com/DocForum/docforum-core/issues/304)).
  Added keyset-paginated `GET /consultations/mine` for patients (including guardian view with `patientProfileId`) and `GET /consultations/doctor` for treating doctors. Responses return visit summaries (date, doctor/patient name, outcome) without decrypted clinical notes, resolving ownership through the appointments service and displaying anonymised patient profiles as `Deleted patient`.
- 2026-11-21 — CI: `Docs fragments` now fails only when a PR adds lines straight to a shared
  doc, which is the rule that prevents conflicts. A fragment that wouldn't fold
  (unknown heading, ambiguous `after:`, missing front matter) is a warning with a
  suggested fix (closest headings, or the shared doc that has the heading), shown
  inline on the PR, and a maintainer corrects it when folding. Problems in
  fragments already on main are never blamed on a PR. Maintainer mode (fold PRs)
  stays strict. Same change as docforum-web#364.
- 2026-11-21 — PR malware scan: flags unsigned commits that are attributed to a maintainer account (anyone with write access) on PRs opened by someone else, as the `unverified-maintainer-identity` note. Signed commits and web-flow merges pass; write access is read from the API, so the script stores no names or emails.
- 2026-11-21 — Tests: integration files that share an embedded Postgres `const PORT` no
  longer time out when vitest runs them in parallel. The test wrapper
  (`backend/tests/helpers/restricted-embedded-postgres.mts`) holds a per-port
  lock from `start()` to `stop()`, so the second file waits a few seconds for
  the first instead of failing with "Hook timed out". Existing test files need
  no changes; distinct ports are still preferred because they're faster.
- 2026-11-22 — Phase 8: change account email with verification of the new address ([issue #271](https://github.com/DocForum/docforum-core/issues/271)).
  Added `POST /auth/change-email/request` and `POST /auth/change-email/confirm` endpoints backed by expiring `EmailChangeToken` model. Re-verifies password with login throttle integration, sends confirmation to the new email and notice to the old email, swaps the address atomically, and records `email_change.requested` and `email_change.confirmed` AuditEvents.
- 2026-11-22 — Phase 2: patient profile read and update endpoints with optimistic concurrency ([issue #272](https://github.com/DocForum/docforum-core/issues/272)).
  Added `GET /patients/me` returning caller's profile with strong ETag and `PATCH /patients/me` requiring `If-Match` header to update `fullName` and `dateOfBirth` via a single conditional UPDATE on `id`, `version`, and `anonymizedAt: null`. Refuses anonymized profiles.
- 2026-11-22 — Phase 8: record AuditEvents for admin account actions ([issue #273](https://github.com/DocForum/docforum-core/issues/273)).
  Wired transactional `auditService.record` calls into admin user deactivation (`user.deactivated`), reactivation (`user.reactivated`), admin invite creation (`admin_invite.created`), admin session revocations (`user.sessions_revoked`), and login throttle clears (`login_throttle.cleared`). Removed interim console.info logging and ensured idempotent no-ops emit no audit events.
- 2026-11-22 — Phase 8: prevent concurrent admin deactivations from removing the last active admin ([issue #274](https://github.com/DocForum/docforum-core/issues/274)).
  Made last-admin check and update atomic in PostgreSQL via row locks (`FOR UPDATE` on active admin users ordered by id) inside a single transaction. Retains idempotent 200 and 409 conflict responses. Added concurrency integration test asserting at least one active admin always remains.
- 2026-11-22 — CI now fails when an editor backup or merge artefact (`*.bak`, `*.orig`, `*.rej`) is tracked: `node scripts/check-no-backup-files.mjs`, ported from docforum-web #354. It reports the files and how to remove them. This is an ordinary CI check, not a malware-scan finding: a leftover `.orig` from resolving a conflict is a mistake to fix, not a reason to block CI approval.
- 2026-11-23 — Phase 9: production deployment target decided (ADR 0015, closes
  [issue #22](https://github.com/DocForum/docforum-core/issues/22)).
  The target is Render on the paid tier — one Pro workspace, a Blueprint-defined
  staging and production web service, and a paid Render Postgres per
  environment. That removes the free-tier 30-day database expiry (the
  2026-12-04 deadline is the last one) and gives 7-day PITR; ADR 0007's
  encrypted `pg_dump` + weekly restore drill now run against a real
  environment. Secrets live in per-environment Render environment groups with
  the team password manager as the source of record. ADR 0003's free-tier
  preview is unchanged and stays preview-only. `ARCHITECTURE.md` §8 and §7 now
  point at the decision instead of listing it as open, and the Phase 9
  staging/production items are unblocked (not yet provisioned).
- 2026-11-23 — Phase 5.5: escrow funding is idempotent and reconcilable (closes
  [issue #24](https://github.com/DocForum/docforum-core/issues/24)).
  `fundPaymentIntent` now claims the intent `created -> funding` with one
  conditional UPDATE that commits before `create_escrow`; of N concurrent fund
  requests exactly one reaches the chain and the rest get `409` (proven with 8
  concurrent requests against embedded Postgres and a fake SDK). A failed chain
  call returns the intent to `created` and audits it; a crash between the call
  and the settle write leaves `funding`, which `npm run reconcile:escrows`
  reports and resolves explicitly (`--adopt` an escrow the event poller
  observed, or `--abandon` a claim that never reached the chain). New
  `funding` status and `fundingStartedAt` column; the admin history filter
  accepts `status=funding`. No automatic retry of the chain call — that could
  create a second escrow.
- 2026-11-23 — Phase 5.5: releaser key custody decided (ADR 0016, closes
  [issue #25](https://github.com/DocForum/docforum-core/issues/25)). Production
  escrows will use a 2-of-4 Stellar multisig releaser (three custodied signer
  keys plus an offline master key; medium/high threshold 2), so a single leaked
  or lost key can neither drain nor lock open escrows. KMS/HSM is deferred as
  a v1 choice, and per-period rotation is rejected as the primary control.
  Prerequisites are recorded as follow-ups, not implied as done: the
  `docforum-escrow` SDK must collect a second signature, `PaymentIntent` must
  persist the releaser public key it was funded under so key rotation cannot
  strand old escrows, and settlement needs a two-step approval. Payments stay
  behind the feature flag until those land; staging and the preview keep a
  single-signer testnet releaser.
- 2026-11-23 — Phase 3: target doctors can see referrals aimed at them through `GET /referrals/incoming` ([issue #306](https://github.com/DocForum/docforum-core/issues/306)). The endpoint is scoped to the caller's own `DoctorProfile`, defaults to `pending`/`accepted`, accepts a `status` filter for terminal referrals, and uses `(createdAt, id)` keyset pagination over the existing `targetDoctorId` index. Snapshot notes are returned decrypted when encryption lands, and every returned row writes a PHI access log naming the target doctor as viewer. Reassignment changes only `targetDoctorId`, so moved referrals leave the old target's inbox and enter the new one. No schema changes.
- 2026-11-23 — Removes all direct cross-module Prisma table accesses from lab-orders, pharmacy-orders, and payments — these modules now call the owning module's service layer instead (issue #318). Deleted the duplicated `findFacilityProfileByUserId`, `findPatientProfileByUserId`, `findPatientUserIdByProfileId`, and `findFacilityNamesByIds` helpers from the payments and pharmacy-orders repositories; added the canonical equivalents as exports on `facilities/services` and `patients/services`.
- 2026-11-23 — Adds admin-only endpoints for managing facility capabilities (issue #320): `POST /facilities/:facilityId/capabilities` and `DELETE /facilities/:facilityId/capabilities/:capabilityId`. Both operations record `FacilityCapability` audit events. Added `addCapabilitySchema` validation and `CapabilityView` service type.
- 2026-11-23 — Adds price-item retirement to the facility price list (issue #321). A new `retired` boolean on `FacilityPrice` (append-only: retirement inserts a new row). `resolveCurrentPrice` returns `{ retired: true }` when the current version is retired; `requireCurrentPrice` throws `ITEM_RETIRED` (422). Added `POST /facilities/me/prices/retire` endpoint (facility owner only).
- 2026-11-23 — Lets patients (and active guardians) read fulfillment records for their own orders (issue #323). `getFulfillment` now allows patient/guardian access in addition to the owning facility and admin. Adds `GET /pharmacy-orders/orders/:orderId/fulfillments` list endpoint that returns all fulfillment records for one order.
- 2026-11-23 — Phase 5.5: integration tests for `GET /admin/payments/escrow-events`
  ([issue #327](https://github.com/DocForum/docforum-core/issues/327)).
  `backend/tests/integration/escrow-events.test.mts` seeds `EscrowChainEvent` and
  `EscrowEventCursor` rows directly and covers admin-only access (401/403 for
  every other role), the `state` filter, `detectedAt desc, id desc` ordering,
  pagination, query validation, `catchupError` on the affected cursor, and the
  unmatched-event flag (`state: unmatched`, `paymentIntentId: null`,
  `alertedAt` set) — including one produced by the RPC-free reconcile pass. No
  network calls (`fetch` is asserted untouched). The endpoint previously had
  only `limit`, so operators could not see past 200 rows: it now takes an
  optional opaque `cursor` and returns `nextCursor` (additive; existing callers
  unchanged). No schema changes.
- 2026-11-23 — Phase 5.5: facility payout-wallet changes are audited and take effect after a cool-down
  ([issue #328](https://github.com/DocForum/docforum-core/issues/328)).
  Every wallet link now writes an `AuditEvent` (`entity_type: 'WalletLink'`,
  `wallet_link.linked` / `wallet_link.changed`, previous and new address for
  facilities) in the same transaction as the change. New column
  `WalletLink.effectiveAt` (migration `20261123163830_wallet_link_effective_at`,
  backfilled from `createdAt`): a facility re-link only becomes the escrow payee
  after `WALLET_LINK_COOLDOWN_HOURS` (default 24). Until then funding and
  prepare keep paying the previously effective address. The first-ever link for
  a facility, and every patient link, are immediate. Re-linking inside the
  window cancels the pending link. Escrows already funded stay bound to their
  recorded payee. As defence in depth, both release paths refuse a payee that
  is known only as a not-yet-effective link (`409 WALLET_LINK_COOLDOWN`). The
  outbox retries a held automatic release and then dead-letters it, and the funds
  stay in escrow. New admin endpoint
  `GET /admin/payments/wallet-links/pending`.
- 2026-11-23 — Phase 5.5: CSV export of the facility payout ledger
  ([issue #329](https://github.com/DocForum/docforum-core/issues/329)).
  `GET /payments/facility/ledger.csv` takes the ledger's `status`, `from` and
  `to` filters and returns the same rows as `GET /payments/facility/ledger`.
  Columns: date, intent id, status, asset, amount in the smallest unit, decimal
  amount, transaction hash. It is streamed in keyset pages of 500, so memory
  stays flat for any date range. Every cell is escaped against spreadsheet
  formula injection (`=`, `+`, `-`, `@`, tab and CR get a leading `'`) by
  `src/utils/csv.ts`. No schema changes.
- 2026-11-23 — Phase 6: real-time notification events reach users on every backend instance
  ([issue #330](https://github.com/DocForum/docforum-core/issues/330)).
  `notify()` now publishes through a broker
  (`modules/notifications/services/fanout.ts`). The default broker uses
  `pg_notify` on the `docforum_notifications` channel, and each instance
  `LISTEN`s on its own connection outside Prisma's pool and delivers to its local
  SSE streams. Payloads are ids only (`notificationId`, `userId`, `type`), and
  clients fetch the notification over HTTP. The listener reconnects with
  exponential backoff and sends each local stream a `resync` event afterwards.
  Its state is reported, but not gated, as `checks.notifications` in
  `/health/ready`. New settings: `NOTIFICATION_FANOUT_DRIVER` (`pg` | `local`),
  `NOTIFICATION_FANOUT_RECONNECT_MIN_MS` and `NOTIFICATION_FANOUT_RECONNECT_MAX_MS`.
  No schema changes.
- 2026-11-23 — Phase 6: integration tests for `GET /notifications/stream`
  ([issue #331](https://github.com/DocForum/docforum-core/issues/331)).
  `backend/tests/integration/notification-stream.test.mts` opens real SSE
  connections against `createApp()` and covers 401 (missing/invalid token), the
  stream headers and retry hint, heartbeats, delivery of a published event to
  the recipient's streams only, the exact per-user cap (5 open, 6th is
  `429 STREAM_LIMIT`, closing one frees exactly one slot, other users
  unaffected), the `token-expired` event ending the stream, and unsubscribe on
  client disconnect. Every connection is destroyed in `afterEach` and the hub
  count is awaited back to zero. The heartbeat interval is now
  `streamTimings.heartbeatMs` (still 15s) so the test can shorten it; the suite
  runs in about 4s. No schema or endpoint changes.
- 2026-11-23 — Phase 8: security response headers and `X-Powered-By` removal
  ([issue #332](https://github.com/DocForum/docforum-core/issues/332)).
  `backend/src/middleware/security-headers.ts`, registered in `createApp` right
  after the request-id middleware, sets `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none';
  frame-ancestors 'none'`, `X-Frame-Options: DENY` and `Cache-Control: no-store`
  on every response (login/refresh carry tokens without an `Authorization`
  header, so no-store isn't limited to authenticated requests; a route can
  still set its own). `Strict-Transport-Security` is sent only when
  `NODE_ENV=production` (`config.securityHeaders`), never in local development.
  `x-powered-by` is disabled. Unmatched routes now answer a JSON
  `404 { message: 'Not found.' }` instead of Express's HTML page, so the API
  never serves HTML. The SSE stream keeps streaming with
  `Cache-Control: no-store, no-transform`. No dependency added (no helmet).
  Tests: `backend/tests/unit/security-headers.test.ts`,
  `backend/tests/integration/security-headers.test.mts`.
- 2026-11-23 — Phase 9: malformed JSON and oversized request bodies no longer return 500
  ([issue #333](https://github.com/DocForum/docforum-core/issues/333)).
  `errorHandler` maps body-parser failures to stable codes:
  `400 INVALID_JSON`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_ENCODING`,
  `415 UNSUPPORTED_CHARSET`, `400 REQUEST_ABORTED`, and `400 INVALID_REQUEST_BODY`
  for a corrupt compressed body. These are logged at `warn` with only the
  error type and status. The raw body, which body-parser attaches to parse
  errors, is never logged. The lab-result raw-body route keeps
  `LAB_RESULT_TOO_LARGE`. No schema or endpoint changes.
- 2026-11-23 — Phase 9: Prisma not-found and foreign-key errors no longer surface as 500
  ([issue #334](https://github.com/DocForum/docforum-core/issues/334)).
  The error handler maps `P2025` to `404 Record not found.` and `P2003` to
  `422 The request refers to a record that does not exist or is still in use.`
  (alongside the existing `P2002` → `409`), from a single
  `PRISMA_CLIENT_ERRORS` table. Messages are fixed strings: Prisma's message and
  `meta` (table, column and constraint names) are only logged. Errors thrown
  inside `$transaction` map the same way. Referral creation now checks the
  target specialty exists first and answers
  `422 SPECIALTY_NOT_FOUND` instead of the misleading "no verified doctor"
  error. Postgres `ON DELETE RESTRICT` refusals (SQLSTATE 23001) arrive as an
  *unknown* Prisma error and still return 500; call sites that can hit them
  already catch them (`isForeignKeyRefusal`). Tests:
  `backend/tests/unit/error-handler-prisma.test.ts`,
  `backend/tests/integration/prisma-errors.test.mts` (real Postgres, one per
  mapped code, inside and outside transactions) and a case in
  `referral-routing.test.mts`.
- 2026-11-23 — Phase 2: symptom-to-specialty mapping for "search by symptom" (closes
  [issue #60](https://github.com/DocForum/docforum-core/issues/60)). A curated
  `Symptom` / `SymptomSpecialty` vocabulary (weights 1–5, admin-managed,
  reviewed starter set in the migration) with `GET /symptoms?q=` autocomplete
  (prefix + trigram, retired symptoms hidden), `GET /doctors?symptom=<slug>`
  ranked by mapping strength, and admin CRUD at `/admin/symptoms` (create,
  rename/retire, replace mappings; all audited). Explicitly not ML
  (PRD §8.3.3) and never presented as medical advice. An unknown, retired or
  unmapped symptom is `200` with empty `items` and a `hint`, not an error. New
  models documented in `ARCHITECTURE.md` §4.15; endpoints in
  `docs/api/README.md`.
- 2026-11-24 — Phase 3: role-scoped referral detail endpoint ([issue #307](https://github.com/DocForum/docforum-core/issues/307)).
  Added `GET /referrals/:referralId`, returning one referral row — including `status`, `expiredAt`, `expiredReason`, `cancelledReason` and `resultingAppointmentId` — to the owning patient (or active guardian with `?patientProfileId=`), the referring doctor, the current target doctor, or an admin. Everyone else receives `404`. The route is registered after `/incoming`, `/mine`, `/created` and `/admin/*` so those paths keep matching, and successful reads are recorded in the PHI access log.
- 2026-11-24 — Phase 3: the referring doctor can withdraw their own pending referral
  ([issue #308](https://github.com/DocForum/docforum-core/issues/308)).
  `POST /referrals/:referralId/withdraw` takes a required 1–200 character reason,
  uses the same conditional `pending → cancelled` update as accept/decline (also
  guarding `resultingAppointmentId IS NULL`) and writes a `referral.withdraw`
  AuditEvent in the same transaction. Reuses the existing `cancelled` status and
  `cancelledReason` column; no schema change. Integration tests cover the
  withdraw/accept race, another doctor's referral (404), accepted referrals (409)
  and validation.
- 2026-11-24 — Phase 9: bounded both order-expiry sweeps (issue #348).
  `expireUnconfirmedOrders` and `expireUnfulfilledOrders` now select ids in
  bounded, id-ordered batches driven by a new `expirySweeps` config section
  (`EXPIRY_SWEEP_BATCH_SIZE`, `EXPIRY_SWEEP_MAX_PER_RUN`), logging batch counts
  through the structured logger. Each transition keeps its existing conditional
  UPDATE and same-transaction audit/outbox event; a row already handled by
  another process is skipped without a duplicate event. A capped run leaves
  later rows for the next scheduled tick. Unit and integration tests cover
  multi-batch, exact-multiple, empty, cap, resume and concurrent-run behavior.
  No schema or endpoint changes.
- 2026-11-24 — Phase 9: added `npm run new:module -- <name>` (`backend/scripts/new-module.mjs`),
  which scaffolds a backend module skeleton under `backend/src/modules/` with
  the intentional `routes/controllers/services/repositories` folders,
  `validation.ts` and `mount.ts`. Names are validated as lowercase kebab-case and
  existing modules are never overwritten. Shared wiring (`src/mounts.ts`,
  export/retention registries, API docs rows) is not edited automatically; the
  generator prints the exact follow-ups instead. Documented in `CONTRIBUTING.md`.
  No model or endpoint changes.
- 2026-11-24 — Docs/CI: resolved the duplicate ADR numbers (closes [#352](https://github.com/DocForum/docforum-core/issues/352)). 0006 stays with the Prisma 7 driver adapter (committed first); the multi-referral ADR is now 0017. 0014 stays with PostgreSQL row-level security (committed first); lab-result object storage is now 0018. All references were updated in place, `docs/adr/README.md` is now the full ADR index, and `scripts/check-adr-numbering.mjs` runs in CI to reject duplicate numbers, heading/filename mismatches and unindexed ADRs. No schema, endpoint or runtime changes.
- 2026-11-24 — Docs: resolved duplicate ARCHITECTURE.md section numbers (closes [#353](https://github.com/DocForum/docforum-core/issues/353)). The later/less-referenced sections are now §3.2 (account deletion and retention holds), §4.16 (PHI read-access log), §4.17 (Payments) and §5.5 (facility discovery by distance); references that meant those sections were updated in place. §4.15 was left free for the already-filed issue #60 fragment. ARCHITECTURE_ESSENTIALS.md no longer points at a `frontend/src/` path in this repo — the frontend lives in `docforum-web` — and its jobs list now reflects the schedulers and workers actually started from `backend/src/server.ts`. `scripts/check-section-numbering.mjs` runs in CI to keep top-level section numbers unique, and the pending issue #24 docs fragment now targets §4.17. No schema, endpoint or runtime changes.
- 2026-11-24 — Phase 5.5: operator runbook for escrow event alerts and RPC retention gaps
  ([issue #356](https://github.com/DocForum/docforum-core/issues/356)).
  `docs/runbooks/escrow-event-alerts.md` covers reading
  `GET /admin/payments/escrow-events`, triaging an `unmatched` release or refund
  (intent lookup, audit trail, dead letters, `npm run reconcile:escrows`), pausing
  `payments.wallet_funding`, and recovering a stalled contract by setting a
  reviewed, strictly later `ESCROW_CONTRACTS` start ledger. Every step was written
  against the current code paths and cites the file it depends on; the runbook ends
  with the controls that do not exist yet, so an operator stops looking for them.
  It is linked from the `ARCHITECTURE_ESSENTIALS.md` escrow monitoring section
  (`docs.d/356-escrow-event-alerts-runbook.md`) and from the docs site, which now
  syncs `docs/runbooks/` like the other doc trees. No code, schema or endpoint
  changed.
- 2026-11-24 — Phase 2: integration tests for the doctor's day view and status transitions
  ([issue #358](https://github.com/DocForum/docforum-core/issues/358)).
  `backend/tests/integration/doctor-day-view-and-status-transitions.test.mts`
  (real Postgres) pins `GET /appointments/doctor/today` — own
  appointments only, ordering by slot start, the calendar day taken from the
  doctor's `timeZone`, scheduled-only, doctor-only — and every legal and illegal
  `PATCH /appointments/:id/status` transition, including a three-way concurrent
  race where exactly one request wins. The suite fakes the clock
  (`vi.useFakeTimers({ toFake: ['Date'] })`) so it cannot flake near midnight UTC.
  `docs/api/README.md` still described `/doctor/today` as the server-local day
  after issue #290 changed it; that row is corrected in place. No behaviour
  changed.
- 2026-11-25 — Phase 8: active guardians can read and act on a dependent's consultations, referrals and lab results through an optional `patientProfileId` parameter on `GET /consultations/:id`, `GET /referrals/mine`, referral accept/decline and `GET /orders/lab-orders/:id/result` ([issue #305](https://github.com/DocForum/docforum-core/issues/305)). Every path authorises through `patientsService.resolveActingProfile`, ends immediately on revocation or at majority with `403 GUARDIANSHIP_INACTIVE`, and PHI-access-logs guardian reads. Existing caller-only behaviour is unchanged when the parameter is omitted; no schema changes.
- 2026-11-25 — feat(referrals): Filter the admin referral queue by specialty and target doctor
  - Added `targetSpecialtyId` and `targetDoctorId` query filters to
    `adminQueueQuerySchema` and the repository `listAdminQueue` query.
  - Referrals with `null targetSpecialtyId` (named-doctor referrals) do not
    match a specialty filter, preserving the distinction between specialty-only
    and doctor-named referrals.
  - The admin queue endpoint `GET /referrals/admin/queue` now accepts these
    additional optional query parameters, conjunctive with the existing
    `status`, `olderThan`, and `loopFlagged` filters.
  - Updated `docs/api/README.md` row for `GET /referrals/admin/queue` to
    document the new filters.
  - Integration tests added in `backend/tests/integration/admin-referrals.test.mts`.
  Closes #339
- 2026-11-25 — feat(ci): Static module-boundary check in CI
  - Added `scripts/check-module-boundaries.mjs` that statically checks for
    imports from other modules' `repositories`, `controllers`, or `routes`
    directories. A violation triggers a non-zero exit code.
  - Existing violations are tracked in an allowlist so the check can be
    introduced incrementally without breaking the build.
  - Configured the script to run in `.github/workflows/ci.yml` as part of the
    CI pipeline.
  - Allowlist for existing violations has been added; new violations will
    cause CI to fail.
  - Verified that a deliberately bad import in a test fixture makes the
    check fail.
  Closes #340
- 2026-11-25 — feat(logging): Route startup, shutdown and job logs through the structured logger
  - Replaced `console.*` calls in `src/server.ts` with the structured pino
    logger (`logger.info`, `logger.error`).
  - Replaced `console.*` calls in all job files under `src/jobs/` with the
    structured logger:
    - `referral-expiry.ts`
    - `auth-token-prune.ts`
    - `outbox-events.ts`
    - `payment-intents.ts`
    - `consultation-sign-off.ts`
    - `lab-result-escalation.ts`
    - `order-expiry.ts`
    - `patient-exports.ts`
    - `follow-up-expiry.ts`
    - `account-purge.ts`
  - Replaced `console.*` call in `src/modules/auth/services/email-dispatcher.ts`
    with `logger.info`.
  - Replaced `console.*` calls in other modules across `src/`:
    - `src/modules/audit/services/index.ts`
    - `src/modules/notifications/services/index.ts`
    - `src/modules/orders/services/lab-results.ts`
    - `src/modules/patients/services/index.ts`
    - `src/modules/payments/services/escrow-events.ts`
    - `src/modules/payments/services/index.ts`
  - Added lint guard (via existing `npm run lint` pipeline) that will forbid
    `console.*` in `src/` outside `scripts/` in future PRs.
  - No console calls remain in `src/`; all job logs carry error types, not
    messages, consistent with the structured logging rule.
  Closes #341
- 2026-11-25 — feat(ci): Run the migration drift check in CI
  - Added `prisma validate` and `prisma format --check` steps next to the
    existing drift check in `.github/workflows/ci.yml`.
  - The drift check (`node scripts/check-migration-drift.mjs`) now runs in
    parallel with tests to keep job time reasonable.
  - Documented the schema checks in `CONTRIBUTING.md` under the "Schema"
    section, describing `prisma validate`, `prisma format --check`, and the
    drift check.
  - Script header updated to reference issue #376 and the CI check.
  - Fails on a deliberate drift in a test branch (verified via commit
    ad989bc).
  - `prisma validate` and `prisma format --check` run in CI on every PR.
  Closes #342
- 2026-11-25 — Phase 8: integration tests for admin overview and success-metrics endpoints ([issue #359](https://github.com/DocForum/docforum-core/issues/359)).
  `backend/tests/integration/admin-overview-and-metrics.test.mts` exercises `GET /admin/overview` and `GET /admin/metrics` against real Postgres:
  - Enforces admin authorization gating (401 for anonymous, 403 for patient and doctor roles).
  - Validates query parameter checking on `GET /admin/metrics` (RFC3339 offset awareness, interval boundaries, 366-day range cap).
  - Tests empty and populated queue state calculations on `GET /admin/overview`, ensuring pending doctor counts and oldest item age are computed accurately without leaking PHI.
  - Verifies SQL view aggregation and small-count suppression thresholds (< 5 eligible appointments) for `noShowRate` and `bookingLeadTimeDays` with hand-derived metrics over a pinned clock.
- 2026-11-25 — Phase 1: let doctors set and change their time zone ([issue #360](https://github.com/DocForum/docforum-core/issues/360)).
  `POST /auth/signup` accepts an optional `timeZone` field for doctor accounts (defaulting to `'UTC'` when omitted, and rejected for patient accounts). `PATCH /doctors/me` now accepts `timeZone` in addition to `fullName` under `If-Match` optimistic concurrency. Time zones are validated at runtime against canonical IANA identifiers via `Intl.supportedValuesOf('timeZone')` plus `'UTC'`, rejecting non-canonical aliases like `EST` and unrecognized strings. Changing a doctor's time zone preserves the absolute UTC timestamps of existing availability slots and booked appointments. Unit and integration tests cover signup, concurrent profile update, IANA validation, and slot immutability.
- 2026-11-25 — Phase 4/5.5: lab test catalog endpoint, verifiable order token verification, non-custodial submit endpoint, and fee-sponsor budget monitoring (issues #70, #71, #81, #82). Adds `GET /lab-tests`, `POST /facilities/me/verify-order`, `POST /payments/intents/:id/submit`, and `GET /admin/payments/fee-sponsor`.
- 2026-11-25 — Phase 6 notification delivery and Phase 9 CI hardening ([issues #95, #96, #111, and #112](https://github.com/DocForum/docforum-core/issues/112)). Added PHI-safe Postmark and Twilio adapters with signed callbacks, persistent delivery and SMS consent records, an OpenAPI 3.1 contract with drift checks, non-production contract serving, CodeQL, dependency review, and gitleaks gates.
- 2026-11-26 — Added CI matrix to test unit tests and typecheck across Node versions 20, 22, and 24, aligned build job with production Node 22, and documented supported versions in CONTRIBUTING.md.
