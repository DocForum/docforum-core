# ROADMAP.md — DocForum

Last updated: 2026-10-21
Status: Phase 0, Phase 1, and Phase 5.5 (Payments, custodial v1 — see
`docs/adr/0004-custodial-payments-v1.md`) built and tested. Phase 3
(Referrals) is **in progress**: #5, #7 and #65–#68 implemented and
tested on branch `feat/referral-phase3-cascade-multi-loop-admin`, #6 and
#8 open. Phase 2 is partially unblocked by that work (#3/#4 minimal
slices). Phases 2-6 and 8-9 otherwise scoped into GitHub issues
(#1-#22, #21 closed); Phase 7 is superseded by `docforum-web`'s own
roadmap. See each phase section below for status and issue links.

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
- [ ] Local dev DB via Docker Compose (`infra/docker`) — **file written, not exercised.** Verification tracked as [issue #27](https://github.com/DocForum/docforum-core/issues/27) (Trivial, 100 pts). No Docker in the environment this was built in, so the backend was developed and tested against a locally-installed Postgres (via the `embedded-postgres` devDependency — a prebuilt binary, not compiled) instead. The compose file matches `backend/.env.example`'s credentials but hasn't itself been run. See `infra/docker/README.md`.
- [x] Auth module: signup/login, JWT access+refresh, role middleware. `POST /auth/signup` rejects `role: 'facility'`/`'admin'` server-side (PRD OQ-2), not just in docforum-web's UI. Refresh token travels as an httpOnly cookie — see `docs/api/README.md` for the local-dev-only cookie caveat (cross-origin `sameSite`/`secure` not verified end-to-end).
- [x] Doctor verification status workflow (admin-gated, manual in v1 per PRD §6.1 FR-3). `PATCH /doctors/:id/verification`, admin-only.
- [x] `AvailabilitySlot` model finalized **with the DB-level constraint/transaction strategy** that prevents double-booking (ARCHITECTURE.md §5.1 / §6.1.1 — this is the single highest-priority correctness item in the whole roadmap). **Resolved, not just implemented** — see the integration test below.
- [x] Basic slot generation for a doctor (fixed-length, no recurrence engine — ARCHITECTURE.md §6.3.6). `POST /availability/doctors/:id/slots/generate`, idempotent re-runs.
- [x] Integration test: two concurrent booking attempts on the same slot — exactly one must succeed. `backend/tests/integration/booking.test.mts` — 8 genuinely concurrent requests via `Promise.all`, self-contained (spins up its own throwaway Postgres, no pre-existing DB needed), passing. Also manually verified end-to-end via a full curl walkthrough (signup → generate slots → book → second booking attempt correctly gets `409`).
- [x] Doc reconciliation: PRD §8.1.1 and ARCHITECTURE §6.1.1 marked resolved in place.

## Phase 2 — Intake, appointments, consultations
**Status: In progress — issues #3 and #4 carry a minimal slice landed as Phase 3's prerequisite; intake (#1/#2) and discovery (#23) still Not started. Scoped into issues #1–#4 and #23.**
- [ ] `IntakeForm` model + structured symptom entry (not free-text-only, per PRD FR-5). Tracked as [issue #1](https://github.com/DocForum/docforum-core/issues/1) (Medium, 150 pts).
- [ ] Booking flow requires intake before confirmation. Tracked as [issue #2](https://github.com/DocForum/docforum-core/issues/2) (Medium, 150 pts) — depends on #1.
- [ ] `Appointment` lifecycle (`scheduled → completed/cancelled/no_show`) + doctor's today view. Tracked as [issue #3](https://github.com/DocForum/docforum-core/issues/3) (Medium, 150 pts) — **partially done** as part of Phase 3's referral work: `PATCH /appointments/:id/status` (treating doctor only) and `PATCH /appointments/:id/cancel` (patient, own appointment), with slot release on cancellation and the referral cascade hook. Remaining: the doctor's today view and any admin-on-behalf transition.
- [ ] `Consultation` record + outcome (`resolved | referred | follow_up_needed`). Tracked as [issue #4](https://github.com/DocForum/docforum-core/issues/4) (High, 200 pts) — **minimal slice done** for Phase 3: `POST /consultations` against one's own completed appointment (one per appointment), `GET /consultations/:id` scoped to that doctor + the patient. Remaining: sign-off, addenda / post-hoc note editing.
- [ ] Doctor discovery: specialty catalog, doctor ↔ specialty assignment, public `GET /doctors?specialty=` (verified doctors only). Nothing in `backend/src` touched `Specialty`/`DoctorSpecialty` before this; `docforum-web` issue #1 depends on it. Tracked as [issue #23](https://github.com/DocForum/docforum-core/issues/23) (Medium, 150 pts).
- [ ] Patient-facing view: my intake history. Not yet split into its own issue — small enough to fold into whichever of the above lands last, or split out later if it grows.

## Phase 3 — Referrals
**Status: In progress — issues #5, #7 and #65–#68 are implemented and tested (unit + 5 self-contained integration suites); #6 (routing ADR) and #8 (time-based expiry job) remain open. Original scope was #5–#8; #65–#68 were opened later against the same phase for loop detection, multi-referral, cascade and admin overrides.**
- [x] `Referral` model with **immutable snapshot** of intake + notes (ARCHITECTURE.md §4.4 design note — do not implement as a live pointer), plus the "zero verified doctors in target specialty" edge case (PRD §8.2.2). Tracked as [issue #5](https://github.com/DocForum/docforum-core/issues/5) (Medium, 150 pts) — **done with two flagged deviations for review**: (a) `snapshot_notes` is a real copy written in the creation transaction and unreachable by any consultation-edit path, but `snapshotIntakeId` has no column because `IntakeForm` doesn't exist yet (issue #1) — the intake half of the snapshot is not yet enforceable; (b) the zero-verified-doctors case is **unreachable by construction** rather than surfaced as the distinct "waiting for a specialist" state the DoD asked for — v1 requires a concrete verified `target_doctor_id` (see #6 below). Creation is an explicit `POST /referrals` from a consultation rather than an implicit trigger on outcome `referred`; the outcome still records intent and the API enforces a completed appointment.
- [x] Referral creation from a `Consultation` with outcome `referred` — folded into issue #5 above.
- [ ] Routing rule for referrals with no specific `target_doctor_id` (ARCHITECTURE.md §6.1.2 — currently an unresolved design gap; this phase must resolve or explicitly re-scope it). Tracked as [issue #6](https://github.com/DocForum/docforum-core/issues/6) (High, 200 pts) — an ADR. **Explicitly re-scoped, not resolved:** `target_doctor_id` is required in v1 so unassigned referrals cannot exist; the ADR for specialty-only routing (and the "waiting for a specialist" state it would unlock) is still owed, and the gap stays open until it lands.
- [x] Patient accept/decline flow (PRD OQ-3 resolved: patient must confirm). Tracked as [issue #7](https://github.com/DocForum/docforum-core/issues/7) (Medium, 150 pts) — depends on #5. **Done:** `POST /referrals/:id/accept` (conditional `pending → accepted`, one winner under concurrency) and `POST /referrals/:id/decline` (pending-only, terminal).
- [x] Accepted referral auto-generates a pre-populated `Appointment` against the target doctor/specialty — patient does not re-enter intake (PRD FR-8, the core value prop) — folded into issue #7 above. **Done:** accept books through `appointments`' `bookForReferral` → the same `claimOpenSlot` conditional UPDATE as a direct booking (`origin: 'referral'`), with the slot belonging to the target doctor enforced; no shortcut writes an `Appointment` row.
- [ ] Referral expiry job (addresses PRD §8.1.3 "orphaned" pattern for referrals specifically). Tracked as [issue #8](https://github.com/DocForum/docforum-core/issues/8) (Medium, 150 pts) — depends on #5. **Still open:** only the no-show-driven path reaches `expired` (issue #67 below); nothing expires a referral by age, so an accepted-never / ignored referral needs an admin to find it in the queue.
- [x] Referral loop detection + max-hop limit (PRD §8.1.2). Tracked as [issue #65](https://github.com/DocForum/docforum-core/issues/65) (High, 200 pts). **Done:** lineage via `parent_referral_id`, bounded CTE walk, strict rule (repeat doctor/specialty anywhere in the chain — including the GP return — flags for the admin queue), hard `422` on self-referral and on chains over `REFERRAL_MAX_HOPS` (default 4).
- [x] Multiple simultaneous referrals from one consultation (PRD §8.2.4). Tracked as [issue #66](https://github.com/DocForum/docforum-core/issues/66) (High, 200 pts). **Done, including its ADR:** [`docs/adr/0006-multiple-referrals-per-consultation.md`](docs/adr/0006-multiple-referrals-per-consultation.md) records the decision (allowed; independent lifecycles, atomic all-or-none creation, grouped only for the patient view; no bundle table). Implementation: one snapshot copy per target, duplicate-specialty/doctor rejection, independent per-referral acceptance, patient list grouped by source consultation.
- [x] Cascade rules when a referral-origin appointment is cancelled or no-shows (PRD §8.2.3). Tracked as [issue #67](https://github.com/DocForum/docforum-core/issues/67) (High, 200 pts). **Done:** run inside the appointment's status transaction; cancelled → referral back to `pending` with the slot released, first no-show → `pending` + `noShowCount`, second → `expired` + `referringDoctorNotifiedAt` (threshold is a v1 default, not a tuned value); all writes conditional so a doubled hook no-ops.
- [x] Admin referral operations: queue, reassign stuck referrals, override routing, audited. Tracked as [issue #68](https://github.com/DocForum/docforum-core/issues/68) (Medium, 150 pts). **Done:** `GET /referrals/admin/queue` (status / `olderThan` / `loopFlagged` filters, derived reason + age), `POST /referrals/admin/:id/reassign` (pending only, target column only — snapshot untouched), `POST /referrals/admin/:id/cancel` (closes a live appointment through the appointments service), `GET /referrals/admin/:id/audit-events`; reassign/cancel write the first `AuditEvent` rows (new table — ARCHITECTURE.md §4.10).
- [x] Doc reconciliation: ARCHITECTURE.md §4.2/§4.3/§4.4/§4.10/§5.2/§6, ARCHITECTURE_ESSENTIALS.md data model map + known gaps, PRD §8.1.2/§8.1.3/§8.1.4/§8.2.1–§8.2.4, `docs/api/README.md`. Done in this change — #6's ADR is *not* part of it and the gap is deliberately left noted.

## Phase 4 — Orders: prescriptions & lab orders
**Status: Partially implemented by issues #9 and #85; remaining issue work is tracked in #10–#12.**
- [ ] `Prescription` + `PrescriptionItem` models, **append-only** (issuance creates a row; corrections use `supersedes_prescription_id` — ARCHITECTURE.md §4.5, hard rule in ARCHITECTURE_ESSENTIALS.md). Tracked as [issue #9](https://github.com/DocForum/docforum-core/issues/9) (High, 200 pts), which also covers `LabOrder`/`LabResult` (same append-only rule).
- [ ] `LabOrder` + `LabResult` models, same append-only rule — folded into issue #9 above.
- [ ] Specialist UI: issue prescription/lab order from a consultation. Tracked as [issue #10](https://github.com/DocForum/docforum-core/issues/10) (Medium, 150 pts) — depends on #9.
- [ ] Patient UI: view active/past orders. Tracked as [issue #11](https://github.com/DocForum/docforum-core/issues/11) (Medium, 150 pts) — depends on #9.
- [ ] Order expiry/reminder logic (PRD §8.1.3 "orphaned orders" — general case, beyond referrals). Tracked as [issue #12](https://github.com/DocForum/docforum-core/issues/12) (Medium, 150 pts) — depends on #9.

## Phase 5 — Facilities & fulfillment
**Status: Not started (blocked by Phase 4). Scoped into issues #13–#16.**
- [ ] Resolve the polymorphic `FulfillmentRecord` design smell flagged in ARCHITECTURE.md §6.1.3 **before** building this phase — decide: keep polymorphic with constraints, or split into `PrescriptionFulfillment` / `LabOrderFulfillment`. Record the decision as an ADR in `docs/adr/`. Tracked as [issue #13](https://github.com/DocForum/docforum-core/issues/13) (High, 200 pts) — the prerequisite for the rest of this phase.
- [ ] Facility account creation (admin-invited only per PRD OQ-2 — no self-serve facility signup in v1) + `FacilityCapability` matching (patient sees only qualified facilities for their specific order, PRD FR-13). Tracked as [issue #14](https://github.com/DocForum/docforum-core/issues/14) (Medium, 150 pts) — depends on #13.
- [ ] Facility fulfillment UI: view assigned orders, mark in-progress/fulfilled/rejected, enforcing that `status` transitions to `fulfilled` **only** via the facility-confirmed path (ARCHITECTURE.md §5.3 step 5 — patient/doctor cannot self-mark). Tracked as [issue #15](https://github.com/DocForum/docforum-core/issues/15) (Medium, 150 pts) — depends on #13/#14.
- [ ] Lab result attachment (object storage integration — ARCHITECTURE.md §2 File/result storage row). Tracked as [issue #16](https://github.com/DocForum/docforum-core/issues/16) (Medium, 150 pts) — depends on #13.
- [ ] Address PRD §8.1.6 (facility fulfillment integrity) — at minimum, restrict which facilities can be selected to the curated/admin-invited list; document what's still unresolved if full anti-fraud isn't in scope for v1 — addressed by issue #14's admin-only gating; document any remaining gap in that issue's PR.

## Phase 5.5 — Payments (consumer side)
**Status: Payment order linkage, automatic intent issuance, configuration hardening, and platform signer abstraction are implemented; fulfillment-triggered release remains pending.** See docs/adr/0004-custodial-payments-v1.md. Verified against **live testnet**, not mocked — `npm run test:integration:payments-testnet` (3/3 passing): fund→release, fund→refund, and reject-when-no-wallet-linked.
- [x] `PaymentIntent` + `WalletLink` models finalized (relational metadata only — no PHI). `WalletLink` scoped to the **facility** (payee), not the patient — see ADR 0004. Amount is raw stroops (`BigInt`), not the originally-scaffolded `Decimal`+`"USDC"` — matches what's actually proven end-to-end on testnet; multi-asset support is future work, not assumed.
- [x] Added `@docforum/escrow-sdk` as a real dependency (via the GitHub Release tarball URL — see `docforum-escrow`'s ADR 0003); wired `payments/services` to call it through a dynamic `import()` (`escrow-sdk-loader.ts` — the SDK is ESM-only, this backend is CommonJS).
- [x] On order issuance, create a `PaymentIntent` (`created` status) automatically with a typed order FK. Manual intent creation was removed. Corrections move created intents; funded intents remain attached to the immutable original.
- [x] [Issue #88] Harden payments configuration: typed network/RPC/contract/asset settings, mainnet opt-in guard, startup reachability check, and intent-recorded contract ids for release/refund.
- [x] Soroban contract-event poller, per-deployment persisted cursors, unmatched release/refund alerts, and admin event view (issue #86). Contract deployments must include their deployment ledger; RPC retention gaps are surfaced for operator reconciliation.
- [x] On patient funding action, call SDK to move funds into escrow (`escrowed` status), store `stellarTxHash` — except it's not a *patient* action in this design (custodial v1, ADR 0004): `POST /payments/intents/:id/fund`, admin-triggered, funds from `docforum-core`'s own platform payer identity.
- [x] On `FulfillmentRecord` reaching `fulfilled`, trigger SDK release call (`released` status) — except there's no `FulfillmentRecord` yet (Phase 5), so v1 exposes `POST /payments/intents/:id/release` as an admin-triggered action instead. ADR 0002's "don't let it drift into a manual/admin-triggered release" goal is **not yet met** — this is the honest interim, not the destination; revisit once Phase 5 exists.
- [x] Refund path for rejected/expired orders — `POST /payments/intents/:id/refund`, same admin-triggered caveat as release.
- [ ] Idempotent escrow funding + on-chain reconcile job (`fundPaymentIntent` is check-then-act — docforum-escrow threat model §5). Tracked as [issue #24](https://github.com/DocForum/docforum-core/issues/24) (High, 200 pts).
- [ ] ADR: releaser key custody — multisig, KMS, or per-period rotation (threat model T1/T2). Tracked as [issue #25](https://github.com/DocForum/docforum-core/issues/25) (Medium, 150 pts).
- [ ] Checksum-validate facility wallet keys, not just regex. Tracked as [issue #26](https://github.com/DocForum/docforum-core/issues/26) (Trivial, 100 pts).
- [ ] Non-custodial patient payments (v2): patients fund escrows from their own Stellar wallet, custodial kept as fallback. **Proposed** in `docs/adr/0005-non-custodial-patient-payments.md`; implementation issues to be opened once it's Accepted.
- [ ] Upgrade to `@docforum/escrow-sdk` 0.3.0 and the current testnet contract (`refund_after`, balance-delta check, `getEscrow`) — step 1 of ADR 0005's plan, but worth doing regardless. Tracked as [issue #32](https://github.com/DocForum/docforum-core/issues/32) (Medium, 150 pts); depends on `docforum-escrow` publishing `sdk-v0.3.0`.
- [ ] Doc reconciliation: PRD §8.1.6 (facility fulfillment integrity) — not marked resolved; this phase proves the payment *mechanism* works, not the fulfillment-integrity question, which still needs real `FulfillmentRecord`/facility-matching (Phase 5) to actually address.

## Phase 6 — Notifications
**Status: Not started. Provider decision scoped into issue #17; trigger-point build-out blocked by Phases 3 & 4 and deliberately left unscoped until those land.**
- [ ] `Notification` model + dispatch interface (provider-agnostic, per ARCHITECTURE.md §2) — part of the trigger-point work, still blocked.
- [ ] Trigger points per PRD FR-15/FR-16 (booking confirmed, referral created/accepted/declined, order ready, results available, new booking, lab results returned) — still blocked by Phases 3/4.
- [ ] Pick and integrate a real provider (email/SMS) behind the interface — provider choice is currently undecided (ARCHITECTURE.md §8). Tracked as [issue #17](https://github.com/DocForum/docforum-core/issues/17) (Trivial, 100 pts) — a decision task, unblocked now.

## Phase 7 — Frontend: core flows end-to-end
**Status: Superseded.** This phase predates the 3-repo org split (see the org note at the top of this file) — all frontend work described below is actually tracked in `docforum-web`'s own `ROADMAP.md` (Phases W2–W5, issues opened there). Left in place as a historical record rather than deleted, but no issues are or will be opened against it here.
- [ ] ~~Patient: search doctors by specialty/availability, book, submit intake.~~ → `docforum-web` Phase W2.
- [ ] ~~Patient: view referral status, accept/decline.~~ → `docforum-web` Phase W2.
- [ ] ~~Patient: view orders, select fulfilling facility.~~ → `docforum-web` Phase W2.
- [ ] ~~Doctor: manage availability, view bookings, run consultation, issue referral/orders.~~ → `docforum-web` Phase W3.
- [ ] ~~Facility: view assigned fulfillment queue, update status, attach results.~~ → `docforum-web` Phase W4.
- [ ] ~~Shared: auth screens (signup/login per role).~~ → already built, `docforum-web` Phase W1.

## Phase 8 — Hardening (safety, audit, security)
**Status: In progress. In addition to the original five items (#18–#20 scoped, two still blocked), four auth-hardening items are scoped as #34, #35, #37 and #39 — #34 and #35 are merged; #37 and #39 are open PRs. An access-control test suite (#44) is built and tested. Each is independent of the others and of Phases 3–7, and each carries its own schema/doc updates.**

- [x] Email verification on signup, with restricted access for unverified accounts. `User.emailVerifiedAt` + `EmailVerificationToken` (hashed, expiring, single-use), `POST /auth/verify-email`, `POST /auth/verify-email/resend`, and a `requireVerifiedEmail` guard on booking + payment mutations (never on login/browsing). Migration backfills existing rows as verified. Tracked as [issue #34](https://github.com/DocForum/docforum-core/issues/34) (High, 200 pts) — **Done**, merged as PR #137. Found a real dependency while building it: the email *provider* is still an open decision (Phase 6, issue #17), so links can't be delivered on a hosted deployment yet — see `backend/src/modules/auth/services/email-dispatcher.ts` and ARCHITECTURE.md §6.1.5.
- [x] Login brute-force protection: per-account and per-IP throttling with backoff. Postgres-backed buckets (`LoginAttempt`), a single conditional upsert so concurrent failures are counted atomically, exponential backoff with `Retry-After`, a bounded temporary lock, an admin clear endpoint, a prune interval in `src/server.ts`, and a `TRUST_PROXY` setting so the IP isn't Render's proxy address. Tracked as [issue #35](https://github.com/DocForum/docforum-core/issues/35) (High, 200 pts) — **Done**, merged as PR #138.
- [ ] CSRF protection for the cookie-authenticated refresh/logout endpoints, plus an explicit per-environment CORS allowlist. A per-session CSRF token bound into the refresh token (not a double-submit cookie — a cookie set by this API is third-party to `docforum.github.io`, so the web client can't read it), a required `X-CSRF-Token` header on `/auth/refresh` + `/auth/logout`, an `Origin` allowlist check, and `CORS_ORIGINS` replacing the single configured origin. Tracked as [issue #37](https://github.com/DocForum/docforum-core/issues/37) (High, 200 pts) — **in progress**, branch `feat/csrf-protection-for-cookie-authenticated-refresh`.
- [ ] Admin account lifecycle: secure bootstrap CLI, admin invites, and account deactivation. Tracked as [issue #39](https://github.com/DocForum/docforum-core/issues/39) (High, 200 pts) — **in progress**.
- [ ] Patient data export (right of access) as a complete, machine-readable bundle. `POST /patients/me/export` + `GET /patients/me/export/:id` (+ `/download`), owner-only; an exporter registry where each module contributes its own section through its service (ARCHITECTURE.md §3.1 — `account`, `profile`, `appointments`, `payments` today); versioned JSON with `generatedAt`; generated by an interval worker in `src/jobs/patient-exports.ts` and stored as bounded chunks in Postgres (`PatientExport`/`PatientExportChunk`, §4.11 — no object-storage provider exists yet, see §6.3.4); expiry + cleanup after `PATIENT_EXPORT_TTL_HOURS`. Tracked as [issue #40](https://github.com/DocForum/docforum-core/issues/40) (High, 200 pts) — **in review**, branch `feat/40-patient-data-export`. Later modules (referrals, prescriptions, lab orders) must register their own section when they land; a verified guardian exporting a dependent's data is left to issue #42's model.
- [ ] `AuditEvent` table and write path — **foundation done, Phase 3/4 wiring pending.** Append-only `AuditEvent` (DB triggers reject UPDATE/DELETE/TRUNCATE), `auditService.record()` that must run inside the state change's own transaction, request ids on every response, and `GET /admin/audit-events` (entity/actor/date filters, keyset cursor). Wired into appointment booking (both the direct and the referral-origin path), doctor verification, payment fund/release/refund, the patient's referral accept/decline and the referral admin actions (`referral.reassign` / `referral.cancel`, Phase 3 issue #68 — recorded as `entityType: 'Referral'` rows in this one table, not a second referral-specific table). Still unaudited: the referral's *creation* and the cascade-driven `completed`/`expired` transitions (no actor to attribute them to), the remaining Phase 4 order transitions, and the login-throttle admin clear (console-only). Tracked as [issue #43](https://github.com/DocForum/docforum-core/issues/43) (High, 200 pts) — **in review**, branch `feat/43-auditevent-foundation`.
- [ ] JWT refresh revocation list (ARCHITECTURE.md §6.1.4). Tracked as [issue #18](https://github.com/DocForum/docforum-core/issues/18) (Medium, 150 pts) — unblocked now, operates on Phase 1's auth module.
- [ ] Held-slot TTL/release job (ARCHITECTURE.md §6.2.1). Tracked as [issue #19](https://github.com/DocForum/docforum-core/issues/19) (Medium, 150 pts) — unblocked now, operates on Phase 1's `AvailabilitySlot`.
- [x] Access-control test suite: who may read intake, consultation and payment data. Integration tests (`tests/integration/access-control.test.mts`) establishing the test harness and access-control patterns for the three PHI data categories; intake/consultation test cases are scaffolded as placeholders until Phase 2/3 routes exist, payment-intent access cases exercise the live admin-gated routes. Tracked as [issue #44](https://github.com/DocForum/docforum-core/issues/44) — **Done**.
- [ ] Privacy access-control audit: confirm intake/consultation notes are visible only per PRD §7 (patient, treating doctor(s) in-thread, fulfilling facility for that specific order only) — write tests, not just code review. Still blocked — meaningfully auditable only once Phase 3/4/5 access paths exist. **One Phase 3 access path is now worth auditing (`GET /consultations/:id` — treating doctor + that appointment's patient only, and referral snapshot exposure on `GET /referrals/mine` / `/created`), but intake and orders remain unbuilt, so the audit as scoped stays blocked.** Not yet scoped into an issue.
- [ ] Decide and document what's explicitly out of scope for v1 launch vs. genuinely blocking (e.g., drug-interaction checking, PRD §8.2.8 — needs an explicit go/no-go, not silence). Tracked as [issue #20](https://github.com/DocForum/docforum-core/issues/20) (Trivial, 100 pts) — a decision task, unblocked now.

## Phase 9 — Deploy & CI
**Status: In progress. A Render free-tier preview exists — see note. Automated Postgres backups with a tested restore drill are now implemented (issue #30). Remaining items scoped into issues #21–#22.**
- [x] **PR malware scan** — `.github/workflows/pr-malware-scan.yml` + `.github/scripts/pr-malware-scan.cjs`, on every PR push. Flags editor/devcontainer autorun tasks, npm install hooks, typosquatted packages and Actions, non-registry dependency sources, payloads disguised as fonts/images, base64/whitespace obfuscation, exfiltration endpoints, reverse shells and miners. HIGH findings fail the `Malware scan` check, label the PR `security-review` and @mention the author; one comment per PR, updated in place. Reads the PR as data only (never checks out or runs it). Added 2026-10-20 after a VS Code autorun payload (escrow #163) and a typosquatted action (escrow #176). Manual backfill (Actions → PR malware scan → Run workflow, `prs: all`) scans PRs opened before the scanner and records a `Malware scan` commit status, which satisfies the required check.
- [ ] Choose deployment target (ARCHITECTURE.md §8 open decision) — record as an ADR. **Still not resolved.** A Render free-tier web service + Postgres now runs `backend/`, so `docforum-web`'s GitHub Pages preview has a live API to call — see `docs/adr/0003-render-preview-deployment.md`. This is explicitly a preview, not the production decision: no secrets manager, no backups, no staging/prod split, free-tier Postgres expires 2026-11-06 (renewed 2026-10-07; 30 days, 14-day grace period) unless recreated/upgraded before then — renewal steps in ADR 0003's "Renewing the free database" section. Tracked as [issue #22](https://github.com/DocForum/docforum-core/issues/22) (Medium, 150 pts).
- [x] Real CI pipeline (replaced `.github/workflows/ci.yml` placeholder — was `pull_request`-only, `echo "TODO"`, never once run). Now runs on push to `main` and on PRs: `npm audit --omit=dev` at high severity (`audit:prod`, Phase 8 issue #47) → `prisma:generate` → `typecheck` → unit tests → **integration tests (the self-contained embedded-Postgres double-booking proof)** → `build`. Verified locally end-to-end before pushing (14 unit + 1 integration test passing) and confirmed green in Actions. No lint script exists yet in `backend/package.json` — not added; `tsc --noEmit` is the closest static check currently available. Lint now tracked as [issue #28](https://github.com/DocForum/docforum-core/issues/28) (Trivial, 100 pts). Closes [issue #21](https://github.com/DocForum/docforum-core/issues/21) (Medium, 150 pts).
- [ ] Staging environment. Blocked on issue #22's decision landing first — not yet scoped into its own issue.
- [ ] Production environment + secrets management. Blocked on issue #22's decision landing first — not yet scoped into its own issue.
- [x] **Automated Postgres backups with a tested restore drill** — `scripts/backup-postgres.sh` takes an encrypted logical backup (`pg_dump --format=custom` piped through `gpg --symmetric`, so the plaintext dump never touches disk) with a retention window; `scripts/restore-drill.sh` restores the latest backup into a scratch database with explicit confirmation and name guards (the target must end in `_drill`/`_scratch` and must not be the source database), then runs integrity checks (row counts, `_prisma_migrations`, a sample booking query). `.github/workflows/backup-restore-drill.yml` runs the round-trip daily (and on demand) against a seeded throwaway Postgres service. It does not touch the Render preview database yet, because there's no production target (see the deployment decision above). Design and RPO/RTO notes are in `docs/adr/0007-postgres-backups-and-restore-drill.md` and `infra/backup/README.md`. Tracked as [issue #107](https://github.com/DocForum/docforum-core/issues/107) — **Done**.
- [x] Docs site deployed — `docs/site/` (VitePress) via `.github/workflows/deploy-docs.yml`, live at https://docforum.github.io/docforum-core/. Unrelated to the production-deploy decision above; this is a static site with no backend of its own.
- [x] **PR conflict notifier** — `.github/workflows/pr-conflict-notifier.yml` + `.github/scripts/pr-conflict-notifier.cjs`. On every push to `main` (and every 3h) it labels open PRs that conflict with `main` as `needs-rebase` and @mentions the author once per push with rebase steps; the label clears itself when the conflict is resolved. Runs from `main` only and never checks out PR code.

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
  current testnet contract.
- 2026-10-15 — Started Phase 8's auth-hardening work, scoped as issues
  #34 (email verification), #35 (login brute-force throttling), #37 (CSRF
  for the cookie-authenticated endpoints + per-environment CORS allowlist)
  and #39 (admin account lifecycle). All four are independent of Phases
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
  `main` + two commits (Phase 3 referral core, ADR 0006) with the union of
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
  is recorded as `docs/adr/0006-multiple-referrals-per-consultation.md`,
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
- 2026-10-20 — Docs site: `docs/site/scripts/sync-docs.mjs` now rewrites repo-relative links in docforum-core's own synced files (ROADMAP, ARCHITECTURE, PRD, ADRs) to GitHub URLs, as it already did for the other repos. #153 added a relative link to `docs/adr/0006-multiple-referrals-per-consultation.md` in ROADMAP.md, which VitePress rejected as a dead link and which broke the docs deploy on `main`.
- 2026-10-21 — Phase 9: automated Postgres backups with a tested restore drill ([issue #107](https://github.com/DocForum/docforum-core/issues/107)): `scripts/backup-postgres.sh` (gpg-encrypted `pg_dump`, retention), `scripts/restore-drill.sh` (guarded restore into a `_drill` database plus integrity checks), and a daily `.github/workflows/backup-restore-drill.yml`. ADR 0007. No schema or endpoint changes, so `ARCHITECTURE.md` §4 and `docs/api/README.md` are untouched.
- 2026-10-20 — Fixed the backup drill shipped above, which had never run. `backup-restore-drill.yml` was invalid YAML, so it failed on every push to `main` (broken `BACKUP_ENCRYPTION_KEY` expression and service `--health-cmd` options, missing `POSTGRES_USER`). Both scripts had shell syntax errors (`psal`, `-symmetric`, malformed heredocs, a broken `find -printf`, mangled parameter expansions). Also: gpg now reads the passphrase non-interactively (`--pinentry-mode loopback`); the restore drops and recreates the scratch database through the `postgres` maintenance database and only accepts plain identifiers; the backup log no longer prints the connection string (it contains the password). Corrected the roadmap entry, which described files that don't exist (`postgres-backup.yml`, `restore-drill.mjs`, `age`, `docs/backups.md`). Separately, `tests/integration/sessions.test.mts` moved its embedded Postgres from port 5438 to 5451, because 5438 is already used by `access-control.test.mts` and vitest runs integration files in parallel.
- 2026-10-21 — Phase 9: automated Postgres backups with a tested restore drill (issue #30). Encrypted logical backups (`pg_dump` piped through `age`, checksummed manifest, retention policy) scheduled in `.github/workflows/postgres-backup.yml`; a restore script (`scripts/restore-drill.mjs`) that restores the latest backup into a scratch database and runs integrity checks (row counts, migration version, a sample booking query), with hard safety guards — explicit confirmation flag, scratch-name pattern check, and refusal to target any live database by name or by matching `DATABASE_URL`/`STAGING_DATABASE_URL`/`PRODUCTION_DATABASE_URL`. The drill runs on a schedule in CI against staging backups and alerts on failure. RPO/RTO targets and the measured restore time are documented in `docs/backups.md`. Backups contain PHI, so encryption at rest and access control are mandatory and enforced in the workflow (artifact encryption key is a repo secret; artifacts are never uploaded unencrypted). No schema or endpoint changes, so `ARCHITECTURE.md` §4 and `docs/api/README.md` are untouched.
- 2026-10-20 — Hardened the PR automation against transient GitHub API errors. Today a single 500/503 response aborted a whole conflict-notifier run, so no PR after it got labelled. Both `pr-conflict-notifier.yml` and `pr-malware-scan.yml` now set `retries: 3` on `actions/github-script`, so 5xx responses are retried. The notifier also isolates each PR: a PR whose API calls still fail is skipped with a warning, listed as "API error, retried next run" in the run summary, and the remaining PRs are processed normally.
