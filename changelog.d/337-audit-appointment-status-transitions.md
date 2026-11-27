Phase 8: every appointment status transition is audited
([issue #337](https://github.com/DocForum/docforum-core/issues/337)).
`applyScheduledTransition` writes exactly one AuditEvent in the same
transaction as the status change, with the actor, from/to states, the slot
and whether it was released: `appointment.cancelled` for cancellations (the
action patient cancels already used, so it is not written twice) and
`appointment.status_changed` for completed / no-show. `updateStatusByDoctor`
and `cancelByPatient` take an `AuditActor`; the referrals module's admin
cancel passes its actor to `forceCancelAppointment`, which records
`reason: 'admin_force_cancel'`. Covered in
`appointment-cancel-day-and-audit.test.mts`.
