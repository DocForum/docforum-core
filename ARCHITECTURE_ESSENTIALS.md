# ARCHITECTURE_ESSENTIALS.md

Quick-reference only. Full reasoning lives in `ARCHITECTURE.md`. Full product scope in `PRD.md`. If this file and `ARCHITECTURE.md` conflict, `ARCHITECTURE.md` wins and this file is stale — fix it in the same PR.

## Stack (don't relitigate without an ADR in docs/adr/)
- Backend: Node.js + TypeScript + Express/Fastify — **modular monolith**, not microservices.
- DB: PostgreSQL via **Prisma 7** (`backend/prisma/schema.prisma` = source of truth for models). v7 has no Rust query engine: the client is built with a driver adapter (`@prisma/adapter-pg` + node-postgres) in `backend/src/db/prisma-client.ts` — bare `new PrismaClient()` throws — and the CLI's datasource URL lives in `backend/prisma.config.ts`, not in the schema. Keep the `prisma-client-js` generator: it still writes to `node_modules/@prisma/client`, so imports and this backend's CommonJS runtime are unchanged (see `docs/adr/0006`). Requires Node >= 20.19.
- Auth: JWT access + refresh, roles = `patient | doctor | facility | admin`. The refresh cookie is `SameSite=None` cross-site, so `/auth/refresh` + `/auth/logout` require an `X-CSRF-Token` header (a per-session token bound into the refresh JWT) and an allowlisted `Origin` — see `backend/src/middleware/csrf.ts`. CORS is an explicit per-environment allowlist (`CORS_ORIGINS`).
- Frontend: React + TypeScript + Vite, React Query + Zustand.
- Video/voice, SMS/email, file storage: **third-party, behind an interface** — never build custom.
- Jobs: keep it simple (cron/interval) until a real job exists; don't pre-install a queue. Existing interval jobs: login-throttle prune (`src/server.ts`) and patient-export worker/cleanup (`src/jobs/patient-exports.ts`), both started only from `server.ts`.
- New module holding patient data? Register a patient-export section (ARCHITECTURE.md §3.1) — right of access must stay complete.

## Hard rules (violating these = request changes on the PR)
1. **Never mutate a `Prescription` or `LabOrder` after issuance.** Corrections = new row with `supersedes_*_id`.
2. **Availability booking must use a DB-level conditional update/transaction.** No app-level "check then write" for slot booking — that's the #1 predicted break (double-booking).
3. **A `Referral` snapshots intake + notes at creation time.** Never let it read live from the original `Consultation` — later edits must not rewrite what a specialist already saw.
4. **Cross-module access only through a module's service interface.** Never import another module's `repositories/*` directly.
5. **Facilities write to their own `FulfillmentRecord` only** — never directly to `Prescription.status` / `LabOrder.status`.
6. Every module = `routes/ controllers/ services/ repositories/`. Keep that shape.

## Data model map (see ARCHITECTURE.md §4 for full field lists)
`User` → `PatientProfile | DoctorProfile | FacilityProfile`; `User` → `AdminInvite` (Phase 8, issue #39 — hashed/expiring/single-use; `User.deactivatedAt` soft-deactivates an account, refusing login/refresh/access tokens without deleting anything)
`DoctorProfile` —< `DoctorSpecialty` >— `Specialty`
`AvailabilitySlot` (doctor's calendar) → `Appointment` → `IntakeForm`, `Consultation`
`Consultation` → (outcome=referred) → `Referral` (snapshot!) → new `Appointment`
`Consultation` → `Prescription`(+`PrescriptionItem`) / `LabOrder`(+`LabResult`)
`FulfillmentRecord` (facility-owned) references an order but doesn't mutate it.
`User` → `EmailVerificationToken` (Phase 8, issue #34 — hashed/expiring, single-use; `User.emailVerifiedAt` gates booking + payment mutations, never login/browsing).
`LoginAttempt` (Phase 8, issue #35 — Postgres-backed login throttle buckets, one per normalised email and per client IP; counters move only via a conditional upsert).
`PatientProfile` → `PatientExport` → `PatientExportChunk` (Phase 8, issue #40 — right-of-access export jobs + their chunked JSON bundle; each module contributes a section via its own service, registered in `src/export-sections.ts` — see ARCHITECTURE.md §3.1).
`FacilityProfile` → `WalletLink` (payout address) ; `PatientProfile`/`FacilityProfile` → `PaymentIntent` (opaque `orderType`/`orderId` — see docs/adr/0004)
`FacilityMember` (new — Phase 5, issue #75): user belongs to at most one facility (unique constraint on userId); role enum owner|staff; fixed roles, no RBAC matrix
`FacilityInvite` (new — Phase 5, issue #75): owner can create/list/revoke single-use, expiring invites; token hash stored, never plaintext

## Payments (Phase 5.5 — see docs/adr/0004-custodial-payments-v1.md)
- **Custodial v1**: `docforum-core` holds its own Stellar payer + releaser identities (`PLATFORM_PAYER_SECRET`/`PLATFORM_RELEASER_SECRET` env vars). Patients never hold or sign with a wallet — the only reason this is possible without violating `docforum-web`'s "no direct Stellar calls" hard rule.
- `WalletLink` is scoped to the **facility** (the on-chain payee), not the patient.
- `PaymentIntent.orderType`/`orderId` are opaque, unvalidated — `Prescription`/`LabOrder` aren't real records yet (Phase 4). Don't build on top of these assuming they're FK-validated.
- `release`/`refund` are admin-triggered HTTP actions in v1 (`POST /payments/intents/:id/{release,refund}`) — there's no `FulfillmentRecord.status == fulfilled` to trigger off of yet. Don't treat this as the final design.
- The actual Stellar contract calls go through `@docforum/escrow-sdk` (`backend/src/modules/payments/services/escrow-sdk-loader.ts` — dynamic `import()`, the SDK is ESM-only and this backend is CommonJS). Never reimplement contract-calling logic in this repo.

## Known unresolved design gaps (do not silently "fix" without flagging in PR description)
- No routing rule yet for a referral with no specific target doctor (which specialist gets it?).
- No expiry/TTL job for held slots or pending referrals — currently just an enum value with no worker.
- Polymorphic `FulfillmentRecord.order_id` is a sketch, not final — may need splitting into two tables.
- `AuditEvent` foundation exists (Phase 8, issue #43 — ARCHITECTURE.md §4.10): append-only (DB triggers), written by `auditService.record(tx, …)` **inside the same transaction** as the change. Wired for booking, doctor verification and payment fund/release/refund only — **Phase 3/4 transitions must call it when they're built.** Never put PHI in `metadata`.
- No email/SMS provider integrated yet (Phase 6, issue #17) — email verification (issue #34) therefore can't deliver its link on a hosted deployment; `backend/scripts/mark-email-verified.mjs` is the interim operator path.
- One doctor = one calendar assumed; multi-facility doctors not modeled.

## Overengineering guardrails (things NOT to build yet)
- No custom video/WebRTC.
- No ML-based doctor-matching/recommendation.
- No configurable RBAC matrix — 4 fixed roles for User/Doctor (patient|doctor|facility|admin), and 2 fixed roles for FacilityMember (owner|staff).
- No chat delivery receipts/typing indicators — plain message log.
- No custom scheduling recurrence engine — fixed-length slot generation only.
- No microservice split, no separate CI/repos per module.

## Where things live
- Backend modules: `backend/src/modules/<name>/{routes,controllers,services,repositories}`
- Data model source of truth: `backend/prisma/schema.prisma`
- Frontend: `frontend/src/{pages,components,features,hooks,services,store,types}`
- Roadmap / status: `ROADMAP.md` — **must be updated on every contribution that changes scope or completes work**.
