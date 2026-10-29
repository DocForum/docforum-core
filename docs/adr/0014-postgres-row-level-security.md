# ADR 0014: PostgreSQL row-level security for patient-scoped reads

- **Status:** Accepted
- **Date:** 2026-10-24
- **Issue:** [#116](https://github.com/DocForum/docforum-core/issues/116)

## Context

Application-level ownership filters are easy to omit in a future query. PostgreSQL row-level security (RLS) adds a second check for patient reads. The backend uses a pooled Prisma/PostgreSQL connection, so request identity must be transaction-local and must not persist when a connection returns to the pool.

## Decision

The first protected tables are `Appointment`, `PaymentIntent`, and `Consultation`. Appointment and PaymentIntent ownership comes from their existing `patientProfileId`; Consultation ownership is derived through its appointment. No model fields or endpoints are added. `IntakeForm` remains out of scope because its current placeholder has neither a patient relation nor an appointment relation from which ownership can be established.

The Prisma client extension sets `app.current_user_id` and `app.current_role` using `set_config(..., true)` in the same database transaction as each protected operation. It first switches the transaction to `docforum_app`, a non-login, non-bypass role, so a privileged or table-owner connection cannot silently skip the policies. Authenticated interactive transactions set the context once at transaction start, so booking's slot claim and appointment insert remain in their existing atomic transaction. An unauthenticated request receives the `anonymous` role context and cannot see patient rows. Patient policies permit only the owner or an active guardian; doctor, facility, and admin application roles retain existing service-authorized access.

The migration creates the `NOLOGIN BYPASSRLS` role `docforum_rls_bypass` for trusted maintenance operations and grants membership to the migration connection role. It is not selected by request handlers. RLS is forced on the protected tables so table ownership alone does not silently disable policy checks. Migrations continue to run as the configured migration connection role.

## Consequences

- Existing ownership checks remain in application services; RLS is additional protection, not a replacement for authorization or module boundaries.
- A future patient-owned table must receive an RLS policy in the same migration that makes its ownership relationship enforceable.
- A future patient-owned intake model must first establish a real patient ownership relation; no field is invented for the current placeholder.
- Direct protected queries add a short transaction for context setup. Queries inside existing interactive transactions reuse that transaction and set context once. The booking integration test exercises both context isolation and the existing concurrency guarantee; timing is recorded during verification because laptop and CI database timings vary.
- Trusted jobs that query protected tables must explicitly use `withRlsBypass`; request code must not call it.

## Alternatives considered

- Session-level `SET` was rejected because pooled connections can carry one request's identity into another request.
- Application filters alone do not protect a future query that accidentally omits its ownership predicate.
- Adding ownership columns to the current `IntakeForm` placeholder was rejected because it would invent schema beyond issue #116 and PRD/architecture scope.
