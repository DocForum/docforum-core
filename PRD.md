# PRD.md — DocForum

Status: Draft v0.1
Owner: (unassigned)
Last updated: 2026-09-09

> **Contribution rule:** Any PR that changes scope, models, or phases must update this file (or ROADMAP.md if it's execution-only) in the same PR. See AGENTS.md / CLAUDE.md.

---

## 1. Problem

Patients in hospital settings waste significant time physically waiting: to see a doctor, to discover the doctor they see isn't the right specialist, to get re-referred, and to chase lab/pharmacy results across disconnected systems. There is no single flow that takes a patient from "I have a symptom" to "I have a diagnosis, prescription, and lab results" without repeated in-person queuing at each step.

## 2. Product summary

DocForum is a web/app platform where a patient can:

1. Create an account and log in.
2. Search for doctors by availability and (eventually) specialty/symptom.
3. Book a slot and describe their issue in a structured intake form before the visit.
4. Consult with the doctor (in-app messaging/video, or in-person booking — see Open Questions).
5. If the doctor determines the issue is outside their specialty, the doctor refers the patient in-app to a qualified specialist — the patient does not restart the process from scratch.
6. The specialist consults and can issue a prescription and/or a lab test order.
7. The patient takes that order to a qualified/partnered lab or pharmacy, which fulfills it and reports back into the system.

The core value proposition: **collapse a multi-visit, multi-queue hospital journey into one continuous digital thread**, with referrals and orders following the patient instead of the patient re-explaining themselves at every desk.

## 3. Who it's for (personas)

| Persona | Need |
|---|---|
| **Patient** | Wants to be seen quickly, avoid re-explaining their issue, avoid guessing which specialist to book, and track prescriptions/lab orders in one place. |
| **General/first-contact Doctor** | Needs to triage quickly, refer confidently, and hand off patient context without a phone call or paper note. |
| **Specialist Doctor** | Needs to receive referrals with full context (original complaint + referring doctor's notes), consult, and issue orders. |
| **Lab Technician / Pharmacist** | Needs to receive verified, unambiguous orders tied to a real prescribing doctor and patient, fulfill them, and report results back. |
| **Hospital/Clinic Admin** (implied, not yet a primary persona) | Needs to manage which doctors/labs/pharmacies are on the platform and their availability. |

**Out of scope for v1 personas:** insurance/billing admins, government health record integrators, emergency/ambulance dispatch.

## 4. Core user flows (v1 scope)

1. **Signup/Login** — patient and doctor accounts, separate roles.
2. **Doctor discovery** — search/filter by specialty and available time slots.
3. **Booking + intake** — patient books a slot and submits a structured description of the issue (symptoms, duration, severity — not free-text-only, to support future triage).
4. **Consultation record** — doctor views intake, conducts consultation (channel TBD — see Open Questions), writes consultation notes.
5. **Referral** — doctor marks the consult as "out of scope," selects a specialty (or a specific specialist), attaches notes, and the referral becomes a new bookable item in the specialist's queue **without the patient re-entering intake data**.
6. **Specialist consultation** — specialist sees original intake + referring doctor's notes, consults, and can issue:
   - a **prescription** (medication list, dosage, duration), and/or
   - a **lab order** (test type, urgency, notes).
7. **Fulfillment routing** — patient sees a list of qualified/partnered labs and pharmacies that can fulfill their specific order and can select one.
8. **Fulfillment closure** — lab/pharmacy marks the order fulfilled and (for labs) can attach results, which become visible to the patient and the ordering doctor.

## 5. Explicit non-goals (v1)

- Real-time video/audio consultation infrastructure (evaluate build-vs-buy; not core IP).
- Insurance claims processing or billing.
- Full EHR/EMR interoperability (HL7/FHIR export) — noted as a future integration point, not a v1 requirement.
- Emergency/triage-critical routing (this is *not* a replacement for emergency services).
- Multi-country regulatory compliance (HIPAA, NDPR, GDPR) — architecture should not preclude it, but full compliance program is a separate workstream.
- Native mobile apps (v1 is responsive web; native wrapper is a later phase).

## 6. Functional requirements

### 6.1 Identity & access
- FR-1: Patients and Doctors are distinct roles with distinct capabilities; a Lab and Pharmacy are facility accounts, not individual "doctor" accounts.
- FR-2: A doctor has one or more specialties; specialty is a controlled vocabulary, not free text.
- FR-3: Only verified doctors can appear in search results (verification workflow is manual/admin-gated in v1).

### 6.2 Discovery & booking
- FR-4: Patients can search doctors by specialty and see real availability (no double-booking).
- FR-5: A booking requires a structured intake payload before confirmation.

### 6.3 Consultation & referral
- FR-6: A doctor can close a consultation with one of: **resolved**, **referred**, **needs follow-up**.
- FR-7: A referral must carry forward: original intake, consultation notes, referring doctor identity, and target specialty (specific doctor optional).
- FR-8: A referred patient's new booking is pre-populated; the patient is not asked to re-enter the same intake data.
- FR-9: A referral has a status lifecycle: `pending → accepted → completed` (or `declined`, see Hard Questions).

### 6.4 Orders (prescriptions & labs)
- FR-10: A prescription is structured (drug, dosage, frequency, duration) — not a free-text note — so it can be read unambiguously by a pharmacy.
- FR-11: A lab order specifies test type(s) and urgency.
- FR-12: Every order is tied to exactly one prescribing doctor and one patient and is immutable once issued (corrections create a new version, not an edit — see Architecture).
- FR-13: Patients can view a list of facilities (lab/pharmacy) qualified to fulfill their specific order type.
- FR-14: Facilities can mark an order `fulfilled` and, for labs, attach a result.

### 6.5 Notifications
- FR-15: Patient is notified on: booking confirmed, referral created, order ready for fulfillment, results available.
- FR-16: Doctor is notified on: new booking, referral accepted/declined, lab results returned.

## 7. Non-functional requirements

- **Auditability**: every state transition on a referral, prescription, or lab order must be attributable (who, when) — this is health data.
- **Data integrity over convenience**: orders are append-only/versioned, not mutable, for legal/clinical safety.
- **Availability correctness**: double-booking a doctor's slot is a P0 bug class, not a minor bug.
- **Privacy**: patient intake and consultation notes are only visible to the patient, the treating doctor(s) in that care thread, and the fulfilling facility for the specific order (not the whole record).
- **Latency**: search/booking flows should feel instant (<300ms server response for read paths) — not a hard SLA yet, just a design constraint.

## 8. Hard questions (must stay answered or explicitly deferred — do not silently drop)

### 8.1 What do we think would break?
1. **Double-booking under concurrency** — two patients booking the same slot simultaneously without a locking/transaction strategy at the DB level. This is the single most likely v1 bug class. **Resolved 2026-09-14:** `availability/repositories.ts`'s `claimOpenSlot` (a conditional `UPDATE ... WHERE status = 'open'`) makes this a DB-level guarantee, not an app-logic one. Proven by `backend/tests/integration/booking.test.mts` — 8 genuinely concurrent booking requests on the same slot, exactly 1 succeeds, verified against a real Postgres instance every run.
2. **Referral loops** — Doctor A refers to specialty B, specialist in B refers back to A or sideways to C, with no cycle detection or max-hop limit → patient stuck in a referral loop with no human-visible "this isn't working" signal. **Resolved 2026-10-17 (Phase 3, issue #65):** every referral carries a lineage (`parent_referral_id`, derived consultation → appointment → referral), the creation transaction walks that chain with a bounded CTE (default `REFERRAL_MAX_HOPS = 4`), and a target doctor or specialty that already appears **anywhere** in the chain — including the original referring GP — is *flagged* (`loop_flagged_at`/`loop_flag_reason`) and surfaced in the admin queue rather than silently allowed or hard-blocked (a human decides whether the repeat is clinically legitimate). Self-referral and hop-limit overflow are hard `422` rejections. Unit-tested (`tests/unit/referral-loop.test.ts`) and integration-tested end-to-end (`tests/integration/referral-loops.test.mts`).
3. **Orphaned orders** — a prescription/lab order issued, but the patient never selects a fulfilling facility, and there is no reminder/expiry logic → orders silently rot. **Referral half partly addressed 2026-10-17 (issue #67):** repeated no-shows on a referral-origin appointment now expire the referral and flag the referring doctor. **Still open:** time-based expiry (a pending referral nobody accepts, a held slot nobody books, and orders generally) has no job yet — issues #8 and #19; orders themselves stay Phase 4.
4. **Referral context loss** — if referral doesn't strictly carry forward intake + notes (FR-7/FR-8 not enforced at the data layer), the whole value proposition (no re-explaining) quietly breaks and nobody notices until a patient complains. **Notes half resolved 2026-10-17 (issue #5):** `Referral.snapshotNotes` is a copy written in the creation transaction and there is no consultation-editing path that could reach it; acceptance re-books through the real slot-claim path carrying the same snapshot, so no re-intake happens. The **intake** half is not enforceable yet — `IntakeForm` doesn't exist (issue #1) and `Referral.snapshotIntakeId` is deliberately absent rather than faked. Flagged, not dropped.
5. **Specialty mismatch at signup** — doctors self-select specialty with no verification → patients get referred into a specialty the doctor doesn't actually practice.
6. **Facility fulfillment integrity** — nothing currently stops a facility from marking an order "fulfilled" without actually doing the work, or a patient walking into an unqualified/non-partnered facility with a screenshot of an order.

### 8.2 What edge cases are we missing?
1. Patient has **no matching specialist available** (none online / none accepting new patients) after a referral — what happens? **Narrowed twice, still open (2026-10-17; 2026-10-21 with issue #6).** With routing at creation (ADR 0008), "nobody exists in this specialty" is caught *before* a referral exists — the referring doctor gets `422 REFERRAL_NO_ELIGIBLE_TARGET` instead of handing the patient an orphan. The remaining dead end is "the routed/named doctor never offers a slot": the referral sits `pending` until issue #8's time-based expiry or an admin in the queue (#68) finds it. Routing deliberately does **not** filter on open slots, so this is not closed by the routing rule.
2. Doctor **refers to a specialty with zero verified doctors on the platform** — dead end. **Resolved at the point of referral, 2026-10-21 (Phase 3, issue #6 — `docs/adr/0008-referral-routing-without-target-doctor.md`):** a specialty-only referral is routed at creation to the least-loaded eligible doctor; when no verified doctor holds the specialty, the creation fails with `422 REFERRAL_NO_ELIGIBLE_TARGET` and **no referral row is written**, so the patient is never handed a referral with no owner. The distinct patient-facing "waiting for a specialist" state that issue #5's DoD asked for is *still not built* — it requires a referral to exist before it has a target, which the ADR deliberately rejects; that stays a known gap, not a silent substitution.
3. Patient **cancels or no-shows** after a referral was already created downstream. **Resolved 2026-10-17 (issue #67):** the appointment status transition and the referral state change happen in one transaction, so a referral can never be left `accepted` behind a dead appointment. Cancelled → referral returns to `pending` (slot released, re-bookable, same snapshot); first no-show → `pending` with `noShowCount = 1`; second no-show → `expired` with `referring_doctor_notified_at` set (threshold is a deliberately boring default, not a tuned one). Every write is conditional on the referral still pointing at that appointment, so a doubled hook is a no-op — integration-tested in `tests/integration/referral-cascade.test.mts`.
4. **Multiple simultaneous referrals** — can a single consultation spawn more than one referral (e.g., "see both cardiology and endocrinology")? **Resolved 2026-10-17 (issue #66, decision recorded in `docs/adr/0006-multiple-referrals-per-consultation.md`):** yes — an atomic all-or-none batch (`POST /referrals/from-consultation/:consultationId`, equivalently `POST /consultations/:id/referrals`) whose referrals then live **independently** (accept/decline each on its own; no bundle lifecycle). Duplicate doctor *or* specialty within a batch, or against a referral already made from that consultation, fails the whole batch. Each target gets its own snapshot copy, and `GET /referrals/mine` groups them by source consultation for the patient's "one visit, several referrals" view.
5. **Minor/dependent patients** — booking on behalf of a child or dependent; consent and account ownership model undefined. **Resolved (re-scoped) 2026-10-17, issue #42 — `docs/adr/0011`:** dependents are guardian-owned patient profiles with no login, created (never linked) by a patient guardian; the guardian can list them, book for them and see their appointments; access ends automatically at the age of majority (configurable, default 18) and the history stays with the dependent's own profile. Still open, by design: verifying guardianship beyond self-assertion, the at-majority account-claim flow, and any care a guardian shouldn't see before majority (jurisdiction-specific consent).
6. **Doctor moonlighting across facilities** — same doctor, multiple hospitals/clinics, different availability per location — v1 assumes one doctor = one availability calendar, which may be wrong.
7. **Lab result requiring urgent follow-up** — abnormal result with no automatic escalation path back to a doctor.
8. **Prescription drug interaction** — no interaction/allergy checking in v1; is that acceptable to ship, or a blocking safety requirement?
9. **Time zone handling** for availability if the platform ever spans regions.

### 8.3 What's overengineered (for v1)?
1. **Building in-app video/voice infra from scratch** — should almost certainly be a third-party embed (Twilio/Daily/Agora) or even deferred to phone/in-person for v1, not custom WebRTC.
2. **Full HL7/FHIR interoperability** — premature; a simple internal schema that *could* map to FHIR later is enough now.
3. **Recommendation/ranking algorithms for "best doctor for your symptom"** — v1 needs correct specialty-based search, not ML matching.
4. **Multi-tenant hospital-admin console with granular RBAC** — v1 needs three roles (patient, doctor, facility) done well, not a configurable permissions matrix.
5. **Real-time chat infrastructure with delivery receipts/typing indicators** — a simple threaded message log per consultation is enough to start.
6. **Building a custom scheduling/calendar engine with recurrence rules, buffers, etc.** — start with fixed-length slot generation; recurrence and smart buffering is a v2 problem.

## 9. Open questions (block v1 decisions, need answers before/while building)

- OQ-1: Is the doctor-patient "consultation" in-app (chat/video) or does the app only manage scheduling/records while the consult happens in person? This materially changes scope (see 8.3.1). **Assume in-person + async messaging for v1 unless overridden.**
- OQ-2: Who can create Lab/Pharmacy facility accounts — self-serve signup or admin-invited only? **Assume admin-invited (curated partner list) for v1** to protect FR-13/8.1.6.
- OQ-3: Does a referral require patient consent/acceptance before it books, or is it automatic? **Assume patient must confirm** (aligns with FR-9 `pending → accepted`).
- OQ-4: Payment — is this free, insurance-billed, or paid per consultation? **Out of scope for v1**, but data model should not preclude adding a `payment_status` later.

## 10. Success metrics (draft — revisit once instrumented)

- Time from "patient opens app with symptom" to "patient has a prescription or lab order" (target: reduce vs. baseline in-person path).
- Referral completion rate (% of referrals that reach `completed`, not abandoned).
- % of orders fulfilled within N days of issuance.
- Doctor no-show / patient no-show rate.

## 11. Phased scope pointer

See `ROADMAP.md` for the phase breakdown and current status. This PRD defines *what*; ROADMAP.md defines *when/in what order*.
