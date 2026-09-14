# ARCHITECTURE_ESSENTIALS.md

Quick-reference only. Full reasoning lives in `ARCHITECTURE.md`. Full product scope in `PRD.md`. If this file and `ARCHITECTURE.md` conflict, `ARCHITECTURE.md` wins and this file is stale — fix it in the same PR.

## Repos (see ADR 0001)
- `docforum-core` — backend modular monolith, owns Postgres/all PHI.
- `docforum-web` — frontend, talks only to `docforum-core`'s API.
- `docforum-escrow` — Rust Soroban escrow contract + TS SDK, generic/no-PHI. Consumed only by `docforum-core`'s `payments` module.

## Stack (don't relitigate without an ADR in docs/adr/)
- Backend (`docforum-core`): Node.js + TypeScript + Express/Fastify — **modular monolith**, not microservices.
- DB: PostgreSQL via Prisma (`backend/prisma/schema.prisma` = source of truth for models).
- Auth: JWT access + refresh, roles = `patient | doctor | facility | admin`.
- Frontend (`docforum-web`): React + TypeScript + Vite, React Query + Zustand.
- Payment escrow (`docforum-escrow`): Rust Soroban smart contract + TS client SDK — separate repo/runtime, not part of the monolith (ADR 0001).
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
`AvailabilitySlot` (doctor's calendar) → `Appointment` → `IntakeForm`, `Consultation`
`Consultation` → (outcome=referred) → `Referral` (snapshot!) → new `Appointment`
`Consultation` → `Prescription`(+`PrescriptionItem`) / `LabOrder`(+`LabResult`)
`FulfillmentRecord` (facility-owned) references an order but doesn't mutate it.

## Known unresolved design gaps (do not silently "fix" without flagging in PR description)
- No routing rule yet for a referral with no specific target doctor (which specialist gets it?).
- No expiry/TTL job for held slots or pending referrals — currently just an enum value with no worker.
- Polymorphic `FulfillmentRecord.order_id` is a sketch, not final — may need splitting into two tables.
- No `AuditEvent` table yet, despite PRD requiring auditability — needed before real patient data.
- One doctor = one calendar assumed; multi-facility doctors not modeled.

## Overengineering guardrails (things NOT to build yet)
- No custom video/WebRTC.
- No ML-based doctor-matching/recommendation.
- No configurable RBAC matrix — 4 fixed roles only.
- No chat delivery receipts/typing indicators — plain message log.
- No custom scheduling recurrence engine — fixed-length slot generation only.
- No microservice split, no separate CI/repos **per backend module** — the three-repo split (core/web/escrow, ADR 0001) is org-level, not a module-by-module split.

## Where things live
- Backend modules (in `docforum-core`): `backend/src/modules/<name>/{routes,controllers,services,repositories}`
- Data model source of truth (in `docforum-core`): `backend/prisma/schema.prisma`
- Frontend (in `docforum-web`): `frontend/src/{pages,components,features,hooks,services,store,types}`
- Escrow contract + SDK: `docforum-escrow` (separate repo, Rust + TS)
- Roadmap / status: `ROADMAP.md` — **must be updated on every contribution that changes scope or completes work**.
