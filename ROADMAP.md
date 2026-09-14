# ROADMAP.md — DripsWave

Last updated: 2026-09-09
Status: Phase 0 complete (scaffolding). Phase 1 not started.

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
**Status: Not started**
**Why first:** everything else depends on real users existing and on the booking concurrency guarantee (ARCHITECTURE.md §5.1) being real, not aspirational.

- [ ] Flesh out `User`, `PatientProfile`, `DoctorProfile`, `FacilityProfile`, `Specialty`, `DoctorSpecialty`, `FacilityCapability` in `schema.prisma` with real fields/relations.
- [ ] Local dev DB via Docker Compose (`infra/docker`).
- [ ] Auth module: signup/login, JWT access+refresh, role middleware.
- [ ] Doctor verification status workflow (admin-gated, manual in v1 per PRD §6.1 FR-3).
- [ ] `AvailabilitySlot` model finalized **with the DB-level constraint/transaction strategy** that prevents double-booking (ARCHITECTURE.md §5.1 / §6.1.1 — this is the single highest-priority correctness item in the whole roadmap).
- [ ] Basic slot generation for a doctor (fixed-length, no recurrence engine — ARCHITECTURE.md §6.3.6).
- [ ] Integration test: two concurrent booking attempts on the same slot — exactly one must succeed.
- [ ] Doc reconciliation: mark resolved hard-questions in PRD §8.1.1 and ARCHITECTURE §6.1.1 if this phase actually closes them.

## Phase 2 — Intake, appointments, consultations
**Status: Not started (blocked by Phase 1)**
- [ ] `IntakeForm` model + structured symptom entry (not free-text-only, per PRD FR-5).
- [ ] Booking flow requires intake before confirmation.
- [ ] `Appointment` lifecycle (`scheduled → completed/cancelled/no_show`).
- [ ] `Consultation` record + outcome (`resolved | referred | follow_up_needed`).
- [ ] Doctor-facing view: today's appointments + intake summary.
- [ ] Patient-facing view: my appointments, my intake history.

## Phase 3 — Referrals
**Status: Not started (blocked by Phase 2)**
- [ ] `Referral` model with **immutable snapshot** of intake + notes (ARCHITECTURE.md §4.4 design note — do not implement as a live pointer).
- [ ] Referral creation from a `Consultation` with outcome `referred`.
- [ ] Patient accept/decline flow (PRD OQ-3 resolved: patient must confirm).
- [ ] Accepted referral auto-generates a pre-populated `Appointment` against the target doctor/specialty — patient does not re-enter intake (PRD FR-8, the core value prop).
- [ ] Routing rule for referrals with no specific `target_doctor_id` (ARCHITECTURE.md §6.1.2 — currently an unresolved design gap; this phase must resolve or explicitly re-scope it).
- [ ] Handle "zero verified doctors in target specialty" edge case (PRD §8.2.2) — surface as "waiting for a specialist," not a silent failure.
- [ ] Referral expiry job (addresses PRD §8.1.3 "orphaned" pattern for referrals specifically).
- [ ] Doc reconciliation: update ARCHITECTURE_ESSENTIALS.md "Known unresolved design gaps" once routing rule + expiry exist.

## Phase 4 — Orders: prescriptions & lab orders
**Status: Not started (blocked by Phase 2, informed by Phase 3)**
- [ ] `Prescription` + `PrescriptionItem` models, **append-only** (issuance creates a row; corrections use `supersedes_prescription_id` — ARCHITECTURE.md §4.5, hard rule in ARCHITECTURE_ESSENTIALS.md).
- [ ] `LabOrder` + `LabResult` models, same append-only rule.
- [ ] Specialist UI: issue prescription/lab order from a consultation.
- [ ] Patient UI: view active/past orders.
- [ ] Order expiry/reminder logic (PRD §8.1.3 "orphaned orders" — general case, beyond referrals).

## Phase 5 — Facilities & fulfillment
**Status: Not started (blocked by Phase 4)**
- [ ] Resolve the polymorphic `FulfillmentRecord` design smell flagged in ARCHITECTURE.md §6.1.3 **before** building this phase — decide: keep polymorphic with constraints, or split into `PrescriptionFulfillment` / `LabOrderFulfillment`. Record the decision as an ADR in `docs/adr/`.
- [ ] Facility account creation (admin-invited only per PRD OQ-2 — no self-serve facility signup in v1).
- [ ] `FacilityCapability` matching: patient sees only qualified facilities for their specific order (PRD FR-13).
- [ ] Facility fulfillment UI: view assigned orders, mark in-progress/fulfilled/rejected.
- [ ] Lab result attachment (object storage integration — ARCHITECTURE.md §2 File/result storage row).
- [ ] Order `status` transitions to `fulfilled` **only** via the facility-confirmed path (ARCHITECTURE.md §5.3 step 5 — patient/doctor cannot self-mark).
- [ ] Address PRD §8.1.6 (facility fulfillment integrity) — at minimum, restrict which facilities can be selected to the curated/admin-invited list; document what's still unresolved if full anti-fraud isn't in scope for v1.

## Phase 5.5 — Payments (consumer side, depends on docforum-escrow existing)
**Status: Not started (blocked by Phase 5, and by `docforum-escrow` publishing an initial `@docforum/escrow-sdk` release)**
- [ ] `PaymentIntent` + `WalletLink` models finalized (relational metadata only — see schema.prisma comment, no PHI).
- [ ] Add `@docforum/escrow-sdk` as a dependency; wire `payments/services` to call it.
- [ ] On order issuance, create a `PaymentIntent` (`created` status).
- [ ] On patient funding action, call SDK to move funds into escrow (`escrowed` status), store `stellarTxHash`.
- [ ] On `FulfillmentRecord` reaching `fulfilled`, trigger SDK release call (`released` status) — this is the actual payoff of ADR 0002, don't let it drift into a manual/admin-triggered release.
- [ ] Refund path for rejected/expired orders.
- [ ] Doc reconciliation: this phase directly addresses PRD §8.1.6 (facility fulfillment integrity) — mark resolved if it lands.

## Phase 6 — Notifications
**Status: Not started (blocked by Phases 3 & 4 at minimum)**
- [ ] `Notification` model + dispatch interface (provider-agnostic, per ARCHITECTURE.md §2).
- [ ] Trigger points per PRD FR-15/FR-16 (booking confirmed, referral created/accepted/declined, order ready, results available, new booking, lab results returned).
- [ ] Pick and integrate a real provider (email/SMS) behind the interface — provider choice is currently undecided (ARCHITECTURE.md §8).

## Phase 7 — Frontend: core flows end-to-end
**Status: Not started (parallelizable with Phases 3–6 once Phase 1/2 APIs exist)**
- [ ] Patient: search doctors by specialty/availability, book, submit intake.
- [ ] Patient: view referral status, accept/decline.
- [ ] Patient: view orders, select fulfilling facility.
- [ ] Doctor: manage availability, view bookings, run consultation, issue referral/orders.
- [ ] Facility: view assigned fulfillment queue, update status, attach results.
- [ ] Shared: auth screens (signup/login per role).

## Phase 8 — Hardening (safety, audit, security)
**Status: Not started**
- [ ] `AuditEvent` table + write path for referral/prescription/lab-order state transitions (ARCHITECTURE.md §6.2.4 — flagged as needed before real patient data).
- [ ] JWT refresh revocation list (ARCHITECTURE.md §6.1.4).
- [ ] Held-slot TTL/release job (ARCHITECTURE.md §6.2.1).
- [ ] Privacy access-control audit: confirm intake/consultation notes are visible only per PRD §7 (patient, treating doctor(s) in-thread, fulfilling facility for that specific order only) — write tests, not just code review.
- [ ] Decide and document what's explicitly out of scope for v1 launch vs. genuinely blocking (e.g., drug-interaction checking, PRD §8.2.8 — needs an explicit go/no-go, not silence).

## Phase 9 — Deploy & CI
**Status: Not started**
- [ ] Choose deployment target (ARCHITECTURE.md §8 open decision) — record as an ADR.
- [ ] Real CI pipeline (replace `.github/workflows/ci.yml` placeholder) — lint, test, build for backend + frontend.
- [ ] Staging environment.
- [ ] Production environment + secrets management.

## Explicitly deferred (not on this roadmap, tracked so they aren't forgotten)
- In-app video/voice consultation (PRD OQ-1 — v1 assumes in-person + async messaging).
- Insurance/billing.
- HL7/FHIR interoperability export.
- Native mobile apps.
- Multi-facility doctor calendars (PRD §8.2.6 / ARCHITECTURE §6.2.3).
- ML-based doctor/symptom matching.

---

## Changelog (append, don't rewrite history)
- 2026-09-09 — Initial roadmap created alongside Phase 0 scaffolding.
