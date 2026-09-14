# ROADMAP.md — DocForum

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
**Status: Built and tested. One item (Docker Compose) written but not verified running — see note.**
**Why first:** everything else depends on real users existing and on the booking concurrency guarantee (ARCHITECTURE.md §5.1) being real, not aspirational.

- [x] Flesh out `User`, `PatientProfile`, `DoctorProfile`, `FacilityProfile`, `Specialty`, `DoctorSpecialty`, `FacilityCapability` in `schema.prisma` with real fields/relations. Migrated: `backend/prisma/migrations/20260914110638_init/`.
- [ ] Local dev DB via Docker Compose (`infra/docker`) — **file written, not exercised.** No Docker in the environment this was built in, so the backend was developed and tested against a locally-installed Postgres (via the `embedded-postgres` devDependency — a prebuilt binary, not compiled) instead. The compose file matches `backend/.env.example`'s credentials but hasn't itself been run. See `infra/docker/README.md`.
- [x] Auth module: signup/login, JWT access+refresh, role middleware. `POST /auth/signup` rejects `role: 'facility'`/`'admin'` server-side (PRD OQ-2), not just in docforum-web's UI. Refresh token travels as an httpOnly cookie — see `docs/api/README.md` for the local-dev-only cookie caveat (cross-origin `sameSite`/`secure` not verified end-to-end).
- [x] Doctor verification status workflow (admin-gated, manual in v1 per PRD §6.1 FR-3). `PATCH /doctors/:id/verification`, admin-only.
- [x] `AvailabilitySlot` model finalized **with the DB-level constraint/transaction strategy** that prevents double-booking (ARCHITECTURE.md §5.1 / §6.1.1 — this is the single highest-priority correctness item in the whole roadmap). **Resolved, not just implemented** — see the integration test below.
- [x] Basic slot generation for a doctor (fixed-length, no recurrence engine — ARCHITECTURE.md §6.3.6). `POST /availability/doctors/:id/slots/generate`, idempotent re-runs.
- [x] Integration test: two concurrent booking attempts on the same slot — exactly one must succeed. `backend/tests/integration/booking.test.mts` — 8 genuinely concurrent requests via `Promise.all`, self-contained (spins up its own throwaway Postgres, no pre-existing DB needed), passing. Also manually verified end-to-end via a full curl walkthrough (signup → generate slots → book → second booking attempt correctly gets `409`).
- [x] Doc reconciliation: PRD §8.1.1 and ARCHITECTURE §6.1.1 marked resolved in place.

## Phase 2 — Intake, appointments, consultations
**Status: Not started (blocked by Phase 1). Scoped into issues #1–#4.**
- [ ] `IntakeForm` model + structured symptom entry (not free-text-only, per PRD FR-5). Tracked as [issue #1](https://github.com/DocForum/docforum-core/issues/1) (Medium, 150 pts).
- [ ] Booking flow requires intake before confirmation. Tracked as [issue #2](https://github.com/DocForum/docforum-core/issues/2) (Medium, 150 pts) — depends on #1.
- [ ] `Appointment` lifecycle (`scheduled → completed/cancelled/no_show`) + doctor's today view. Tracked as [issue #3](https://github.com/DocForum/docforum-core/issues/3) (Medium, 150 pts).
- [ ] `Consultation` record + outcome (`resolved | referred | follow_up_needed`). Tracked as [issue #4](https://github.com/DocForum/docforum-core/issues/4) (High, 200 pts).
- [ ] Patient-facing view: my intake history. Not yet split into its own issue — small enough to fold into whichever of the above lands last, or split out later if it grows.

## Phase 3 — Referrals
**Status: Not started (blocked by Phase 2). Scoped into issues #5–#8.**
- [ ] `Referral` model with **immutable snapshot** of intake + notes (ARCHITECTURE.md §4.4 design note — do not implement as a live pointer), plus the "zero verified doctors in target specialty" edge case (PRD §8.2.2). Tracked as [issue #5](https://github.com/DocForum/docforum-core/issues/5) (Medium, 150 pts).
- [ ] Referral creation from a `Consultation` with outcome `referred` — folded into issue #5 above.
- [ ] Routing rule for referrals with no specific `target_doctor_id` (ARCHITECTURE.md §6.1.2 — currently an unresolved design gap; this phase must resolve or explicitly re-scope it). Tracked as [issue #6](https://github.com/DocForum/docforum-core/issues/6) (High, 200 pts) — an ADR.
- [ ] Patient accept/decline flow (PRD OQ-3 resolved: patient must confirm). Tracked as [issue #7](https://github.com/DocForum/docforum-core/issues/7) (Medium, 150 pts) — depends on #5.
- [ ] Accepted referral auto-generates a pre-populated `Appointment` against the target doctor/specialty — patient does not re-enter intake (PRD FR-8, the core value prop) — folded into issue #7 above.
- [ ] Referral expiry job (addresses PRD §8.1.3 "orphaned" pattern for referrals specifically). Tracked as [issue #8](https://github.com/DocForum/docforum-core/issues/8) (Medium, 150 pts) — depends on #5.
- [ ] Doc reconciliation: update ARCHITECTURE_ESSENTIALS.md "Known unresolved design gaps" once routing rule + expiry exist — part of issue #6's DoD.

## Phase 4 — Orders: prescriptions & lab orders
**Status: Not started (blocked by Phase 2, informed by Phase 3). Scoped into issues #9–#12.**
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

## Phase 5.5 — Payments (consumer side, depends on docforum-escrow existing)
**Status: Not started (blocked by Phase 5, and by `docforum-escrow` publishing an initial `@docforum/escrow-sdk` release)**
- [ ] `PaymentIntent` + `WalletLink` models finalized (relational metadata only — see schema.prisma comment, no PHI).
- [ ] Add `@docforum/escrow-sdk` as a dependency; wire `payments/services` to call it.
- [ ] On order issuance, create a `PaymentIntent` (`created` status).
- [ ] On patient funding action, call SDK to move funds into escrow (`escrowed` status), store `stellarTxHash`.
- [ ] On `FulfillmentRecord` reaching `fulfilled`, trigger SDK release call (`released` status) — this is the actual payoff of ADR 0002, don't let it drift into a manual/admin-triggered release.
- [ ] Refund path for rejected/expired orders.
- [ ] Doc reconciliation: this phase directly addresses PRD §8.1.6 (facility fulfillment integrity) — mark resolved if it lands.

## Phase 5.5 — Payments (consumer side, depends on docforum-escrow existing)
**Status: Not started (blocked by Phase 5, and by `docforum-escrow` publishing an initial `@docforum/escrow-sdk` release — tracked as `docforum-escrow` issues #4/#5, both still open). Deliberately left unscoped into issues here** — opening issues for work that can't start until a sibling repo ships its SDK would stall a contributor through no fault of their own (see `WAVE_ISSUE_TEMPLATE.md` "Notes to self"). Revisit once `docforum-escrow` #4/#5 close.
- [ ] `PaymentIntent` + `WalletLink` models finalized (relational metadata only — see schema.prisma comment, no PHI).
- [ ] Add `@docforum/escrow-sdk` as a dependency; wire `payments/services` to call it.
- [ ] On order issuance, create a `PaymentIntent` (`created` status).
- [ ] On patient funding action, call SDK to move funds into escrow (`escrowed` status), store `stellarTxHash`.
- [ ] On `FulfillmentRecord` reaching `fulfilled`, trigger SDK release call (`released` status) — this is the actual payoff of ADR 0002, don't let it drift into a manual/admin-triggered release.
- [ ] Refund path for rejected/expired orders.
- [ ] Doc reconciliation: this phase directly addresses PRD §8.1.6 (facility fulfillment integrity) — mark resolved if it lands.

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
**Status: Not started. Three of five items scoped into issues #18–#20 (independent of Phases 3–7); the other two remain blocked.**
- [ ] `AuditEvent` table + write path for referral/prescription/lab-order state transitions (ARCHITECTURE.md §6.2.4 — flagged as needed before real patient data). Still blocked — needs the Phase 3/4 models (referral, prescription, lab order) to exist first. Not yet scoped into an issue.
- [ ] JWT refresh revocation list (ARCHITECTURE.md §6.1.4). Tracked as [issue #18](https://github.com/DocForum/docforum-core/issues/18) (Medium, 150 pts) — unblocked now, operates on Phase 1's auth module.
- [ ] Held-slot TTL/release job (ARCHITECTURE.md §6.2.1). Tracked as [issue #19](https://github.com/DocForum/docforum-core/issues/19) (Medium, 150 pts) — unblocked now, operates on Phase 1's `AvailabilitySlot`.
- [ ] Privacy access-control audit: confirm intake/consultation notes are visible only per PRD §7 (patient, treating doctor(s) in-thread, fulfilling facility for that specific order only) — write tests, not just code review. Still blocked — meaningfully auditable only once Phase 3/4/5 access paths exist. Not yet scoped into an issue.
- [ ] Decide and document what's explicitly out of scope for v1 launch vs. genuinely blocking (e.g., drug-interaction checking, PRD §8.2.8 — needs an explicit go/no-go, not silence). Tracked as [issue #20](https://github.com/DocForum/docforum-core/issues/20) (Trivial, 100 pts) — a decision task, unblocked now.

## Phase 9 — Deploy & CI
**Status: Not started for real production. A Render free-tier preview exists — see note. Remaining items scoped into issues #21–#22.**
- [ ] Choose deployment target (ARCHITECTURE.md §8 open decision) — record as an ADR. **Still not resolved.** A Render free-tier web service + Postgres now runs `backend/`, so `docforum-web`'s GitHub Pages preview has a live API to call — see `docs/adr/0003-render-preview-deployment.md`. This is explicitly a preview, not the production decision: no secrets manager, no backups, no staging/prod split, free-tier Postgres expires 2026-10-14 (30 days, 14-day grace period) unless recreated/upgraded before then. Tracked as [issue #22](https://github.com/DocForum/docforum-core/issues/22) (Medium, 150 pts).
- [x] Real CI pipeline (replaced `.github/workflows/ci.yml` placeholder — was `pull_request`-only, `echo "TODO"`, never once run). Now runs on push to `main` and on PRs: `prisma:generate` → `typecheck` → unit tests → **integration tests (the self-contained embedded-Postgres double-booking proof)** → `build`. Verified locally end-to-end before pushing (14 unit + 1 integration test passing) and confirmed green in Actions. No lint script exists yet in `backend/package.json` — not added; `tsc --noEmit` is the closest static check currently available. Closes [issue #21](https://github.com/DocForum/docforum-core/issues/21) (Medium, 150 pts).
- [ ] Staging environment. Blocked on issue #22's decision landing first — not yet scoped into its own issue.
- [ ] Production environment + secrets management. Blocked on issue #22's decision landing first — not yet scoped into its own issue.
- [x] Docs site deployed — `docs/site/` (VitePress) via `.github/workflows/deploy-docs.yml`, live at https://docforum.github.io/docforum-core/. Unrelated to the production-deploy decision above; this is a static site with no backend of its own.

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
  accepted.
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
