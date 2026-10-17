# ARCHITECTURE_ESSENTIALS.md

Quick-reference only. Full reasoning lives in `ARCHITECTURE.md`. Full product scope in `PRD.md`. If this file and `ARCHITECTURE.md` conflict, `ARCHITECTURE.md` wins and this file is stale — fix it in the same PR.

## Stack (don't relitigate without an ADR in docs/adr/)
- Backend: Node.js + TypeScript + Express/Fastify — **modular monolith**, not microservices.
- DB: PostgreSQL via Prisma (`backend/prisma/schema.prisma` = source of truth for models).
- Auth: JWT access + refresh, roles = `patient | doctor | facility | admin`. The refresh cookie is `SameSite=None` cross-site, so `/auth/refresh` + `/auth/logout` require an `X-CSRF-Token` header (a per-session token bound into the refresh JWT) and an allowlisted `Origin` — see `backend/src/middleware/csrf.ts`. CORS is an explicit per-environment allowlist (`CORS_ORIGINS`).
- Frontend: React + TypeScript + Vite, React Query + Zustand.
- Video/voice, SMS/email, file storage: **third-party, behind an interface** — never build custom.
- Jobs: keep it simple (cron/interval) until a real job exists; don't pre-install a queue.

## Hard rules (violating these = request changes on the PR)
1. **Never mutate a `Prescription` or `LabOrder` after issuance.** Corrections = new row with `supersedes_*_id`.
2. **Availability booking must use a DB-level conditional update/transaction.** No app-level "check then write" for slot booking — that's the #1 predicted break (double-booking).
3. **A `Referral` snapshots intake + notes at creation time.** Never let it read live from the original `Consultation` — later edits must not rewrite what a specialist already saw.
4. **Cross-module access only through a module's service interface.** Never import another module's `repositories/*` directly.
5. **Facilities write to their own `FulfillmentRecord` only** — never directly to `Prescription.status` / `LabOrder.status`.
6. Every module = `routes/ controllers/ services/ repositories/`. Keep that shape.

## Data model map (see ARCHITECTURE.md §4 for full field lists)
`User` → `PatientProfile | DoctorProfile | FacilityProfile`
`DoctorProfile` —< `DoctorSpecialty` >— `Specialty`
`AvailabilitySlot` (doctor's calendar) → `Appointment` (`availability_slot_id` nullable — a cancelled appointment releases its slot; booking safety is `claimOpenSlot`, not that column) → `IntakeForm`, `Consultation`
`Consultation` → (outcome=referred) → `Referral` (snapshot! required `target_doctor_id`, self-FK lineage `parent_referral_id`, no-show/loop/admin flags) → new `Appointment`
`Referral` → `AuditEvent` (append-only, referral admin actions only so far)
`Consultation` → `Prescription`(+`PrescriptionItem`) / `LabOrder`(+`LabResult`)
`FulfillmentRecord` (facility-owned) references an order but doesn't mutate it.
`User` → `EmailVerificationToken` (Phase 8, issue #34 — hashed/expiring, single-use; `User.emailVerifiedAt` gates booking, consultation/referral mutations and payment mutations, never login/browsing).
`LoginAttempt` (Phase 8, issue #35 — Postgres-backed login throttle buckets, one per normalised email and per client IP; counters move only via a conditional upsert).
`FacilityProfile` → `WalletLink` (payout address) ; `PatientProfile`/`FacilityProfile` → `PaymentIntent` (opaque `orderType`/`orderId` — see docs/adr/0004)

## Payments (Phase 5.5 — see docs/adr/0004-custodial-payments-v1.md)
- **Custodial v1**: `docforum-core` holds its own Stellar payer + releaser identities (`PLATFORM_PAYER_SECRET`/`PLATFORM_RELEASER_SECRET` env vars). Patients never hold or sign with a wallet — the only reason this is possible without violating `docforum-web`'s "no direct Stellar calls" hard rule.
- `WalletLink` is scoped to the **facility** (the on-chain payee), not the patient.
- `PaymentIntent.orderType`/`orderId` are opaque, unvalidated — `Prescription`/`LabOrder` aren't real records yet (Phase 4). Don't build on top of these assuming they're FK-validated.
- `release`/`refund` are admin-triggered HTTP actions in v1 (`POST /payments/intents/:id/{release,refund}`) — there's no `FulfillmentRecord.status == fulfilled` to trigger off of yet. Don't treat this as the final design.
- The actual Stellar contract calls go through `@docforum/escrow-sdk` (`backend/src/modules/payments/services/escrow-sdk-loader.ts` — dynamic `import()`, the SDK is ESM-only and this backend is CommonJS). Never reimplement contract-calling logic in this repo.

## Known unresolved design gaps (do not silently "fix" without flagging in PR description)
- No routing rule yet for a referral with no specific target doctor (which specialist gets it?). **v1 re-scope (2026-10-17): `target_doctor_id` is required, so unassigned referrals can't exist — but that makes PRD §8.2.2's "waiting for a specialist" state unreachable rather than implemented. ADR still owed (issue #6).**
- No time-based expiry/TTL job for held slots or pending referrals — the referral *no-show* cascade (#67) now reaches `expired`, but nothing expires a referral (or a held slot) purely by age. Issue #8 / #19.
- `AuditEvent` exists (§4.10 of ARCHITECTURE.md) but only referral admin actions are recorded — auth, payments, booking and (later) orders mutations are still unaudited. PRD §7 is not satisfied yet.
- `Referral.snapshotIntakeId` has no column — `IntakeForm` doesn't exist yet (issue #1); the notes half of the snapshot rule is real and enforced.
- Polymorphic `FulfillmentRecord.order_id` is a sketch, not final — may need splitting into two tables.
- No email/SMS provider integrated yet (Phase 6, issue #17) — email verification (issue #34) therefore can't deliver its link on a hosted deployment; `backend/scripts/mark-email-verified.mjs` is the interim operator path.
- One doctor = one calendar assumed; multi-facility doctors not modeled.

## Overengineering guardrails (things NOT to build yet)
- No custom video/WebRTC.
- No ML-based doctor-matching/recommendation.
- No configurable RBAC matrix — 4 fixed roles only.
- No chat delivery receipts/typing indicators — plain message log.
- No custom scheduling recurrence engine — fixed-length slot generation only.
- No microservice split, no separate CI/repos per module.

## Where things live
- Backend modules: `backend/src/modules/<name>/{routes,controllers,services,repositories}`
- Data model source of truth: `backend/prisma/schema.prisma`
- Frontend: `frontend/src/{pages,components,features,hooks,services,store,types}`
- Roadmap / status: `ROADMAP.md` — **must be updated on every contribution that changes scope or completes work**.
