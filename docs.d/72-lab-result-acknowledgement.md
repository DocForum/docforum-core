---
file: ARCHITECTURE.md
section: 4.6 Lab orders (versioned, append-only)
---

Issue #72 adds the acknowledgement side of a result. `LabResult.abnormality`
is `normal | abnormal | critical`, set by the fulfilling facility at attach
time; it is not editable afterwards (the result is create-once, §4.6). An
`abnormal` or `critical` result also creates exactly one
`LabResultAcknowledgement` in the same transaction:

```
LabResultAcknowledgement
  id, lab_result_id (FK, unique), ordering_doctor_id (FK to DoctorProfile)
  severity (enum: abnormal|critical)
  escalation_due_at (fixed at attach: created_at + LAB_RESULT_ESCALATION_HOURS)
  acknowledged_at, acknowledged_by_doctor_id (one-shot conditional write)
  escalated_at (one-shot conditional write by the sweep job)
  created_at

  @@index([acknowledged_at, escalation_due_at])   # admin escalation queue
  @@index([ordering_doctor_id, acknowledged_at])  # doctor's list
```

Both writes are conditional (`acknowledged_at IS NULL`, and for escalation
`acknowledged_at IS NULL AND escalated_at IS NULL`), so a repeat acknowledge
is a `409`, an acknowledgement that wins the race is never escalated, and two
job runners cannot double-escalate. Each write records an `AuditEvent`
(`lab_result.acknowledged` / `lab_result.escalated`) in the same transaction;
the acknowledgement table is not a second audit trail. `escalation_due_at` is
stored rather than derived, so changing the env var never moves an existing
deadline, and the admin queue computes `overdue` from it rather than relying
on the job having run. `normal` results have no row at all.
