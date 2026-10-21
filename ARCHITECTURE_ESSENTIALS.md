# ARCHITECTURE_ESSENTIALS.md

Quick-reference only. Full reasoning lives in `ARCHITECTURE.md`. Full product scope in `PRD.md`. If this file and `ARCHITECTURE.md` conflict, `ARCHITECTURE.md` wins and this file is stale — fix it in the same PR.

## Stack (don't relitigate without an ADR in docs/adr/)
- Backend: Node.js + TypeScript + Express/Fastify — **modular monolith**, not microservices.
- DB: PostgreSQL via **Prisma 7** (`backend/prisma/schema.prisma` = source of truth for models). v7 has no Rust query engine: the client is built with a driver adapter (`@prisma/adapter-pg` + node-postgres) in `backend/src/db/prisma-client.ts` — bare `new PrismaClient()` throws — and the CLI's datasource URL lives in `backend/prisma.config.ts`, not in the schema. Keep the `prisma-client-js` generator: it still writes to `node_modules/@prisma/client`, so imports and this backend's CommonJS runtime are unchanged (see `docs/adr/0006`). Requires Node >= 20.19.
- Auth: JWT access + refresh, roles = `patient | doctor | facility | admin`. The refresh cookie is `SameSite=None` cross-site, so `/auth/refresh` + `/auth/logout` require an `X-CSRF-Token` header (a per-session token bound into the refresh JWT) and an allowlisted `Origin` — see `backend/src/middleware/csrf.ts`. CORS is an explicit per-environment allowlist (`CORS_ORIGINS`).
- Frontend: React + TypeScript + Vite, React Query + Zustand.
- Video/voice, SMS/email, file storage: **third-party, behind an interface** — never build custom.
- Jobs: keep it simple (cron/interval) until a real job exists; don't pre-install a queue. Existing interval jobs: login-throttle prune (`src/server.ts`), patient-export worker/cleanup (`src/jobs/patient-exports.ts`) and deleted-account tombstone purge (`src/jobs/account-purge.ts`), all started only from `server.ts`.
- New module holding patient data? Register a patient-export section (ARCHITECTURE.md §3.1) — right of access must stay complete.

## Hard rules (violating these = request changes on the PR)
1. **Never mutate a `Prescription` or `LabOrder` after issuance.** Corrections = new row with `supersedes_*_id`.
2. **Availability booking must use a DB-level conditional update/transaction.** No app-level "check then write" for slot booking — that's the #1 predicted break (double-booking).
3. **A `Referral` snapshots intake + notes at creation time.** Never let it read live from the original `Consultation` — later edits must not rewrite what a specialist already saw.
4. **Cross-module access only through a module's service interface.** Never import another module's `repositories/*` directly.
5. **Facilities write to their own `FulfillmentRecord` only** — never directly to `Prescription.status` / `LabOrder.status`.
6. Every module = `routes/ controllers/ services/ repositories/`. Keep that shape.

## Data model map (see ARCHITECTURE.md §4 for full field lists)
`User` (including `locale`, default `en`, Phase 9 #133) → `PatientProfile | DoctorProfile | FacilityProfile`; `User` → `AdminInvite` (Phase 8, issue #39 — hashed/expiring/single-use; `User.deactivatedAt` soft-deactivates an account, refusing login/refresh/access tokens without deleting anything)
`DoctorProfile` —< `DoctorSpecialty` >— `Specialty`
`AvailabilitySlot` (doctor's calendar) → `Appointment` (`availability_slot_id` nullable — a cancelled appointment releases its slot; booking safety is `claimOpenSlot`, not that column) → `IntakeForm`, `Consultation`
`Consultation` (`appointmentId` **UNIQUE** — closing a consultation is a create-once operation, `409` on a second attempt; one writer, `consultationsService.createConsultation`, reached from `POST /consultations`, `POST /appointments/:id/consultation` and the orders flow; see docs/adr/0009) → (outcome=referred) → `Referral` (snapshot! required `target_doctor_id` — routed at creation when only a specialty is named, ADR 0008; self-FK lineage `parent_referral_id`, no-show/loop/admin flags) → new `Appointment`
`Appointment` → `Consultation` → immutable `Prescription`(+`PrescriptionItem`) / `LabOrder`(+`LabResult`)
`FulfillmentRecord` (facility-owned) references an order but doesn't mutate it.
`User` → `EmailVerificationToken` (Phase 8, issue #34 — hashed/expiring, single-use; `User.emailVerifiedAt` gates booking, consultation/referral mutations and payment mutations, never login/browsing).
`User` → `AccessLog` (Phase 8, issue #45 — PHI read-access log: who viewed which clinical record, when; fire-and-forget writes, fail-open).
`LoginAttempt` (Phase 8, issue #35 — Postgres-backed login throttle buckets, one per normalised email and per client IP; counters move only via a conditional upsert).
`PatientProfile` → `PatientExport` → `PatientExportChunk` (Phase 8, issue #40 — right-of-access export jobs + their chunked JSON bundle; each module contributes a section via its own service, registered in `src/export-sections.ts` — see ARCHITECTURE.md §3.1).
Account deletion (Phase 8, issue #41 — docs/adr/0010): anonymise in place (`User.deletedAt`, `PatientProfile.anonymizedAt`), never cascade. `PatientProfile.userId` is ON DELETE RESTRICT; new patient-linked clinical tables must be RESTRICT too **and** register a retention hold in `src/retention-holds.ts`.
`FacilityProfile` → `WalletLink` (payout address) ; `Prescription` or `LabOrder` → exactly one typed `PaymentIntent` FK (issue #85)

## Payments (Phase 5.5 — see docs/adr/0004-custodial-payments-v1.md)
- **Custodial v1**: `docforum-core` holds its own Stellar payer + releaser identities (`PLATFORM_PAYER_SECRET`/`PLATFORM_RELEASER_SECRET` env vars). Patients never hold or sign with a wallet — the only reason this is possible without violating `docforum-web`'s "no direct Stellar calls" hard rule.
- `WalletLink` is scoped to the **facility** (the on-chain payee), not the patient.
- Each issued order stores its selected facility and clinician-entered total in XLM stroops; a database check requires exactly one PaymentIntent order FK.
- `release`/`refund` are admin-triggered HTTP actions in v1 (`POST /payments/intents/:id/{release,refund}`) — there's no `FulfillmentRecord.status == fulfilled` to trigger off of yet. Don't treat this as the final design.
- The actual Stellar contract calls go through `@docforum/escrow-sdk` (`backend/src/modules/payments/services/escrow-sdk-loader.ts` — dynamic `import()`, the SDK is ESM-only and this backend is CommonJS). Never reimplement contract-calling logic in this repo.

## Known unresolved design gaps (do not silently "fix" without flagging in PR description)
- ~~No routing rule for a referral with no specific target doctor~~ **Resolved (issue #6, `docs/adr/0008-referral-routing-without-target-doctor.md`):** a specialty-only referral is routed **at creation** to the least-loaded eligible doctor (verified, holds the specialty, not the referring doctor, account not deactivated; fewest `pending`+`accepted` referrals, ties broken by doctor id). `target_doctor_id` stays NOT NULL — zero eligible doctors fails the creation with `422 REFERRAL_NO_ELIGIBLE_TARGET` and writes no row. PRD §8.2.2's "waiting for a specialist" state is still not built (deferred on purpose: it needs a nullable target, which this ADR rejects).
- No time-based expiry/TTL job for held slots or pending referrals — the referral *no-show* cascade (#67) now reaches `expired`, but nothing expires a referral (or a held slot) purely by age. Issue #8 / #19.
- `AuditEvent` exists (§4.10 of ARCHITECTURE.md) and records booking (both booking paths), doctor verification, payment fund/release/refund, the patient's referral accept/decline and the referral admin actions — auth (the admin login-throttle clear), the referral's creation + cascade transitions, and the remaining Phase 4 order transitions are still unaudited. PRD §7 is not satisfied yet.
- `Referral.snapshotIntakeId` has no column — `IntakeForm` doesn't exist yet (issue #1); the notes half of the snapshot rule is real and enforced.
- Polymorphic `FulfillmentRecord.order_id` is a sketch, not final — may need splitting into two tables.
- `AuditEvent` foundation exists (Phase 8, issue #43 — ARCHITECTURE.md §4.10): append-only (DB triggers), written by `auditService.record(tx, …)` **inside the same transaction** as the change. Wired for booking (direct and referral-origin), doctor verification, payment fund/release/refund, referral accept/decline and referral admin actions (`entity_type: 'Referral'`) — **Phase 4 transitions must call it when they're built.** There is one audit table: referral actions go into it, not into a second one. Never put PHI in `metadata`.
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


## Escrow event monitoring (issue #86)
- EscrowEventCursor stores one pagination cursor per contract deployment; configure each historical deployment as ESCROW_CONTRACTS=CONTRACT_ID@START_LEDGER,...
- EscrowChainEvent stores deduplicated Soroban events. The admin endpoint is GET /admin/payments/escrow-events.
- Unmatched release/refund events are high-severity alerts; RPC retention loss is surfaced as catchupError and must be reconciled explicitly.
