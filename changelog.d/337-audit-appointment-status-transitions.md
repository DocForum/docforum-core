Phase 8, issue #337: Audit appointment status transitions made by doctors and patients

The `applyScheduledTransition` function now records an `AuditEvent` inside the same transaction
as the status change, with `fromState`, `toState`, the actor who made the transition, and whether
the slot was released. This applies to doctor-completed/cancelled/no-show transitions, patient PATCH
cancel, and admin force-cancel from the referrals module.

Changes made:
- `applyScheduledTransition` now accepts `actor` and `fromState` parameters and writes an
  `appointment.status_changed` AuditEvent atomically with the conditional UPDATE.
- `updateStatusByDoctor` now takes an `actor: AuditActor` instead of `userId: string`, and
  records the transition event in the same transaction.
- `cancelByPatient` now takes an `actor: AuditActor` (required, validated for auth), and
  always records the `appointment.cancelled` AuditEvent (previously conditional on `actor` being truthy).
- `forceCancelAppointment` now takes an `actor: AuditActor` and records the admin force-cancel
  as an AuditEvent with `reason: 'admin_force_cancel'`.
- Controllers (`updateStatus`, `cancelMine`) pass `auditActor(req)` to the service layer.
- Referrals `adminCancel` passes the actor through to `forceCancelAppointment`.

This ensures every appointment status transition is attributable to a specific user, which is
critical for audit trails, particularly for disputed no-shows that can expire referrals.

Closes #337